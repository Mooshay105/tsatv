/** Unit tests for pyatv.protocols.raop. */

import { expect, test } from "bun:test";
import { DeviceModel, OperatingSystem, PairingRequirement, Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import type * as mdns from "../../../src/core/mdns.ts";
import { DeviceInfo } from "../../../src/interface.ts";
import { deviceInfo, scan, serviceInfo } from "../../../src/protocols/raop/index.ts";

const RAOP_SERVICE = "_raop._tcp.local";
const AIRPORT_SERVICE = "_airport._tcp.local";

const mdnsService: mdns.Service = { type: RAOP_SERVICE, name: "foo@bar", address: "127.0.0.1", port: 1234, properties: { foo: "bar" } };
const mdnsResponse: mdns.Response = { services: [], deepSleep: false, model: null };

test("raop scan handlers present", () => {
  const handlers = scan();
  expect(Object.keys(handlers).length).toBe(2);
  expect(Object.keys(handlers)).toContain(RAOP_SERVICE);
});

test("raop handler to service", () => {
  const [handler] = scan()[RAOP_SERVICE]!;
  const [name, service] = handler(mdnsService, mdnsResponse)!;
  expect(name).toBe("bar");
  expect(service.port).toBe(1234);
  expect(service.credentials).toBeNull();
  expect(service.properties).toEqual({ foo: "bar" });
});

test("raop device info name", () => {
  const [, deviceInfoName] = scan()[RAOP_SERVICE]!;
  expect(deviceInfoName("ANY@Ohana")).toBe("Ohana");
});

test("airport handler", () => {
  const [handler] = scan()[AIRPORT_SERVICE]!;
  expect(handler(mdnsService, mdnsResponse)).toBeFalsy();
});

test("airport info name", () => {
  const [, deviceInfoName] = scan()[AIRPORT_SERVICE]!;
  expect(deviceInfoName("Ohana")).toBe("Ohana");
});

test.each([
  [{ am: "unknown" }, { [DeviceInfo.RAW_MODEL]: "unknown" }],
  [{ am: "AppleTV6,2" }, { [DeviceInfo.MODEL]: DeviceModel.Gen4K, [DeviceInfo.RAW_MODEL]: "AppleTV6,2" }],
  [{ am: "MacBookAir10,1" }, { [DeviceInfo.RAW_MODEL]: "MacBookAir10,1", [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.MacOS }],
  [{ ov: "14.7" }, { [DeviceInfo.VERSION]: "14.7" }],
  // Special case for resolving MAC address and version on AirPort Express
  [
    {
      wama:
        "AA-AA-AA-AA-AA-AA," +
        "raMA=BB-BB-BB-BB-BB-BB," +
        "raM2=CC-CC-CC-CC-CC-CC," +
        "raNm=MyWifi,raCh=1,rCh2=2," +
        "raSt=1,raNA=0,syFl=0x88C," +
        "syAP=115,syVs=7.8.1,srcv=78100.3,bjSd=2",
    },
    { [DeviceInfo.MAC]: "AA:AA:AA:AA:AA:AA", [DeviceInfo.VERSION]: "7.8.1" },
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
] as Array<[Record<string, string>, Record<string, string>, boolean]>)("service info password %#", async (raopProps, mrpProps, requiresPassword) => {
  const raopService = new MutableService("id", Protocol.RAOP, 0, raopProps);
  const mrpService = new MutableService("mrp", Protocol.MRP, 0, mrpProps);
  expect(raopService.requiresPassword).toBe(false);
  expect(mrpService.requiresPassword).toBe(false);

  await serviceInfo(raopService, new DeviceInfo({}), new Map([[Protocol.MRP, mrpService], [Protocol.RAOP, raopService]]));

  expect(raopService.requiresPassword).toBe(requiresPassword);
  expect(mrpService.requiresPassword).toBe(false);
});

test.each([
  [{ sf: "0x0" }, PairingRequirement.NotNeeded],
  [{ sf: "0x8" }, PairingRequirement.Mandatory],
  [{ sf: "0x200" }, PairingRequirement.Mandatory],
  [{ flags: "0x200" }, PairingRequirement.Mandatory],
] as Array<[Record<string, string>, PairingRequirement]>)("service info pairing %#", async (raopProps, pairingReq) => {
  const raopService = new MutableService("id", Protocol.RAOP, 0, raopProps);
  expect(raopService.pairing).toBe(PairingRequirement.Unsupported);
  await serviceInfo(raopService, new DeviceInfo({}), new Map([[Protocol.RAOP, raopService]]));
  expect(raopService.pairing).toBe(pairingReq);
});

test.each([
  [{ acl: "1" }, PairingRequirement.Disabled],
  [{ act: "2" }, PairingRequirement.Unsupported],
] as Array<[Record<string, string>, PairingRequirement]>)("service info pairing acl %#", async (props, pairingReq) => {
  const raopService = new MutableService("id", Protocol.RAOP, 0, {});
  const airplayService = new MutableService("id", Protocol.AirPlay, 0, props);
  await serviceInfo(raopService, new DeviceInfo({}), new Map([[Protocol.RAOP, raopService], [Protocol.AirPlay, airplayService]]));
  expect(raopService.pairing).toBe(pairingReq);
});
