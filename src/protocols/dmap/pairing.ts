/** Module used for pairing pyatv with a device. */

import { createHash, randomBytes } from "node:crypto";
import type { Core } from "../../core/index.ts";
import * as mdns from "../../core/mdns.ts";
import { PairingHandler } from "../../interface.ts";
import { ipToInt } from "../../support/ip.ts";
import { getLogger } from "../../support/logging.ts";
import { getPrivateAddresses, unusedPort } from "../../support/net.ts";
import { Zeroconf, type ZeroconfLike } from "../../support/zeroconf.ts";
import * as tags from "./tags.ts";

const LOGGER = getLogger("pyatv.protocols.dmap.pairing");

/** Hooks replaceable in tests. */
export const pairingHooks = {
  getrandbits: (bits: number): bigint => {
    const bytes = randomBytes(Math.ceil(bits / 8));
    return BigInt("0x" + bytes.toString("hex")) & ((1n << BigInt(bits)) - 1n);
  },
};

function generateRandomGuid(): string {
  return "0x" + pairingHooks.getrandbits(64).toString(16).toUpperCase();
}

export interface DmapPairingOptions {
  zeroconf?: ZeroconfLike | null;
  name?: string;
  pairingGuid?: string | null;
  addresses?: string[] | null;
}

/**
 * Handle the pairing process.
 *
 * This class will publish a bonjour service and configure a webserver that responds to
 * pairing requests.
 */
export class DmapPairingHandler extends PairingHandler {
  private readonly _core: Core;
  private readonly _zeroconf: ZeroconfLike;
  private readonly _name: string;
  private _server: ReturnType<typeof Bun.serve> | null = null;
  private _pinCode: number | null = null;
  private _hasPaired = false;
  private readonly _pairingGuid: string;
  private readonly _addresses: string[];

  constructor(core: Core, options: DmapPairingOptions = {}) {
    super(core.sessionManager, core.service);
    this._core = core;
    this._zeroconf = options.zeroconf ?? new Zeroconf();
    this._name = options.name ?? core.settings.info.name;
    this._pairingGuid = (options.pairingGuid || generateRandomGuid()).slice(2).toUpperCase();
    this._addresses = options.addresses ?? getPrivateAddresses(false);
  }

  /** Call to free allocated resources after pairing. */
  override async close(): Promise<void> {
    this._zeroconf.close();
    this._server?.stop(true);
    this._server = null;
    await super.close();
  }

  /** If a successful pairing has been performed. */
  get hasPaired(): boolean {
    return this._hasPaired;
  }

  /** Start the pairing server and publish service. */
  async begin(): Promise<void> {
    const port = unusedPort();
    this._server = Bun.serve({
      hostname: "0.0.0.0",
      port,
      fetch: (req) => this.handleRequest(req),
    });
    LOGGER.debug("Started pairing web server at port %d", port);

    for (const ipaddr of this._addresses) {
      await this._publishService(ipaddr, port);
    }
  }

  /** Stop pairing server and unpublish service. */
  async finish(): Promise<void> {
    if (this._hasPaired) {
      LOGGER.debug("Saving updated credentials");
      this.service.credentials = "0x" + this._pairingGuid;
      this._core.settings.protocols.dmap.credentials = this.service.credentials;
    }
  }

  /** Pin code used for pairing. */
  pin(pin: number | string): void {
    this._pinCode = typeof pin === "string" ? parseInt(pin, 10) : pin;
    LOGGER.debug("DMAP PIN changed to %s", this._pinCode);
  }

  /** Return True if remote device presents PIN code, else False. */
  get deviceProvidesPin(): boolean {
    return false;
  }

  private async _publishService(address: string, port: number): Promise<void> {
    const props = {
      DvNm: this._name,
      RemV: "10000",
      DvTy: "iPod",
      RemN: "Remote",
      txtvers: "1",
      Pair: this._pairingGuid,
    };

    await mdns.publish(
      {
        type: "_touch-remote._tcp.local",
        name: String(ipToInt(address)).padStart(40, "0"),
        address,
        port,
        properties: props,
      },
      this._zeroconf,
    );
  }

  /** Respond to request if PIN is correct. */
  handleRequest(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname !== "/pair") return new Response("Not found", { status: 404 });
    const serviceName = url.searchParams.get("servicename");
    const receivedCode = (url.searchParams.get("pairingcode") ?? "").toLowerCase();
    LOGGER.info("Got pairing request from %s with code %s", serviceName, receivedCode);

    if (this._verifyPin(receivedCode)) {
      const cmpg = tags.uint64Tag("cmpg", BigInt("0x" + this._pairingGuid));
      const cmnm = tags.stringTag("cmnm", this._name);
      const cmty = tags.stringTag("cmty", "iPhone");
      const response = tags.containerTag("cmpa", Buffer.concat([cmpg, cmnm, cmty]));
      this._hasPaired = true;
      return new Response(response);
    }

    // Code did not match, generate an error
    return new Response(null, { status: 500 });
  }

  private _verifyPin(receivedCode: string): boolean {
    // If no particular pin code is specified, allow any pin
    if (this._pinCode === null) return true;

    let merged = this._pairingGuid;
    for (const char of String(this._pinCode).padStart(4, "0")) merged += char + "\x00";

    const expectedCode = createHash("md5").update(merged, "utf-8").digest("hex");
    LOGGER.debug("Got code %s, expects %s", receivedCode, expectedCode);
    return receivedCode === expectedCode;
  }
}
