/** Unit tests for pyatv.protocols.airplay. */

import { expect, test } from "bun:test";
import { DeviceModel, FeatureName, FeatureState, OperatingSystem, PairingRequirement, Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import type * as mdns from "../../../src/core/mdns.ts";
import { DeviceInfo } from "../../../src/interface.ts";
import { AirPlayFeatures, deviceInfo, scan, serviceInfo } from "../../../src/protocols/airplay/index.ts";
import { parseFeatures } from "../../../src/protocols/airplay/utils.ts";

const AIRPLAY_SERVICE = "_airplay._tcp.local";

test("airplay scan handlers present", () => {
  const handlers = scan();
  expect(Object.keys(handlers).length).toBe(1);
  expect(Object.keys(handlers)).toContain(AIRPLAY_SERVICE);
});

test("airplay handler to service", () => {
  const [handler] = scan()[AIRPLAY_SERVICE]!;
  const mdnsService: mdns.Service = { type: AIRPLAY_SERVICE, name: "foo", address: "127.0.0.1", port: 1234, properties: { foo: "bar" } };
  const [name, service] = handler(mdnsService, { services: [], deepSleep: false, model: null })!;
  expect(name).toBe("foo");
  expect(service.port).toBe(1234);
  expect(service.credentials).toBeNull();
  expect(service.properties).toEqual({ foo: "bar" });
});

test("airplay device info name", () => {
  const [, deviceInfoName] = scan()[AIRPLAY_SERVICE]!;
  expect(deviceInfoName("Ohana")).toBe("Ohana");
});

test.each([
  [{ model: "unknown" }, { [DeviceInfo.RAW_MODEL]: "unknown" }],
  [{ model: "AppleTV6,2" }, { [DeviceInfo.MODEL]: DeviceModel.Gen4K, [DeviceInfo.RAW_MODEL]: "AppleTV6,2" }],
  [{ model: "MacBookAir10,1" }, { [DeviceInfo.RAW_MODEL]: "MacBookAir10,1", [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.MacOS }],
  [{ osvers: "14.7" }, { [DeviceInfo.VERSION]: "14.7" }],
  [{ deviceid: "aa:bb:cc:dd:ee:ff" }, { [DeviceInfo.MAC]: "aa:bb:cc:dd:ee:ff" }],
  [{ pi: "AA:BB:CC:DD:EE:FF" }, { [DeviceInfo.OUTPUT_DEVICE_ID]: "AA:BB:CC:DD:EE:FF" }],
  [
    { psi: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", pi: "AA:BB:CC:DD:EE:FF" },
    { [DeviceInfo.OUTPUT_DEVICE_ID]: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" },
  ],
] as Array<[Record<string, string>, Record<string, unknown>]>)("device info %#", (properties, expected) => {
  expect(deviceInfo("_dummy._tcp.local", properties)).toEqual(expected);
});

test.each([
  [{}, {}, false],
  [{}, { pw: "true" }, false],
  [{ pw: "true" }, {}, true],
  [{ pw: "TRUE" }, {}, true],
  [{ sf: "0x80" }, {}, true],
  [{}, { sf: "0x80" }, false],
  [{ flags: "0x80" }, {}, true],
  [{}, { flags: "0x80" }, false],
] as Array<[Record<string, string>, Record<string, string>, boolean]>)(
  "service info password %#",
  async (airplayProps, mrpProps, requiresPassword) => {
    const airplayService = new MutableService("id", Protocol.AirPlay, 0, airplayProps);
    const mrpService = new MutableService("mrp", Protocol.MRP, 0, mrpProps);
    expect(airplayService.requiresPassword).toBe(false);
    expect(mrpService.requiresPassword).toBe(false);

    await serviceInfo(airplayService, new DeviceInfo({}), new Map([[Protocol.MRP, mrpService], [Protocol.AirPlay, airplayService]]));

    expect(airplayService.requiresPassword).toBe(requiresPassword);
    expect(mrpService.requiresPassword).toBe(false);
  },
);

test.each([
  [{ sf: "0x0" }, {}, PairingRequirement.NotNeeded],
  [{ sf: "0x8" }, {}, PairingRequirement.Mandatory],
  [{ sf: "0x200" }, {}, PairingRequirement.Mandatory],
  [{ flags: "0x200" }, {}, PairingRequirement.Mandatory],
  [{ acl: "1" }, {}, PairingRequirement.Disabled],
  [{ acl: "1", sf: "0x200" }, {}, PairingRequirement.Disabled],
  [{ model: "Mac10,1" }, {}, PairingRequirement.Unsupported],
] as Array<[Record<string, string>, Record<string, unknown>, PairingRequirement]>)(
  "service info pairing %#",
  async (airplayProps, devinfo, pairingReq) => {
    const airplayService = new MutableService("id", Protocol.AirPlay, 0, airplayProps);
    expect(airplayService.pairing).toBe(PairingRequirement.Unsupported);
    await serviceInfo(airplayService, new DeviceInfo(devinfo), new Map([[Protocol.AirPlay, airplayService]]));
    expect(airplayService.pairing).toBe(pairingReq);
  },
);

// AirPlayFeatures (test_airplay_interface.py)

test.each([
  ["0x0,0x0", FeatureState.Unavailable],
  ["0x1,0x0", FeatureState.Available], // VideoV1
  ["0x00000000,0x20000", FeatureState.Available], // VideoV2
] as Array<[string, FeatureState]>)("feature play url %s", (flags, expectedState) => {
  const features = new AirPlayFeatures(parseFeatures(flags));
  expect(features.getFeature(FeatureName.PlayUrl).state).toBe(expectedState);
});
