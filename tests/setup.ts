/** Global test setup (equivalent of autouse fixtures in conftest.py). */

import { afterEach, beforeEach, spyOn } from "bun:test";
import * as net from "../src/support/net.ts";
import { setDefaultHandlerEnabled } from "../src/support/logging.ts";
import { mrpProtocolHooks } from "../src/protocols/mrp/protocol.ts";
import { getLogger } from "../src/support/logging.ts";
import { stubSleep, unstubSleep } from "./utils.ts";
import { airplaySrpHooks } from "../src/protocols/airplay/srp.ts";
import { parseCredentials } from "../src/auth/hap_pairing.ts";
import { DEVICE_CREDENTIALS } from "./fake_device/airplay.ts";

process.env.PYATV_TESTING = "1";
setDefaultHandlerEnabled(Boolean(process.env.PYATV_TEST_LOG));

type Restorable = { mockRestore(): void };
export const autouseSpies: Restorable[] = [];
export const autouseHooks: { before: Array<() => void>; after: Array<() => void> } = { before: [], after: [] };

/**
 * The heartbeat loop uses sleep between each heartbeat, which causes a hogging loop
 * in tests since sleep is stubbed. So heartbeats are always stubbed unless a test
 * calls useHeartbeat() (equivalent of the use_heartbeat marker in pytest).
 */
let heartbeatSpy: Restorable | null = null;
export function useHeartbeat(): void {
  heartbeatSpy?.mockRestore();
  heartbeatSpy = null;
}

beforeEach(() => {
  autouseSpies.push(
    spyOn(net, "getAdapters").mockImplementation(() => [
      net.makeAdapter("eth0", [["10.0.10.1", 24]]),
      net.makeAdapter("lo", [["127.0.0.1", 8]]),
    ]),
  );
  stubSleep();
  heartbeatSpy = spyOn(mrpProtocolHooks, "heartbeater").mockImplementation(async () => {
    getLogger("tests").debug("Using stub for heartbeat");
  });
  // Always use the same (captured) credentials for legacy AirPlay auth
  autouseSpies.push(spyOn(airplaySrpHooks, "newCredentials").mockImplementation(() => parseCredentials(DEVICE_CREDENTIALS)));
  for (const hook of autouseHooks.before) hook();
});

afterEach(() => {
  for (const hook of autouseHooks.after) hook();
  while (autouseSpies.length > 0) autouseSpies.pop()!.mockRestore();
  heartbeatSpy?.mockRestore();
  heartbeatSpy = null;
  unstubSleep();
});
