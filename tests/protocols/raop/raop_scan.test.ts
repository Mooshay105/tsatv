/** Functional tests for RAOP scanning. */

import { expect, test } from "bun:test";
import { Protocol } from "../../../src/const.ts";
import * as fakeUdns from "../../fake_udns.ts";
import { useUdnsServer } from "../../fixtures.ts";
import { assertDevice } from "../../utils.ts";

const IP_1 = "10.0.0.1";
const RAOP_ID = "AABBCCDDEEFF";
const RAOP_NAME = "RAOP ATV";
const RAOP_PORT = 4567;

const udns = useUdnsServer();

test("multicast scan raop device", async () => {
  udns.server.addService(fakeUdns.raopService(RAOP_NAME, RAOP_ID, { addresses: [IP_1], port: RAOP_PORT }));
  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, RAOP_NAME, IP_1, RAOP_ID, Protocol.RAOP, RAOP_PORT);
});

test("unicast scan raop", async () => {
  udns.server.addService(fakeUdns.raopService(RAOP_NAME, RAOP_ID, { addresses: [IP_1], port: RAOP_PORT }));
  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, RAOP_NAME, IP_1, RAOP_ID, Protocol.RAOP, RAOP_PORT);
});
