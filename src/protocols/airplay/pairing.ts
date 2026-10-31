/** Device pairing and derivation of encryption keys. */

import { AuthenticationType, type PairSetupProcedure } from "../../auth/hap_pairing.ts";
import { Protocol } from "../../const.ts";
import type { Core } from "../../core/index.ts";
import { PairingError } from "../../exceptions.ts";
import { PairingHandler } from "../../interface.ts";
import type { Settings } from "../../settings.ts";
import { type HttpConnection, httpConnect } from "../../support/http.ts";
import { errorHandler } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { pairSetup } from "./auth/index.ts";
import { AirPlayMajorVersion } from "./utils.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.pairing");

/** Pairing handler for AirPlay (and RAOP). */
export class AirPlayPairingHandler extends PairingHandler {
  private readonly _name: string;
  http: HttpConnection | null = null;
  readonly address: string;
  pairingProcedure: PairSetupProcedure | null = null;
  pinCode: string | null = null;
  private _hasPaired = false;
  private readonly _settings: Settings;

  constructor(
    core: Core,
    readonly airplayVersion: AirPlayMajorVersion,
    options: Record<string, unknown> = {},
  ) {
    super(core.sessionManager, core.service);
    this._name = (options.name as string) ?? core.settings.info.name;
    this.address = core.config.address;
    this._settings = core.settings;
  }

  get hasPaired(): boolean {
    return this._hasPaired;
  }

  override async close(): Promise<void> {
    await super.close();
    this.http?.close();
  }

  async begin(): Promise<void> {
    this.http = await httpConnect(this.address, this.service.port);
    this.pairingProcedure = pairSetup(
      this.airplayVersion === AirPlayMajorVersion.AirPlayV2 ? AuthenticationType.HAP : AuthenticationType.Legacy,
      this.http,
    );
    this._hasPaired = false;
    await errorHandler(() => this.pairingProcedure!.startPairing(), PairingError);
  }

  async finish(): Promise<void> {
    if (!this.pairingProcedure) throw new PairingError("pairing was not started");
    if (!this.pinCode) throw new PairingError("no pin given");

    this.service.credentials = String(
      await errorHandler(() => this.pairingProcedure!.finishPairing("", this.pinCode!, this._name), PairingError),
    );

    // HACK: This pairing handler is shared between AirPlay and RAOP, so we need to
    //       check which protocol we are pairing before storing the credentials.
    if (this.service.protocol === Protocol.AirPlay) {
      this._settings.protocols.airplay.credentials = this.service.credentials;
    } else {
      this._settings.protocols.raop.credentials = this.service.credentials;
    }
    this._hasPaired = true;
  }

  pin(pin: number | string): void {
    this.pinCode = String(pin).padStart(4, "0");
    LOGGER.debug("AirPlay PIN changed to %s", this.pinCode);
  }

  get deviceProvidesPin(): boolean {
    return true;
  }
}
