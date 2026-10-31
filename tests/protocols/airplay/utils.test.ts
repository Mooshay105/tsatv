/** Unit tests for pyatv.protocols.airplay.utils. */

import { describe, expect, test } from "bun:test";
import { NO_CREDENTIALS, parseCredentials, TRANSIENT_CREDENTIALS } from "../../../src/auth/hap_pairing.ts";
import { PairingRequirement, Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import {
  AirPlayFlags,
  AirPlayMajorVersion,
  getPairingRequirement,
  getProtocolVersion,
  isPasswordRequired,
  isRemoteControlSupported,
  parseFeatures,
} from "../../../src/protocols/airplay/utils.ts";
import { AirPlayVersion } from "../../../src/settings.ts";

// These are not really valid credentials but parseCredentials accepts them (for now)
const HAP_CREDS = parseCredentials("aa:bb:cc:dd");
const LEGACY_CREDS = parseCredentials(":aa::bb");

describe("parseFeatures", () => {
  test.each([
    // Single feature flag
    ["0x00000001", AirPlayFlags.SupportsAirPlayVideoV1],
    [
      "0x40000003",
      AirPlayFlags.HasUnifiedAdvertiserInfo | AirPlayFlags.SupportsAirPlayPhoto | AirPlayFlags.SupportsAirPlayVideoV1,
    ],
    // Dual feature flag
    ["0x00000003,0x00000001", AirPlayFlags.IsCarPlay | AirPlayFlags.SupportsAirPlayPhoto | AirPlayFlags.SupportsAirPlayVideoV1],
  ] as Array<[string, bigint]>)("%s", (flags, output) => {
    expect(parseFeatures(flags)).toBe(output);
  });

  test.each(["foo", "1234", "0x00000001,", ",0x00000001", "0x00000001,0x00000001,0x00000001"])("bad input %s", (value) => {
    expect(() => parseFeatures(value)).toThrow();
  });
});

test.each([
  [{}, false],
  [{ pw: "false" }, false],
  [{ pw: "true" }, true],
  [{ pw: "TRUE" }, true],
  [{ sf: "0x1" }, false],
  [{ sf: "0x80" }, true],
  [{ flags: "0x1" }, false],
  [{ flags: "0x80" }, true],
] as Array<[Record<string, string>, boolean]>)("isPasswordRequired %p", (properties, requiresPassword) => {
  const service = new MutableService("id", Protocol.RAOP, 0, properties);
  expect(isPasswordRequired(service)).toBe(requiresPassword);
});

test.each([
  [{ sf: "0x1" }, PairingRequirement.NotNeeded],
  [{ sf: "0x200" }, PairingRequirement.Mandatory],
  [{ ft: "0x1" }, PairingRequirement.NotNeeded],
  [{ flags: "0x1" }, PairingRequirement.NotNeeded],
  [{ flags: "0x200" }, PairingRequirement.Mandatory],
  [{ features: "0x1" }, PairingRequirement.NotNeeded],
  [{ sf: "0x8" }, PairingRequirement.Mandatory],
  [{ flags: "0x8" }, PairingRequirement.Mandatory],
  [{ flags: "0x0" }, PairingRequirement.NotNeeded],
  // Corresponds to only allow "Current User", which is not supported by pyatv right now
  [{ act: "2" }, PairingRequirement.Unsupported],
] as Array<[Record<string, string>, PairingRequirement]>)("getPairingRequirement %p", (props, expectedReq) => {
  const service = new MutableService("id", Protocol.AirPlay, 0, props);
  expect(getPairingRequirement(service)).toBe(expectedReq);
});

test.each([
  [{}, NO_CREDENTIALS, false],
  [{ model: "AudioAccessory1,2" }, NO_CREDENTIALS, false],
  [{ model: "AudioAccessory1,2" }, TRANSIENT_CREDENTIALS, true],
  [{ model: "Foo" }, NO_CREDENTIALS, false],
  [{ osvers: "13.0" }, NO_CREDENTIALS, false],
  [{ osvers: "13.0", model: "AppleTV5,6" }, NO_CREDENTIALS, false],
  [{ osvers: "13.0", model: "AppleTV5,6" }, TRANSIENT_CREDENTIALS, false],
  [{ osvers: "13.0", model: "AppleTV5,6" }, LEGACY_CREDS, false],
  [{ osvers: "13.0", model: "AppleTV5,6" }, HAP_CREDS, true],
  [{ osvers: "8.4.4", model: "AppleTV5,6" }, NO_CREDENTIALS, false],
] as const)("isRemoteControlSupported %p %#", (props, credentials, expectedSupported) => {
  const service = new MutableService("id", Protocol.AirPlay, 0, props as Record<string, string>);
  expect(isRemoteControlSupported(service, credentials)).toBe(expectedSupported);
});

test.each([
  // Fallback
  [{}, AirPlayVersion.Auto, AirPlayMajorVersion.AirPlayV1],
  // Used by RAOP
  [{ ft: "0x5A7FFFF7,0xE" }, AirPlayVersion.Auto, AirPlayMajorVersion.AirPlayV1], // Apple TV 3
  [{ ft: "0x4A7FCA00,0xBC354BD0" }, AirPlayVersion.Auto, AirPlayMajorVersion.AirPlayV2], // HomePod Mini
  // Used by AirPlay
  [{ features: "0x5A7FFFF7,0xE" }, AirPlayVersion.Auto, AirPlayMajorVersion.AirPlayV1], // Apple TV 3
  // Should yield v1 but overridden with v2
  [{ features: "0x5A7FFFF7,0xE" }, AirPlayVersion.V2, AirPlayMajorVersion.AirPlayV2],
  [{ features: "0x4A7FCA00,0xBC354BD0" }, AirPlayVersion.Auto, AirPlayMajorVersion.AirPlayV2], // HomePod Mini
  // Should yield v2 both overridden with v1
  [{ features: "0x4A7FCA00,0xBC354BD0" }, AirPlayVersion.V1, AirPlayMajorVersion.AirPlayV1],
] as Array<[Record<string, string>, AirPlayVersion, AirPlayMajorVersion]>)(
  "getProtocolVersion %p %p",
  (props, preferredVersion, expectedVersion) => {
    const service = new MutableService("id", Protocol.AirPlay, 0, props);
    expect(getProtocolVersion(service, preferredVersion)).toBe(expectedVersion);
  },
);
