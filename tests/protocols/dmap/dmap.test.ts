/** Unit tests for pyatv.protocols.dmap. */

import { expect, test } from "bun:test";
import { DeviceModel, OperatingSystem, PairingRequirement, Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import type * as mdns from "../../../src/core/mdns.ts";
import { DeviceInfo } from "../../../src/interface.ts";
import { deviceInfo, scan, serviceInfo } from "../../../src/protocols/dmap/index.ts";

const HOMESHARING_SERVICE = "_appletv-v2._tcp.local";
const DMAP_SERVICE = "_touch-able._tcp.local";
const HSCP_SERVICE = "_hscp._tcp.local";

const response = (): mdns.Response => ({ services: [], deepSleep: false, model: null });

test("dmap scan handlers present", () => {
  const handlers = scan();
  expect(Object.keys(handlers).length).toBe(3);
  expect(Object.keys(handlers)).toContain(HOMESHARING_SERVICE);
  expect(Object.keys(handlers)).toContain(DMAP_SERVICE);
  expect(Object.keys(handlers)).toContain(HSCP_SERVICE);
});

test("homesharing handler to service", () => {
  const [handler] = scan()[HOMESHARING_SERVICE]!;
  const mdnsService: mdns.Service = { type: HOMESHARING_SERVICE, name: "foo", address: "127.0.0.1", port: 1234, properties: { Name: "bar" } };
  const [name, service] = handler(mdnsService, response())!;
  expect(name).toBe("bar");
  expect(service.port).toBe(1234);
  expect(service.credentials).toBeNull();
  expect(service.properties).toEqual({ Name: "bar" });
});

test("homesharing device info name", () => {
  const [, deviceInfoName] = scan()[HOMESHARING_SERVICE]!;
  expect(deviceInfoName("ANY")).toBeNull();
});

test("dmap handler to service", () => {
  const [handler] = scan()[DMAP_SERVICE]!;
  const mdnsService: mdns.Service = { type: DMAP_SERVICE, name: "foo", address: "127.0.0.1", port: 1234, properties: { CtlN: "bar" } };
  const [name, service] = handler(mdnsService, response())!;
  expect(name).toBe("bar");
  expect(service.port).toBe(1234);
  expect(service.credentials).toBeNull();
  expect(service.properties).toEqual({ CtlN: "bar" });
});

test("dmap device info name", () => {
  const [, deviceInfoName] = scan()[DMAP_SERVICE]!;
  expect(deviceInfoName("ANY")).toBeNull();
});

test.each([
  ["_foo._tcp.local", {}, { [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.Legacy }],
  ["_hscp._tcp.local", {}, { [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.Legacy, [DeviceInfo.MODEL]: DeviceModel.Music }],
])("device info %s", (serviceType, properties, expected) => {
  expect(deviceInfo(serviceType, properties)).toEqual(expected);
});

test.each([
  [{}, {}, PairingRequirement.Mandatory],
  [{ hg: "test" }, {}, PairingRequirement.Optional],
  [{}, { hg: "test" }, PairingRequirement.Mandatory],
] as Array<[Record<string, string>, Record<string, string>, PairingRequirement]>)(
  "service info pairing %#",
  async (dmapProps, mrpProps, pairingReq) => {
    const dmapService = new MutableService("id", Protocol.DMAP, 0, dmapProps);
    const mrpService = new MutableService("mrp", Protocol.MRP, 0, mrpProps);
    expect(dmapService.pairing).toBe(PairingRequirement.Unsupported);
    expect(mrpService.pairing).toBe(PairingRequirement.Unsupported);
    await serviceInfo(dmapService, new DeviceInfo({}), new Map([[Protocol.MRP, mrpService], [Protocol.DMAP, dmapService]]));
    expect(dmapService.pairing).toBe(pairingReq);
    expect(mrpService.pairing).toBe(PairingRequirement.Unsupported);
  },
);
