/** Scanning tests with fake mDNS responder. */

import { expect, test } from "bun:test";
import { Protocol } from "../../../src/const.ts";
import * as fakeUdns from "../../fake_udns.ts";
import { useUdnsServer } from "../../fixtures.ts";
import { assertDevice } from "../../utils.ts";

const IP_1 = "10.0.0.1";
const AIRPLAY_NAME = "AirPlay ATV";
const AIRPLAY_ID = "AA:BB:CC:DD:EE:FF";

const udns = useUdnsServer();

test("multicast scan airplay device", async () => {
  udns.server.addService(fakeUdns.airplayService(AIRPLAY_NAME, AIRPLAY_ID, { addresses: [IP_1] }));
  const atvs = await udns.multicastScan();
  expect(atvs.length).toBe(1);
  expect(atvs[0]!.name).toBe(AIRPLAY_NAME);
  expect(atvs[0]!.identifier).toBe(AIRPLAY_ID);
  expect(atvs[0]!.address).toBe(IP_1);
});

test("unicast scan airplay", async () => {
  udns.server.addService(fakeUdns.airplayService(AIRPLAY_NAME, AIRPLAY_ID, { addresses: [IP_1], port: 7000 }));
  const atvs = await udns.unicastScan();
  expect(atvs.length).toBe(1);
  assertDevice(atvs[0]!, AIRPLAY_NAME, IP_1, AIRPLAY_ID, Protocol.AirPlay, 7000);
});
