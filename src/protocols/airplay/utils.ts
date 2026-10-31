/** Manage announced AirPlay features. */

import { AuthenticationType, type HapCredentials, parseCredentials, TRANSIENT_CREDENTIALS } from "../../auth/hap_pairing.ts";
import { PairingRequirement, Protocol } from "../../const.ts";
import type { MutableService } from "../../core/index.ts";
import type { BaseService } from "../../interface.ts";
import { AirPlayVersion } from "../../settings.ts";
import type { HttpRequest, HttpResponse } from "../../support/http.ts";
import { mapRange } from "../../support/index.ts";
import { LogLevel, type Logger } from "../../support/logging.ts";
import * as plistlib from "../../support/plistlib.ts";

// Status flags
export const PIN_REQUIRED = 0x8;
export const PASSWORD_BIT = 0x80;
export const LEGACY_PAIRING_BIT = 0x200;

export const DBFS_MIN = -30.0;
export const DBFS_MAX = 0.0;
export const PERCENTAGE_MIN = 0.0;
export const PERCENTAGE_MAX = 100.0;

const UNSUPPORTED_MODELS = [/^Mac\d+,\d+$/];

/** Major AirPlay protocol version. */
export enum AirPlayMajorVersion {
  AirPlayV1 = 1,
  AirPlayV2 = 2,
}

function prop(properties: Record<string, string> | Map<string, string>, key: string): string | undefined {
  if (properties instanceof Map) return properties.get(key);
  return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
}

function getFlags(properties: Record<string, string>): number {
  // Flags are either present via "sf" or "flags"
  const flags = prop(properties, "sf") || prop(properties, "flags") || "0x0";
  return parseInt(flags, 16);
}

/** Features supported by AirPlay (bit flags, values are bigint as > 32 bits). */
export const AirPlayFlags = {
  SupportsAirPlayVideoV1: 1n << 0n,
  SupportsAirPlayPhoto: 1n << 1n,
  SupportsAirPlaySlideShow: 1n << 5n,
  SupportsAirPlayScreen: 1n << 7n,
  SupportsAirPlayAudio: 1n << 9n,
  AudioRedundant: 1n << 11n,
  Authentication_4: 1n << 14n,
  MetadataFeatures_0: 1n << 15n,
  MetadataFeatures_1: 1n << 16n,
  MetadataFeatures_2: 1n << 17n,
  AudioFormats_0: 1n << 18n,
  AudioFormats_1: 1n << 19n,
  AudioFormats_2: 1n << 20n,
  AudioFormats_3: 1n << 21n,
  Authentication_1: 1n << 23n,
  Authentication_8: 1n << 26n,
  SupportsLegacyPairing: 1n << 27n,
  HasUnifiedAdvertiserInfo: 1n << 30n,
  IsCarPlay: 1n << 32n,
  SupportsAirPlayVideoPlayQueue: 1n << 33n,
  SupportsAirPlayFromCloud: 1n << 34n,
  SupportsTLS_PSK: 1n << 35n,
  SupportsUnifiedMediaControl: 1n << 38n,
  SupportsBufferedAudio: 1n << 40n,
  SupportsPTP: 1n << 41n,
  SupportsScreenMultiCodec: 1n << 42n,
  SupportsSystemPairing: 1n << 43n,
  IsAPValeriaScreenSender: 1n << 44n,
  SupportsHKPairingAndAccessControl: 1n << 46n,
  SupportsCoreUtilsPairingAndEncryption: 1n << 48n,
  SupportsAirPlayVideoV2: 1n << 49n,
  MetadataFeatures_3: 1n << 50n,
  SupportsUnifiedPairSetupandMFi: 1n << 51n,
  SupportsSetPeersExtendedMessage: 1n << 52n,
  SupportsAPSync: 1n << 54n,
  SupportsWoL: 1n << 55n,
  SupportsWoL2: 1n << 56n,
  SupportsHangdogRemoteControl: 1n << 58n,
  SupportsAudioStreamConnectionSetup: 1n << 59n,
  SupportsAudioMetadataControl: 1n << 60n,
  SupportsRFC2198Redundancy: 1n << 61n,
} as const;

export type AirPlayFlags = bigint;

/** Return if a flag is set. */
export function hasFlag(flags: bigint, flag: bigint): boolean {
  return (flags & flag) === flag;
}

/** Return names of set flags (for printing). */
export function flagNames(flags: bigint): string[] {
  return Object.entries(AirPlayFlags)
    .filter(([, v]) => hasFlag(flags, v))
    .map(([k]) => k);
}

/**
 * Parse an AirPlay feature string and return what is supported.
 *
 * A feature string have one of the following formats:
 *   - 0x12345678
 *   - 0x12345678,0xabcdef12 => 0xabcdef1212345678
 */
export function parseFeatures(features: string): bigint {
  const match = /^0x([0-9A-Fa-f]{1,8})(?:,0x([0-9A-Fa-f]{1,8})|)$/.exec(features);
  if (!match) throw new RangeError(`invalid feature string: ${features}`);
  let value = match[1]!;
  if (match[2] !== undefined) value = match[2] + value.padStart(8, "0");
  return BigInt("0x" + value);
}

/** Return if password is required by AirPlay service. */
export function isPasswordRequired(service: BaseService): boolean {
  // "pw" flag
  if ((prop(service.properties, "pw") ?? "false").toLowerCase() === "true") return true;
  // Legacy "flags" property
  return (getFlags(service.properties) & PASSWORD_BIT) !== 0;
}

