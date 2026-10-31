/** Unit tests for pyatv.protocols.airplay.auth. */

import { expect, spyOn, test } from "bun:test";
import { AuthenticationType, HapCredentials, NO_CREDENTIALS } from "../../../../src/auth/hap_pairing.ts";
import { NullPairVerifyProcedure, pairSetup, pairVerify } from "../../../../src/protocols/airplay/auth/index.ts";
import { AirPlayHapPairSetupProcedure, AirPlayHapPairVerifyProcedure } from "../../../../src/protocols/airplay/auth/hap.ts";
import { AirPlayLegacyPairSetupProcedure, AirPlayLegacyPairVerifyProcedure } from "../../../../src/protocols/airplay/auth/legacy.ts";
import { airplaySrpHooks } from "../../../../src/protocols/airplay/srp.ts";
import type { HttpConnection } from "../../../../src/support/http.ts";

const b = (s: string) => Buffer.from(s);

// Legacy credentials only have ltsk (seed) and client_id (identifier) filled in.
// Seed must be 32 bytes here since the SRP handler is not mocked (as done in pyatv).
const LEGACY_CREDENTIALS = new HapCredentials(b(""), b("1".repeat(32)), b(""), b("2"));
const HAP_CREDENTIALS = new HapCredentials(b("1"), b("2"), b("3"), b("4"));

const connection = {} as HttpConnection;

// No authentication

test("pair verify no credentials", () => {
  expect(pairVerify(NO_CREDENTIALS, connection)).toBeInstanceOf(NullPairVerifyProcedure);
});

// Legacy authentication

test("pair setup legacy", () => {
  // Already spied on by test setup (always returns DEVICE_CREDENTIALS)
  (airplaySrpHooks.newCredentials as unknown as ReturnType<typeof spyOn>).mockReturnValue(LEGACY_CREDENTIALS);
  const procedure = pairSetup(AuthenticationType.Legacy, connection);
  expect(procedure).toBeInstanceOf(AirPlayLegacyPairSetupProcedure);
  expect((procedure as AirPlayLegacyPairSetupProcedure).srp.credentials).toBe(LEGACY_CREDENTIALS);
});

test("pair verify legacy", () => {
  const procedure = pairVerify(LEGACY_CREDENTIALS, connection);
  expect(procedure).toBeInstanceOf(AirPlayLegacyPairVerifyProcedure);
  expect((procedure as AirPlayLegacyPairVerifyProcedure).srp.credentials).toBe(LEGACY_CREDENTIALS);
});

// HAP authentication

test("pair setup hap", () => {
  expect(pairSetup(AuthenticationType.HAP, connection)).toBeInstanceOf(AirPlayHapPairSetupProcedure);
});

test("pair verify hap", () => {
  expect(pairVerify(HAP_CREDENTIALS, connection)).toBeInstanceOf(AirPlayHapPairVerifyProcedure);
});
