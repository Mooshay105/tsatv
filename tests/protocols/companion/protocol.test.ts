/** Unit tests for pyatv.protocols.companion.protocol. */

import { expect, test } from "bun:test";
import { SRPAuthHandler } from "../../../src/auth/hap_srp.ts";
import { Protocol } from "../../../src/const.ts";
import { MutableService } from "../../../src/core/index.ts";
import { FrameType } from "../../../src/protocols/companion/connection.ts";
import { CompanionProtocol } from "../../../src/protocols/companion/protocol.ts";
import * as opack from "../../../src/support/opack.ts";

class FakeConnection {
  sent: Array<[FrameType, Buffer]> = [];
  setListener(): void {}
  send(frameType: FrameType, data: Buffer): void {
    this.sent.push([frameType, data]);
  }
  close(): void {}
}

function createProtocol(): [CompanionProtocol, FakeConnection] {
  const connection = new FakeConnection();
  const service = new MutableService(null, Protocol.Companion, 0, {});
  return [new CompanionProtocol(connection as any, new SRPAuthHandler(), service), connection];
}

const queueSize = (protocol: CompanionProtocol) => (protocol as any)._queues.size as number;

test("context is freed when request times out (pyatv #1806)", async () => {
  const [protocol] = createProtocol();
  await expect(protocol.exchangeOpack(FrameType.E_OPACK, { _i: "test" }, 0.01)).rejects.toThrow();
  expect(queueSize(protocol)).toBe(0);
});

test("context is freed after response", async () => {
  const [protocol, connection] = createProtocol();
  const pending = protocol.exchangeOpack(FrameType.E_OPACK, { _i: "test" }, 1);
  const [request] = opack.unpack(connection.sent[0]![1]);
  protocol.frameReceived(FrameType.E_OPACK, opack.pack({ _t: 3, _x: request._x, _c: { ok: true } }));
  expect((await pending)._c).toEqual({ ok: true });
  expect(queueSize(protocol)).toBe(0);
});
