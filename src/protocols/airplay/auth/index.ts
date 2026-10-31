/** Pick authentication type based on device support. */

import {
  AuthenticationType,
  type HapCredentials,
  NO_CREDENTIALS,
  type PairSetupProcedure,
  type PairVerifyProcedure,
  parseCredentials,
  TRANSIENT_CREDENTIALS,
} from "../../../auth/hap_pairing.ts";
import { HAPSession } from "../../../auth/hap_session.ts";
import { SRPAuthHandler } from "../../../auth/hap_srp.ts";
import { NotSupportedError } from "../../../exceptions.ts";
import type { BaseService } from "../../../interface.ts";
import type { HttpConnection } from "../../../support/http.ts";
import { getLogger } from "../../../support/logging.ts";
import { LegacySRPAuthHandler, newCredentials } from "../srp.ts";
import { AirPlayFlags, hasFlag, parseFeatures } from "../utils.ts";
import { AirPlayHapPairSetupProcedure, AirPlayHapPairVerifyProcedure } from "./hap.ts";
import { AirPlayHapTransientPairVerifyProcedure } from "./hap_transient.ts";
import { AirPlayLegacyPairSetupProcedure, AirPlayLegacyPairVerifyProcedure } from "./legacy.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.auth");

export const CONTROL_SALT = "Control-Salt";
export const CONTROL_OUTPUT_INFO = "Control-Write-Encryption-Key";
export const CONTROL_INPUT_INFO = "Control-Read-Encryption-Key";

/** Null implementation for Pair-Verify when no verification is needed. */
export class NullPairVerifyProcedure implements PairVerifyProcedure {
  async verifyCredentials(): Promise<boolean> {
    LOGGER.debug("Performing null Pair-Verify");
    return false;
  }

  encryptionKeys(_salt: string, _outputInfo: string, _inputInfo: string): [Buffer, Buffer] {
    throw new NotSupportedError("encryption keys not supported by null implementation");
  }
}

/** Return procedure object used for Pair-Setup. */
export function pairSetup(authType: AuthenticationType, connection: HttpConnection): PairSetupProcedure {
  LOGGER.debug("Setting up new AirPlay Pair-Setup procedure with type %s", AuthenticationType[authType]);

  if (authType === AuthenticationType.Legacy) {
    const legacySrp = new LegacySRPAuthHandler(newCredentials());
    legacySrp.initialize();
    return new AirPlayLegacyPairSetupProcedure(connection, legacySrp);
  }
  if (authType === AuthenticationType.HAP) {
    const srp = new SRPAuthHandler();
    srp.initialize();
    return new AirPlayHapPairSetupProcedure(connection, srp);
  }
  throw new NotSupportedError(`authentication type ${AuthenticationType[authType]} does not support Pair-Setup`);
}

/** Return procedure object used for Pair-Verify. */
export function pairVerify(credentials: HapCredentials, connection: HttpConnection): PairVerifyProcedure {
  LOGGER.debug("Setting up new AirPlay Pair-Verify procedure with type %s", AuthenticationType[credentials.type]);

  if (credentials.type === AuthenticationType.Null) return new NullPairVerifyProcedure();
  if (credentials.type === AuthenticationType.Legacy) {
    const legacySrp = new LegacySRPAuthHandler(credentials);
    legacySrp.initialize();
    return new AirPlayLegacyPairVerifyProcedure(connection, legacySrp);
  }

  const srp = new SRPAuthHandler();
  srp.initialize();
  if (credentials.type === AuthenticationType.HAP) return new AirPlayHapPairVerifyProcedure(connection, srp, credentials);
  return new AirPlayHapTransientPairVerifyProcedure(connection, srp);
}

/** Perform Pair-Verify on a connection and enable encryption. */
export async function verifyConnection(credentials: HapCredentials, connection: HttpConnection): Promise<PairVerifyProcedure> {
  const verifier = pairVerify(credentials, connection);
  const hasEncryptionKeys = await verifier.verifyCredentials();

  if (hasEncryptionKeys) {
    const [outputKey, inputKey] = verifier.encryptionKeys(CONTROL_SALT, CONTROL_OUTPUT_INFO, CONTROL_INPUT_INFO);
    const session = new HAPSession();
    session.enable(outputKey, inputKey);
    connection.receiveProcessor = (data) => session.decrypt(data);
    connection.sendProcessor = (data) => session.encrypt(data);
  }
  return verifier;
}

/** Extract credentials from service based on what's supported. */
export function extractCredentials(service: BaseService): HapCredentials {
  if (service.credentials !== null) return parseCredentials(service.credentials);

  const props = service.properties;
  const flags = parseFeatures(props.features ?? props.ft ?? "0x0");
  if (hasFlag(flags, AirPlayFlags.SupportsSystemPairing) || hasFlag(flags, AirPlayFlags.SupportsCoreUtilsPairingAndEncryption)) {
    return TRANSIENT_CREDENTIALS;
  }
  return NO_CREDENTIALS;
}
