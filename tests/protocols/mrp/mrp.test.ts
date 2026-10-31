/** Unit tests for pyatv.protocols.mrp. */

import { describe, expect, test } from "bun:test";
import { OperatingSystem, PairingRequirement, PowerState, Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import type * as mdns from "../../../src/core/mdns.ts";
import { DeviceInfo } from "../../../src/interface.ts";
import { deviceInfo, powerStateFromDeviceInfo, scan, serviceInfo } from "../../../src/protocols/mrp/index.ts";
import * as messages from "../../../src/protocols/mrp/messages.ts";
import * as pb from "../../../src/protocols/mrp/protobuf/index.ts";
import { InfoSettings } from "../../../src/settings.ts";

const MRP_SERVICE = "_mediaremotetv._tcp.local";

test("mrp scan handlers present", () => {
  const handlers = scan();
  expect(Object.keys(handlers).length).toBe(1);
  expect(Object.keys(handlers)).toContain(MRP_SERVICE);
});

test("mrp handler to service", () => {
  const [handler] = scan()[MRP_SERVICE]!;
  const mdnsService: mdns.Service = { type: MRP_SERVICE, name: "foo", address: "127.0.0.1", port: 1234, properties: { Name: "test" } };
  const [name, service] = handler(mdnsService, { services: [], deepSleep: false, model: null })!;
  expect(name).toBe("test");
  expect(service.port).toBe(1234);
  expect(service.credentials).toBeNull();
  expect(service.properties).toEqual({ Name: "test" });
});

test("mrp device info name", () => {
  const [, deviceInfoName] = scan()[MRP_SERVICE]!;
  expect(deviceInfoName("Ohana")).toBe("Ohana");
});

test.each([
  [{ systembuildversion: "unknown" }, { [DeviceInfo.BUILD_NUMBER]: "unknown", [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS }],
  [
    { systembuildversion: "18M60" },
    { [DeviceInfo.BUILD_NUMBER]: "18M60", [DeviceInfo.VERSION]: "14.7", [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS },
  ],
  [{ macaddress: "aa:bb:cc:dd:ee:ff" }, { [DeviceInfo.MAC]: "aa:bb:cc:dd:ee:ff", [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS }],
] as Array<[Record<string, string>, Record<string, unknown>]>)("device info %#", (properties, expected) => {
  expect(deviceInfo("_dummy._tcp.local", properties)).toEqual(expected);
});

test.each([
  [{}, {}, PairingRequirement.Disabled],
  [{}, { allowpairing: "YES" }, PairingRequirement.Disabled],
  [{ allowpairing: "yes" }, {}, PairingRequirement.Optional],
  [{ allowpairing: "YES" }, {}, PairingRequirement.Optional],
  [{ allowpairing: "no" }, {}, PairingRequirement.Disabled],
] as Array<[Record<string, string>, Record<string, string>, PairingRequirement]>)(
  "service info pairing %#",
  async (mrpProps, airplayProps, pairingReq) => {
    const mrpService = new MutableService("mrp", Protocol.MRP, 0, mrpProps);
    const airplayService = new MutableService("id", Protocol.AirPlay, 0, airplayProps);
    expect(mrpService.pairing).toBe(PairingRequirement.Unsupported);
    expect(airplayService.pairing).toBe(PairingRequirement.Unsupported);
    await serviceInfo(mrpService, new DeviceInfo({}), new Map([[Protocol.MRP, mrpService], [Protocol.AirPlay, airplayService]]));
    expect(mrpService.pairing).toBe(pairingReq);
    expect(airplayService.pairing).toBe(PairingRequirement.Unsupported);
  },
);

test("disabled service no pairing", async () => {
  const mrpService = new MutableService("mrp", Protocol.MRP, 0, {}, null, null, false);
  const airplayService = new MutableService("id", Protocol.AirPlay, 0, { allowpairing: "no" });
  await serviceInfo(mrpService, new DeviceInfo({}), new Map([[Protocol.MRP, mrpService], [Protocol.AirPlay, airplayService]]));
  expect(mrpService.pairing).toBe(PairingRequirement.NotNeeded);
});

describe("power state from device info", () => {
  const OWN_UID = "own-uid";

  function deviceInfoMessage(fields: Partial<pb.DeviceInfoMessage>): pb.ProtocolMessage {
    const msg = messages.deviceInformation(new InfoSettings(), OWN_UID);
    const inner = pb.extractInner(msg) as pb.DeviceInfoMessage;
    inner.deviceUID = OWN_UID;
    Object.assign(inner, fields);
    return msg;
  }

  test("no message", () => expect(powerStateFromDeviceInfo(null)).toBe(PowerState.Unknown));
  test("logical devices", () => {
    expect(powerStateFromDeviceInfo(deviceInfoMessage({ logicalDeviceCount: 1 }))).toBe(PowerState.On);
  });
  test("no logical devices", () => {
    expect(powerStateFromDeviceInfo(deviceInfoMessage({ logicalDeviceCount: 0 }))).toBe(PowerState.Off);
  });
  test("stereo pair leader playing over AirPlay", () => {
    const msg = deviceInfoMessage({ logicalDeviceCount: 0, isAirplayActive: true });
    expect(powerStateFromDeviceInfo(msg)).toBe(PowerState.On);
  });
  test("stereo pair leader", () => {
    const msg = deviceInfoMessage({ logicalDeviceCount: 0, isClusterAware: true, clusterLeaderID: OWN_UID });
    expect(powerStateFromDeviceInfo(msg)).toBe(PowerState.On);
  });
  test("stereo pair member that is not leader", () => {
    const msg = deviceInfoMessage({ logicalDeviceCount: 0, isClusterAware: true, clusterLeaderID: "other" });
    expect(powerStateFromDeviceInfo(msg)).toBe(PowerState.Off);
  });
});
