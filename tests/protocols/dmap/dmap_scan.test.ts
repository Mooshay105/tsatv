/** Functional tests for DMAP scan. */

import { expect, test } from "bun:test";
import { Protocol } from "../../../src/const.ts";
import * as fakeUdns from "../../fake_udns.ts";
import { useUdnsServer } from "../../fixtures.ts";
import { assertDevice } from "../../utils.ts";

const IP_1 = "10.0.0.1";
const DMAP_SERVICE_NAME = "DMAP service";
const DMAP_NAME = "DMAP ATV";
const DMAP_HSGID = "hsgid";

const udns = useUdnsServer();

test("multicast scan home sharing merge", async () => {
  udns.server.addService(fakeUdns.deviceService(DMAP_SERVICE_NAME, DMAP_NAME, { addresses: [IP_1] }));
  udns.server.addService(fakeUdns.homesharingService(DMAP_SERVICE_NAME, DMAP_NAME, DMAP_HSGID, { addresses: [IP_1] }));
  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, DMAP_NAME, IP_1, DMAP_SERVICE_NAME, Protocol.DMAP, 3689, DMAP_HSGID);
});

test("multicast scan hscp device", async () => {
  udns.server.addService(fakeUdns.hscpService(DMAP_NAME, DMAP_SERVICE_NAME, DMAP_HSGID, { addresses: [IP_1], port: 3689 }));
  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, DMAP_NAME, IP_1, DMAP_SERVICE_NAME, Protocol.DMAP, 3689, DMAP_HSGID);
});

test("unicast scan homesharing", async () => {
  udns.server.addService(fakeUdns.homesharingService(DMAP_SERVICE_NAME, DMAP_NAME, DMAP_HSGID, { addresses: [IP_1] }));
  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, DMAP_NAME, IP_1, DMAP_SERVICE_NAME, Protocol.DMAP, 3689, DMAP_HSGID);
});

test("unicast scan no homesharing", async () => {
  udns.server.addService(fakeUdns.deviceService(DMAP_SERVICE_NAME, DMAP_NAME, { addresses: [IP_1] }));
  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, DMAP_NAME, IP_1, DMAP_SERVICE_NAME, Protocol.DMAP, 3689);
});

test("unicast scan hscp device", async () => {
  udns.server.addService(fakeUdns.hscpService(DMAP_NAME, DMAP_SERVICE_NAME, DMAP_HSGID, { addresses: [IP_1], port: 3689 }));
  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, DMAP_NAME, IP_1, DMAP_SERVICE_NAME, Protocol.DMAP, 3689, DMAP_HSGID);
});
