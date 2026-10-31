/** Functional pairing tests using the API with a fake AirPlay Apple TV. */

import { beforeEach, describe, expect, test } from "bun:test";
import { pair } from "../../../src/index.ts";
import { parseCredentials } from "../../../src/auth/hap_pairing.ts";
import type { AppleTV } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import { PairingError } from "../../../src/exceptions.ts";
import { MemoryStorage } from "../../../src/storage/memory_storage.ts";
import { DEVICE_CREDENTIALS, DEVICE_PIN } from "../../fake_device/airplay.ts";
import { useAirPlayDevice } from "./shared.ts";

const fixture = useAirPlayDevice();

beforeEach(() => {
  fixture.usecase.airplayRequireAuthentication();
});

async function performPairing(conf: AppleTV, pin: number | null = DEVICE_PIN, expectedCredentials: string | null = null) {
  const storage = new MemoryStorage();
  const pairing = await pair(conf, Protocol.AirPlay, { storage });
  try {
    expect(pairing.deviceProvidesPin).toBe(true);
    expect(conf.getService(Protocol.AirPlay)!.credentials).toBeNull();

    await pairing.begin();
    if (pin) pairing.pin(pin);
    expect(pairing.hasPaired).toBe(false);

    await pairing.finish();
    expect(pairing.hasPaired).toBe(true);

    expect(conf.getService(Protocol.AirPlay)!.credentials).not.toBeNull();
    if (expectedCredentials) {
      // Verify credentials in config is correct
      expect(parseCredentials(conf.getService(Protocol.AirPlay)!.credentials).equals(parseCredentials(expectedCredentials))).toBe(true);

      // Verify correct credentials were written to settings
      expect(storage.settings.length).toBe(1);
      expect(
        parseCredentials(storage.settings[0]!.protocols.airplay.credentials).equals(parseCredentials(expectedCredentials)),
      ).toBe(true);
    }
  } finally {
    await pairing.close();
  }
}

const CASES: Array<[Record<string, string>, string | null]> = [
  [{}, DEVICE_CREDENTIALS],
  [{ features: "0x00000000,0x00010000" }, null],
];

describe.each(CASES)("properties %p", (properties, expectedCredentials) => {
  test("pairing exception invalid pin", async () => {
    await expect(performPairing(fixture.conf(properties), 9999, expectedCredentials)).rejects.toThrow(PairingError);
  });

  test("pairing with device new credentials", async () => {
    await performPairing(fixture.conf(properties), DEVICE_PIN, expectedCredentials);
  });
});
