/**
 * Public building blocks for AirPlay protocol extensions (`tsatv/airplay`).
 *
 * The main `tsatv` entry point offers the pyatv-style high-level API (scan, connect,
 * pair). This entry point instead exposes the lower-level AirPlay pieces it is built
 * from, for packages that implement other parts of AirPlay on top of tsatv (such as
 * a screen mirroring sender). These exports are a supported API: importing deep
 * `tsatv/<path>` modules is not, as their layout may change.
 *
 * A typical sender opens an encrypted control connection like this:
 *
 * ```ts
 * import { extractCredentials, httpConnect, Protocol, RtspSession, verifyConnection } from "tsatv/airplay";
 *
 * const service = config.getService(Protocol.AirPlay)!;
 * const connection = await httpConnect(String(config.address), service.port);
 * const verifier = await verifyConnection(extractCredentials(service), connection);
 * const rtsp = new RtspSession(connection); // all requests are now HAP encrypted
 * const secret = verifier.sharedSecret?.(); // input for further derived keys
 * ```
 *
 * The groups below are: credentials and pairing, connections and channels, crypto,
 * binary plist / TLV8 / OPACK encoding, timing, feature flags and configuration.
 */

// --- Credentials and pairing -----------------------------------------------------

export {
  AuthenticationType,
  HapCredentials,
  NO_CREDENTIALS,
  type PairSetupProcedure,
  type PairVerifyProcedure,
  parseCredentials,
  TRANSIENT_CREDENTIALS,
} from "./auth/hap_pairing.ts";
export { hkdfExpand, SRPAuthHandler } from "./auth/hap_srp.ts";
export {
  CONTROL_INPUT_INFO,
  CONTROL_OUTPUT_INFO,
  CONTROL_SALT,
  extractCredentials,
  NullPairVerifyProcedure,
  pairSetup,
  pairVerify,
  verifyConnection,
} from "./protocols/airplay/auth/index.ts";
export {
  type AirPlayHapOptions,
  type AirPlayHapPairSetupOptions,
  AirPlayHapPairSetupProcedure,
  AirPlayHapPairVerifyProcedure,
  getPairingData,
} from "./protocols/airplay/auth/hap.ts";
export { AirPlayHapTransientPairVerifyProcedure, TRANSIENT_PIN } from "./protocols/airplay/auth/hap_transient.ts";

// --- Connections and channels ----------------------------------------------------

export {
  DIGEST_USERNAME,
  decodeBplistFromBody,
  getDigestPayload,
  type HeaderValue,
  HttpConnection,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
  httpConnect,
  parseDigestChallenge,
} from "./support/http.ts";
export { BPLIST_CONTENT_TYPE, RtspSession } from "./support/rtsp.ts";
export { HAPSession } from "./auth/hap_session.ts";
export { AbstractHAPChannel, setupChannel } from "./auth/hap_channel.ts";
export {
  DATASTREAM_INPUT_INFO,
  DATASTREAM_OUTPUT_INFO,
  DATASTREAM_SALT,
  EVENTS_READ_INFO,
  EVENTS_SALT,
  EVENTS_WRITE_INFO,
  FEEDBACK_INTERVAL,
} from "./protocols/airplay/ap2_session.ts";
export {
  type Address,
  createConnection,
  createDatagramEndpoint,
  type DatagramProtocol,
  type DatagramTransport,
  type Protocol as TransportProtocol,
  type Transport,
} from "./support/transport.ts";
export { getLocalAddressReaching } from "./support/net.ts";

// --- Crypto ----------------------------------------------------------------------

export { ChaCha20Poly1305, InvalidTag } from "./support/chacha20poly1305.ts";
export { Chacha20Cipher, Chacha20Cipher8byteNonce } from "./support/chacha20.ts";
export {
  Ed25519PrivateKey,
  Ed25519PublicKey,
  hkdf,
  InvalidSignature,
  X25519PrivateKey,
  X25519PublicKey,
} from "./support/crypto.ts";

// --- Encodings -------------------------------------------------------------------

export * as plistlib from "./support/plistlib.ts";
export * as opack from "./support/opack.ts";
export * as tlv8 from "./auth/hap_tlv8.ts";

// --- Timing ----------------------------------------------------------------------

/** NTP timestamp helpers (ntpNow, ntp2parts, ...). */
export * as timing from "./protocols/raop/timing.ts";
/** NTP style timing server answering a receiver's timing requests. */
export { TimingServer } from "./protocols/raop/protocols/index.ts";

// --- Feature flags ---------------------------------------------------------------

export {
  AirPlayFlags,
  flagNames,
  getPairingRequirement,
  hasFlag,
  isPasswordRequired,
  LEGACY_PAIRING_BIT,
  PASSWORD_BIT,
  PIN_REQUIRED,
  parseFeatures,
} from "./protocols/airplay/utils.ts";

// --- Configuration and storage ---------------------------------------------------

export { PairingRequirement, Protocol } from "./const.ts";
export type { BaseConfig, BaseService, Storage } from "./interface.ts";
export { FileStorage } from "./storage/file_storage.ts";
export { MemoryStorage } from "./storage/memory_storage.ts";
