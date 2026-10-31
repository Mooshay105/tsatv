/**
 * Functional tests for scanning.
 *
 * The tests here are supposed to cover non-protocol specific aspects of scanning, like
 * scanning for a specific device or derive device model. Two "generic" protocols (MRP
 * and AirPlay) have been arbitrarily chosen to have something to test with (could have
 * been other protocols). They are just called "service1" and "service2" to emphasize
 * that the specific protocols are irrelevant. Later, service3 was added as well...
 */

import { expect, test } from "bun:test";
import { DeviceModel, Protocol } from "../src/const.ts";
import * as fakeUdns from "./fake_udns.ts";
import { useUdnsServer } from "./fixtures.ts";

const SERVICE_1_ID = "mrp_id_1";
const SERVICE_1_NAME = "MRP ATV";
const SERVICE_1_SERVICE_NAME = "MRP Service";
const SERVICE_1_IP = "10.0.0.1";

const SERVICE_2_ID = "AA:BB:CC:DD:EE:FF";
const SERVICE_2_NAME = "AirPlay ATV";
const SERVICE_2_IP = "10.0.0.2";

const SERVICE_3_ID = "raopid";
const SERVICE_3_NAME = "AirPlay ATV";

const DEFAULT_KNOCK_PORTS = new Set([3689, 7000, 49152, 32498]);

const udns = useUdnsServer();

const service1 = (model: string | null = null) =>
  fakeUdns.mrpService(SERVICE_1_SERVICE_NAME, SERVICE_1_NAME, SERVICE_1_ID, { addresses: [SERVICE_1_IP], model });

const service2 = (address = SERVICE_1_IP) => fakeUdns.airplayService(SERVICE_2_NAME, SERVICE_2_ID, { addresses: [address] });

const service3 = () => fakeUdns.raopService(SERVICE_3_NAME, SERVICE_3_ID, { addresses: [SERVICE_1_IP], port: 5000 });

const mrpServiceTvos15 = () =>
  fakeUdns.mrpService(SERVICE_1_SERVICE_NAME, SERVICE_1_NAME, SERVICE_1_ID, { addresses: [SERVICE_1_IP], version: "19J346" });

test("multicast scan no device found", async () => {
  expect((await udns.multicastScan()).length).toBe(0);
});

test("multicast scan for particular device", async () => {
  udns.server.addService(service1());
  udns.server.addService(service2(SERVICE_1_IP));
  udns.server.addService(service3());

  const atvs = await udns.multicastScan({ identifier: new Set([SERVICE_1_ID, SERVICE_2_ID]) });
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.name).toBe(SERVICE_2_NAME);
});

test("multicast scan for specific devices", async () => {
  udns.server.addService(service1());
  udns.server.addService(service2(SERVICE_2_IP));

  const atvs = await udns.multicastScan({ identifier: SERVICE_2_ID });
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.name).toBe(SERVICE_2_NAME);
  expect(atvs[0]!.address).toBe(SERVICE_2_IP);
});

test("multicast scan deep sleeping device", async () => {
  udns.server.sleepProxy = true;
  udns.server.addService(service1());

  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.deepSleep).toBe(true);
});

test("multicast scan device info", async () => {
  udns.server.addService(service1());
  udns.server.addService(service2());

  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.deviceInfo.mac).toBe(SERVICE_2_ID);
});

test("multicast scan device model", async () => {
  udns.server.addService(service1("J105aAP"));

  const atvs = await udns.multicastScan({ protocol: Protocol.MRP });
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.deviceInfo.model).toBe(DeviceModel.Gen4K);
});

test("multicast filter multiple protocols", async () => {
  udns.server.addService(service1());
  udns.server.addService(service2());
  udns.server.addService(service3());

  const atvs = await udns.multicastScan({ protocol: new Set([Protocol.MRP, Protocol.RAOP]) });
  expect(atvs.length).toBe(1);

  const atv = atvs[0]!;
  expect(atv.services.length).toBe(2);
  expect(atv.getService(Protocol.MRP)).not.toBeNull();
  expect(atv.getService(Protocol.RAOP)).not.toBeNull();
});

test("multicast mrp tvos15 disabled", async () => {
  udns.server.addService(mrpServiceTvos15());

  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.getService(Protocol.MRP)!.enabled).toBe(false);
});

test("unicast scan no results", async () => {
  expect((await udns.unicastScan()).length).toBe(0);
});

// pyatv adds a FakeDnsService directly here (which ends up as a service of type
// "dummy"), i.e. nothing that will be found by scanning
test("unicast missing port", async () => {
  udns.server.addService(["dummy", SERVICE_1_IP as unknown as fakeUdns.FakeDnsService]);
  expect((await udns.unicastScan()).length).toBe(0);
});

test("unicast missing properties", async () => {
  udns.server.addService(["dummy", SERVICE_1_IP as unknown as fakeUdns.FakeDnsService]);
  expect((await udns.unicastScan()).length).toBe(0);
});

test("unicast scan device info", async () => {
  udns.server.addService(service1());
  udns.server.addService(service2());

  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.deviceInfo.mac).toBe(SERVICE_2_ID);
});

test("unicast scan device model", async () => {
  udns.server.addService(service1("J105aAP"));

  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.deviceInfo.model).toBe(DeviceModel.Gen4K);
});

test("unicast scan port knock", async () => {
  await udns.unicastScan();
  expect(udns.knockInfo.ports).toEqual(DEFAULT_KNOCK_PORTS);
  expect(udns.knockInfo.knockCount).toBe(1);
});

test("unicast filter multiple protocols", async () => {
  udns.server.addService(service1());
  udns.server.addService(service2());
  udns.server.addService(service3());

  const atvs = await udns.unicastScan({ protocol: new Set([Protocol.MRP, Protocol.RAOP]) });
  expect(atvs.length).toBe(1);

  const atv = atvs[0]!;
  expect(atv.services.length).toBe(2);
  expect(atv.getService(Protocol.MRP)).not.toBeNull();
  expect(atv.getService(Protocol.RAOP)).not.toBeNull();
});

test("unicast mrp tvos15 disabled", async () => {
  udns.server.addService(mrpServiceTvos15());

  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.getService(Protocol.MRP)!.enabled).toBe(false);
});
