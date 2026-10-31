/** Device pairing and derivation of encryption keys. */

import { parseCredentials } from "../../auth/hap_pairing.ts";
import { SRPAuthHandler } from "../../auth/hap_srp.ts";
import type { Core } from "../../core/index.ts";
import { PairingError } from "../../exceptions.ts";
import { PairingHandler } from "../../interface.ts";
import type { Settings } from "../../settings.ts";
import { errorHandler } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { MrpPairSetupProcedure, MrpPairVerifyProcedure } from "./auth.ts";
import { MrpConnection } from "./connection.ts";
import { MrpProtocol } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.mrp.pairing");

/** Base class for API used to pair with an Apple TV. */
export class MrpPairingHandler extends PairingHandler {
  readonly connection: MrpConnection;
  readonly srp: SRPAuthHandler;
  readonly protocol: MrpProtocol;
  readonly pairingProcedure: MrpPairSetupProcedure;
  pinCode: string | null = null;
  private readonly _settings: Settings;
  private _hasPaired = false;

  constructor(core: Core, _options: Record<string, unknown> = {}) {
    super(core.sessionManager, core.service);
    this.connection = new MrpConnection(core.config.address, this.service.port);
    this.srp = new SRPAuthHandler();
    this.protocol = new MrpProtocol(this.connection, this.srp, this.service, core.settings.info);
    this.pairingProcedure = new MrpPairSetupProcedure(this.protocol, this.srp);
    this._settings = core.settings;
  }

  /** Call to free allocated resources after pairing. */
  override async close(): Promise<void> {
    this.connection.close();
    await super.close();
  }

  /** If a successful pairing has been performed. */
  get hasPaired(): boolean {
    return this._hasPaired;
  }

  /** Start pairing process. */
  async begin(): Promise<void> {
    await errorHandler(() => this.pairingProcedure.startPairing(), PairingError);
  }

  /** Stop pairing process. */
  async finish(): Promise<void> {
    if (!this.pinCode) throw new PairingError("no pin given");

    const credentials = String(
      await errorHandler(
        () => this.pairingProcedure.finishPairing("", this.pinCode!, null), // username required but not used
        PairingError,
      ),
    );

    LOGGER.debug("Verifying credentials %s", credentials);

    const verifier = new MrpPairVerifyProcedure(this.protocol, this.srp, parseCredentials(credentials));
    await errorHandler(() => verifier.verifyCredentials(), PairingError);

    this.service.credentials = credentials;
    this._settings.protocols.mrp.credentials = this.service.credentials;
    this._hasPaired = true;
  }

  /** Return True if remote device presents PIN code, else False. */
  get deviceProvidesPin(): boolean {
    return true;
  }

  /** Pin code used for pairing. */
  pin(pin: number | string): void {
    this.pinCode = String(pin).padStart(4, "0");
    LOGGER.debug("MRP PIN changed to %s", this.pinCode);
  }
}