/** Return pairing requirement for service. */
export function getPairingRequirement(service: BaseService): PairingRequirement {
  if (getFlags(service.properties) & (LEGACY_PAIRING_BIT | PIN_REQUIRED)) return PairingRequirement.Mandatory;
  // "Current User" not supported by pyatv
  if ((prop(service.properties, "act") ?? "0") === "2") return PairingRequirement.Unsupported;
  // A password protected receiver (e.g. flags 0xC4) does not set the pairing bits even
  // though AirPlay requires a one time pairing. RAOP authenticates with the password
  // (digest) instead, so pairing is not needed there.
  if (service.protocol === Protocol.AirPlay && isPasswordRequired(service)) return PairingRequirement.Mandatory;
  return PairingRequirement.NotNeeded;
}

/** Return if device supports remote control tunneling. */
export function isRemoteControlSupported(service: BaseService, credentials: HapCredentials): boolean {
  const model = prop(service.properties, "model") ?? "";

  // HomePod supports remote control but only with transient credentials
  if (model.startsWith("AudioAccessory")) return credentials.equals(TRANSIENT_CREDENTIALS);
  if (!model.startsWith("AppleTV")) return false;

  // tvOS must be at least version 13 and HAP credentials are required by Apple TV
  const version = (prop(service.properties, "osvers") ?? "0.0").split(".")[0]!;
  return parseFloat(version) >= 13.0 && credentials.type === AuthenticationType.HAP;
}

/** Encode a binary plist payload. */
export function encodePlistBody(data: unknown): Buffer {
  return plistlib.dumps(data, plistlib.FMT_BINARY);
}

/** Decode a binary plist payload (null if it can't be decoded). */
export function decodePlistBody(body: string | Uint8Array | Record<string, unknown>): any {
  try {
    if (body !== null && typeof body === "object" && !(body instanceof Uint8Array)) return body;
    return plistlib.loads(typeof body === "string" ? Buffer.from(body, "utf-8") : body);
  } catch {
    return null;
  }
}

/** Log an AirPlay request with optional binary plist body. */
export function logRequest(logger: Logger, request: HttpRequest, messagePrefix = ""): void {
  if (!logger.isEnabledFor(LogLevel.DEBUG)) return;
  logger.debug("%sRequest: %s", messagePrefix, request);
  if (request.headers.get("content-type") === "application/x-apple-binary-plist") {
    const payload = decodePlistBody(request.body);
    if (payload) logger.debug("%s%s request plist content: %s", messagePrefix, request.protocol, payload);
  }
}

/** Log an AirPlay response with optional binary plist body. */
export function logResponse(logger: Logger, response: HttpResponse, messagePrefix = ""): void {
  if (!logger.isEnabledFor(LogLevel.DEBUG)) return;
  logger.debug("%sResponse: %s", messagePrefix, response);
  if (response && response.headers.get("content-type") === "application/x-apple-binary-plist") {
    const payload = decodePlistBody(response.body);
    if (payload) logger.debug("%s%s response plist content: %s", messagePrefix, response.protocol, payload);
  }
}

/** Return major AirPlay version supported by a service. */
export function getProtocolVersion(service: BaseService, preferredVersion: AirPlayVersion): AirPlayMajorVersion {
  if (preferredVersion === AirPlayVersion.Auto) {
    // Legacy credentials cannot derive the encryption keys AirPlay 2 needs, so stick
    // to AirPlay 1 when that is what we have (otherwise streaming always fails)
    if (hasLegacyCredentials(service)) return AirPlayMajorVersion.AirPlayV1;

    let features = prop(service.properties, "ft");
    if (!features) features = prop(service.properties, "features") ?? "0x0";
    const parsed = parseFeatures(features);
    if (
      hasFlag(parsed, AirPlayFlags.SupportsUnifiedMediaControl) ||
      hasFlag(parsed, AirPlayFlags.SupportsCoreUtilsPairingAndEncryption)
    ) {
      return AirPlayMajorVersion.AirPlayV2;
    }
    return AirPlayMajorVersion.AirPlayV1;
  }
  if (preferredVersion === AirPlayVersion.V2) return AirPlayMajorVersion.AirPlayV2;
  return AirPlayMajorVersion.AirPlayV1;
}

function hasLegacyCredentials(service: BaseService): boolean {
  try {
    return parseCredentials(service.credentials).type === AuthenticationType.Legacy;
  } catch {
    return false;
  }
}

/** Update AirPlay service according to that it supports. */
export function updateServiceDetails(service: MutableService): void {
  service.requiresPassword = isPasswordRequired(service);

  if ((prop(service.properties, "acl") ?? "0") === "1") {
    // Access control might say that pairing is not possible
    service.pairing = PairingRequirement.Disabled;
  } else if (UNSUPPORTED_MODELS.some((model) => model.test(prop(service.properties, "model") ?? ""))) {
    service.pairing = PairingRequirement.Unsupported;
  } else {
    service.pairing = getPairingRequirement(service);
  }
}

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/** Convert percentage level to dBFS. Used for volume levels in AirPlay. */
export function pctToDbfs(level: number): number {
  // AirPlay uses -144.0 as muted volume, so re-map 0.0 to that
  if (isClose(level, 0.0)) return -144.0;
  return mapRange(level, PERCENTAGE_MIN, PERCENTAGE_MAX, DBFS_MIN, DBFS_MAX);
}

/** Convert dBFS to percentage. */
export function dbfsToPct(level: number): number {
  // AirPlay uses -144.0 as "muted", but we treat everything below -30.0 as muted
  if (level < DBFS_MIN) return PERCENTAGE_MIN;
  return mapRange(level, DBFS_MIN, DBFS_MAX, PERCENTAGE_MIN, PERCENTAGE_MAX);
}
