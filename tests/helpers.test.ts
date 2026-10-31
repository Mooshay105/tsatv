/** Functional tests for helper methods. Agnostic to protocol implementation. */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AppleTV, ManualService } from "../src/conf.ts";
import { PairingRequirement, Protocol } from "../src/const.ts";
import { autoConnect, getUniqueId, helperHooks, isDeviceSupported, isStreamable } from "../src/helpers.ts";
import type { AppleTV as AppleTVInterface, BaseConfig } from "../src/interface.ts";
import { dataPath } from "./utils.ts";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

function mockScan(): BaseConfig[] {
  const atvs: BaseConfig[] = [];
  spies.push(spyOn(helperHooks, "scan").mockImplementation(async () => atvs));
  return atvs;
}

test("auto connect with no device", async () => {
  mockScan();
  let found = true;

  await autoConnect(
    async () => {
      throw new Error("should not be called");
    },
    {
      notFound: async () => {
        found = false;
      },
    },
  );

  expect(found).toBe(false);
});

test("auto connect with device", async () => {
  const atvs = mockScan();
  const config = new AppleTV("address", "name");
  const mockDevice = { close: mock(() => new Set()) } as unknown as AppleTVInterface;
  atvs.push(config);
  spies.push(spyOn(helperHooks, "connect").mockImplementation(async () => mockDevice));

  let found = null as AppleTVInterface | null;
  await autoConnect(async (atv) => {
    found = atv;
  });

  expect(found).toBe(mockDevice);
  expect(mockDevice.close).toHaveBeenCalledTimes(1);
});

test.each([
  ["_unknown._tcp.local", "name", {}, null],
  ["_appletv-v2._tcp.local", "name", {}, "name"],
  ["_appletv-v2._tcp.local", "name_duplicate", {}, "name"],
  ["_touch-able._tcp.local", "name", {}, "name"],
  ["_touch-able._tcp.local", "name_duplicate", {}, "name"],
  ["_mediaremotetv._tcp.local", "name", { UniqueIdentifier: "test" }, "test"],
  ["_airplay._tcp.local", "name", { deviceid: "test" }, "test"],
  ["_raop._tcp.local", "abcd@name", {}, "abcd"],
  ["_raop._tcp.local", "name", { pk: "abcd" }, "abcd"],
  ["_hscp._tcp.local", "name", { "Machine ID": "abcd" }, "abcd"],
] as Array<[string, string, Record<string, string>, string | null]>)(
  "get unique id %s %s",
  (serviceType, serviceName, properties, expectedId) => {
    expect(getUniqueId(serviceType, serviceName, properties)).toBe(expectedId);
  },
);

test.each([
  ["only_metadata.wav", true],
  ["README", false],
] as Array<[string, boolean]>)("is streamable supported file %s", async (testFile, streamable) => {
  expect(await isStreamable(dataPath(testFile))).toBe(streamable);
});

test.each([
  [PairingRequirement.Unsupported, false],
  [PairingRequirement.Disabled, false],
  [PairingRequirement.NotNeeded, true],
  [PairingRequirement.Optional, true],
  [PairingRequirement.Mandatory, true],
] as Array<[PairingRequirement, boolean]>)("is device supported %p", (pairingRequirement, isSupported) => {
  const dev = new AppleTV("127.0.0.1", "test");
  dev.addService(new ManualService("unsupported", Protocol.DMAP, 0, {}, { pairingRequirement: PairingRequirement.Unsupported }));
  dev.addService(new ManualService("test", Protocol.AirPlay, 0, {}, { pairingRequirement }));
  expect(isDeviceSupported(dev)).toBe(isSupported);
});
