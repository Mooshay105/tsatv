/** Unit tests for pyatv.protocols.companion. */

import { expect, test } from "bun:test";
import { DeviceModel, PairingRequirement, Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import type * as mdns from "../../../src/core/mdns.ts";
import { DeviceInfo } from "../../../src/interface.ts";
import { deviceInfo, scan, serviceInfo } from "../../../src/protocols/companion/index.ts";

const COMPANION_SERVICE = "_companion-link._tcp.local";

test("companion scan handlers present", () => {
  const handlers = scan();
  expect(Object.keys(handlers).length).toBe(1);
  expect(Object.keys(handlers)).toContain(COMPANION_SERVICE);
});

test("companion handler to service", () => {
  const [handler] = scan()[COMPANION_SERVICE]!;
  const mdnsService: mdns.Service = { type: COMPANION_SERVICE, name: "foo", address: "127.0.0.1", port: 1234, properties: { foo: "bar" } };
  const [name, service] = handler(mdnsService, { services: [], deepSleep: false, model: null })!;
  expect(name).toBe("foo");
  expect(service.port).toBe(1234);
  expect(service.credentials).toBeNull();
  expect(service.properties).toEqual({ foo: "bar" });
});

test("companion device info name", () => {
  const [, deviceInfoName] = scan()[COMPANION_SERVICE]!;
  expect(deviceInfoName("Ohana")).toBe("Ohana");
});

test.each([
  [{ rpmd: "unknown" }, { [DeviceInfo.RAW_MODEL]: "unknown" }],
  [{ rpmd: "AppleTV6,2" }, { [DeviceInfo.MODEL]: DeviceModel.Gen4K, [DeviceInfo.RAW_MODEL]: "AppleTV6,2" }],
] as Array<[Record<string, string>, Record<string, unknown>]>)("device info %#", (properties, expected) => {
  expect(deviceInfo("_dummy._tcp.local", properties)).toEqual(expected);
});

test.each([
  [{}, PairingRequirement.Unsupported],
  [{ rpfl: "0x627B6" }, PairingRequirement.Disabled],
  [{ rpfl: "0x36782" }, PairingRequirement.Mandatory],
  [{ rpfl: "0x0" }, PairingRequirement.Unsupported],
] as Array<[Record<string, string>, PairingRequirement]>)("service info pairing %p", async (properties, expected) => {
  const service = new MutableService(null, Protocol.Companion, 0, properties);
  expect(service.pairing).toBe(PairingRequirement.Unsupported);
  await serviceInfo(service, new DeviceInfo({}), new Map([[Protocol.Companion, service]]));
  expect(service.pairing).toBe(expected);
});
