/** Unittests for pyatv.protocols.mrp.protocol. */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { SRPAuthHandler } from "../../../src/auth/hap_srp.ts";
import { ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import { MrpConnection } from "../../../src/protocols/mrp/connection.ts";
import { HEARTBEAT_INTERVAL, HEARTBEAT_RETRIES, heartbeatLoop, MrpProtocol } from "../../../src/protocols/mrp/protocol.ts";
import { InfoSettings } from "../../../src/settings.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import "../../fake_device/mrp.ts";
import type { FakeMrpState } from "../../fake_device/mrp.ts";
import { useHeartbeat } from "../../setup.ts";
import { totalSleepTime, until } from "../../utils.ts";

let mrpAtv: FakeAppleTV;
let mrpProtocol: MrpProtocol;

beforeEach(async () => {
  mrpAtv = new FakeAppleTV();
  mrpAtv.addService(Protocol.MRP);
  await mrpAtv.start();
  const port = mrpAtv.getPort(Protocol.MRP);
  const service = new ManualService("mrp_id", Protocol.MRP, port, {});
  const connection = new MrpConnection("127.0.0.1", port);
  mrpProtocol = new MrpProtocol(connection, new SRPAuthHandler(), service, new InfoSettings());
});

afterEach(async () => {
  mrpProtocol.stop();
  await mrpAtv.stop();
});

test("heartbeat loop", async () => {
  useHeartbeat();
  await mrpProtocol.start();
  mrpProtocol.enableHeartbeat();

  const mrpState = mrpAtv.getState<FakeMrpState>(Protocol.MRP);
  await until(() => mrpState.heartbeatCount >= 3);
});

test("heartbeat fail closes connection", async () => {
  const protocol = {
    sendAndReceive: mock(async () => {
      throw new Error();
    }),
    connection: { close: mock(() => undefined) },
  };

  await heartbeatLoop(protocol);
  expect(protocol.sendAndReceive).toHaveBeenCalledTimes(1 + HEARTBEAT_RETRIES);
  expect(totalSleepTime()).toBe(HEARTBEAT_INTERVAL);
  expect(protocol.connection.close).toHaveBeenCalledTimes(1);
});
