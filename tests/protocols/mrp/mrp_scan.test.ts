/** Functional tests for MRP scanning. */

import { expect, test } from "bun:test";
import { Protocol } from "../../../src/const.ts";
import * as fakeUdns from "../../fake_udns.ts";
import { useUdnsServer } from "../../fixtures.ts";
import { assertDevice } from "../../utils.ts";

const IP_1 = "10.0.0.1";
const MRP_ID = "mrp_id_1";
const MRP_NAME = "MRP ATV";
const MRP_SERVICE_NAME = "MRP Service";
const MRP_PORT = 49152;

const udns = useUdnsServer();

test("multicast scan mrp", async () => {
  udns.server.addService(fakeUdns.mrpService(MRP_SERVICE_NAME, MRP_NAME, MRP_ID, { addresses: [IP_1], port: MRP_PORT }));
  const atvs = await udns.multicastScan({ protocol: Protocol.MRP });
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, MRP_NAME, IP_1, MRP_ID, Protocol.MRP, MRP_PORT);
});

test("unicast scan mrp", async () => {
  udns.server.addService(fakeUdns.mrpService(MRP_SERVICE_NAME, MRP_NAME, MRP_ID, { addresses: [IP_1], port: MRP_PORT }));
  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, MRP_NAME, IP_1, MRP_ID, Protocol.MRP, MRP_PORT);
});
