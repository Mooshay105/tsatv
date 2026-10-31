/** Functional tests for Companion scanning. */

import { expect, test } from "bun:test";
import { Protocol } from "../../../src/const.ts";
import * as fakeUdns from "../../fake_udns.ts";
import { useUdnsServer } from "../../fixtures.ts";

const IP_1 = "10.0.0.1";
const COMPANION_NAME = "Companion";
const MRP_ID = "mrp_id_1";
const MRP_SERVICE_NAME = "MRP Service";
const COMPANION_PORT = 1234;

const udns = useUdnsServer();

test("multicast scan companion device", async () => {
  udns.server.addService(fakeUdns.companionService(COMPANION_NAME, { addresses: [IP_1], port: COMPANION_PORT }));
  expect((await udns.multicastScan()).length).toBe(0);
});

// Companion does not have a unique id we can use, so it's not possible to discover on
// its own. It needs another protocol with an identifier and MRP is borrowed here, but
// any other protocol would do as well.
test("multicast scan mrp with companion", async () => {
  udns.server.addService(fakeUdns.mrpService(MRP_SERVICE_NAME, COMPANION_NAME, MRP_ID, { addresses: [IP_1] }));
  udns.server.addService(fakeUdns.companionService(COMPANION_NAME, { addresses: [IP_1], port: COMPANION_PORT }));

  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);

  const dev = atvs[0]!;
  expect(dev.name).toBe(COMPANION_NAME);
  expect(dev.getService(Protocol.MRP)).toBeTruthy();

  const companion = dev.getService(Protocol.Companion);
  expect(companion).toBeTruthy();
  expect(companion!.port).toBe(COMPANION_PORT);
});

test("unicast scan companion", async () => {
  udns.server.addService(fakeUdns.companionService(COMPANION_NAME, { addresses: [IP_1], port: COMPANION_PORT }));
  expect((await udns.unicastScan()).length).toBe(0);
});
