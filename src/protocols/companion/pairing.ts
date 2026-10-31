/** Device pairing and derivation of encryption keys. */

import { SRPAuthHandler } from "../../auth/hap_srp.ts";
import type { Core } from "../../core/index.ts";
import { PairingError } from "../../exceptions.ts";
import { PairingHandler } from "../../interface.ts";
import type { Settings } from "../../settings.ts";
import { errorHandler } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { CompanionPairSetupProcedure } from "./auth.ts";
import { CompanionConnection } from "./connection.ts";
import { CompanionProtocol } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.companion.pairing");

/** Pairing handler used to pair the Companion link protocol. */
export class CompanionPairingHandler extends PairingHandler {
  private readonly _name: string;
  readonly connection: CompanionConnection;
  readonly srp: SRPAuthHandler;
  readonly protocol: CompanionProtocol;
  readonly pairingProcedure: CompanionPairSetupProcedure;
  pinCode: string | null = null;
  private readonly _settings: Settings;
  private _hasPaired = false;

  constructor(core: Core, options: Record<string, unknown> = {}) {
    super(core.sessionManager, core.service);
    this._name = (options.name as string | undefined) ?? "pyatv";
    this.connection = new CompanionConnection(core.config.address, core.service.port, null);
    this.srp = new SRPAuthHandler();
    this.protocol = new CompanionProtocol(this.connection, this.srp, core.service);
    this.pairingProcedure = new CompanionPairSetupProcedure(this.protocol, this.srp);
    this._settings = core.settings;
  }

  /** Call to free allocated resources after pairing. */
  override async close(): Promise<void> {
    this.protocol.stop();
    await super.close();
  }

  /** If a successful pairing has been performed. */
  get hasPaired(): boolean {
    return this._hasPaired;
  }

  /** Start pairing process. */
  async begin(): Promise<void> {
    LOGGER.debug("Start pairing Companion");
    await errorHandler(() => this.pairingProcedure.startPairing(), PairingError);
  }

  /** Stop pairing process. */
  async finish(): Promise<void> {
    LOGGER.debug("Finish pairing Companion");
    if (!this.pinCode) throw new PairingError("no pin given");

    this.service.credentials = String(
      await errorHandler(
        () => this.pairingProcedure.finishPairing("", this.pinCode!, this._name), // username required but not used
        PairingError,
      ),
    );
    this._settings.protocols.companion.credentials = this.service.credentials;
    this._hasPaired = true;
  }

  /** Return True if remote device presents PIN code, else False. */
  get deviceProvidesPin(): boolean {
    return true;
  }

  /** Pin code used for pairing. */
  pin(pin: number | string): void {
    this.pinCode = String(pin).padStart(4, "0");
    LOGGER.debug("Companion PIN changed to %s", this.pinCode);
  }
}
