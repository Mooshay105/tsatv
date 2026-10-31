/** Unit tests for legacy device authentication. */

import { expect, test } from "bun:test";
import { HapCredentials } from "../../../../src/auth/hap_pairing.ts";
import { AuthenticationError, NotSupportedError } from "../../../../src/exceptions.ts";
import { AirPlayLegacyPairSetupProcedure, AirPlayLegacyPairVerifyProcedure } from "../../../../src/protocols/airplay/auth/legacy.ts";
import { LegacySRPAuthHandler } from "../../../../src/protocols/airplay/srp.ts";
import { DEVICE_AUTH_KEY, DEVICE_IDENTIFIER, DEVICE_PIN } from "../../../fake_device/airplay.ts";
import { useAirPlayDevice } from "../shared.ts";

const IDENTIFIER = "11".repeat(8);
const INVALID_AUTH_KEY = "00".repeat(32);

const fixture = useAirPlayDevice();

function newCredentials(identifier: string, seed: string): HapCredentials {
  return new HapCredentials(Buffer.alloc(0), Buffer.from(seed, "hex"), Buffer.alloc(0), Buffer.from(identifier, "hex"));
}

function newSrp(identifier: string, seed: string): LegacySRPAuthHandler {
  const srp = new LegacySRPAuthHandler(newCredentials(identifier, seed));
  srp.initialize();
  return srp;
}

test("verify invalid", async () => {
  const verifier = new AirPlayLegacyPairVerifyProcedure(await fixture.connection(), newSrp(IDENTIFIER, INVALID_AUTH_KEY));
  await expect(verifier.verifyCredentials()).rejects.toThrow(AuthenticationError);
});

test("verify authenticated", async () => {
  const verifier = new AirPlayLegacyPairVerifyProcedure(await fixture.connection(), newSrp(IDENTIFIER, DEVICE_AUTH_KEY));
  expect(await verifier.verifyCredentials()).toBe(false);
});

test("verify has no encryption keys", async () => {
  const verifier = new AirPlayLegacyPairVerifyProcedure(await fixture.connection(), newSrp(IDENTIFIER, DEVICE_AUTH_KEY));
  expect(() => verifier.encryptionKeys("salt", "output", "input")).toThrow(NotSupportedError);
});

test("pairing failed", async () => {
  const procedure = new AirPlayLegacyPairSetupProcedure(await fixture.connection(), newSrp(IDENTIFIER, INVALID_AUTH_KEY));
  await procedure.startPairing();
  await expect(procedure.finishPairing(DEVICE_IDENTIFIER, DEVICE_PIN, null)).rejects.toThrow(AuthenticationError);
});

test("pairing successful", async () => {
  const procedure = new AirPlayLegacyPairSetupProcedure(await fixture.connection(), newSrp(DEVICE_IDENTIFIER, DEVICE_AUTH_KEY));
  await procedure.startPairing();
  expect(await procedure.finishPairing(DEVICE_IDENTIFIER, DEVICE_PIN, null)).toBeTruthy();
});
