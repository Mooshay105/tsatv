/** Unit tests for pyatv.core.protocol. */

import { afterEach, expect, mock, test } from "bun:test";
import { heartbeater, MessageDispatcher } from "../../src/core/protocol.ts";
import { Event } from "../../src/support/asyncio.ts";
import { totalSleepTime, until } from "../utils.ts";

// heartbeat

class HeartbeatMonitor {
  task: Promise<void> | null = null;
  controller = new AbortController();
  sendCallCount = 0;
  sendEvent = new Event();
  sendMessage: unknown = null;
  finishCalled = false;
  failureCalled = false;
  makeSendFail = false;

  start(messageFactory: (() => unknown) | null = null, retries = 0, interval = 5): void {
    this.task = heartbeater("name", (m) => this.send(m), {
      finishFunc: () => (this.finishCalled = true),
      failureFunc: () => (this.failureCalled = true),
      messageFactory: messageFactory ?? (() => null),
      retries,
      interval,
      signal: this.controller.signal,
    });
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.sendEvent.set();
    await this.task;
  }

  nextLap(): void {
    this.sendEvent.set();
  }

  async send(message: unknown): Promise<void> {
    this.sendCallCount += 1;
    this.sendMessage = message;
    if (this.makeSendFail) throw new Error("send failed");
    await this.sendEvent.wait();
    this.sendEvent.clear();
  }
}

let monitor: HeartbeatMonitor;

afterEach(async () => {
  await monitor?.stop();
});

test("send heartbeats", async () => {
  monitor = new HeartbeatMonitor();
  monitor.start();
  for (let lap = 1; lap < 4; lap++) {
    await until(() => monitor.sendCallCount === lap);
    monitor.nextLap();
  }
});

test("failure called on send error", async () => {
  monitor = new HeartbeatMonitor();
  monitor.makeSendFail = true;
  monitor.start();
  await until(() => monitor.failureCalled);
  expect(monitor.sendCallCount).toBe(1);
});

test("finish called on cancel", async () => {
  monitor = new HeartbeatMonitor();
  monitor.start();
  await until(() => monitor.sendCallCount === 1);
  await monitor.stop();
  await until(() => monitor.finishCalled);
  expect(monitor.failureCalled).toBe(false);
});

test("retry before failure", async () => {
  monitor = new HeartbeatMonitor();
  monitor.makeSendFail = true;
  monitor.start(null, 3, 5);
  await until(() => monitor.sendCallCount === 4);
  expect(monitor.failureCalled).toBe(true);
  expect(monitor.finishCalled).toBe(false);
});

test("sleep between send", async () => {
  monitor = new HeartbeatMonitor();
  monitor.start(null, 0, 5);
  await until(() => monitor.sendCallCount === 1);
  expect(totalSleepTime()).toBeCloseTo(5);
  monitor.nextLap();
  await until(() => monitor.sendCallCount === 2);
  expect(totalSleepTime()).toBeCloseTo(10);
});

test("no sleep for first retry", async () => {
  monitor = new HeartbeatMonitor();
  monitor.makeSendFail = true;
  monitor.start(null, 1, 5);
  await until(() => monitor.sendCallCount === 2);
  monitor.nextLap();
  await until(() => monitor.failureCalled);
  expect(totalSleepTime()).toBeCloseTo(5);
});

test("message is passed to send", async () => {
  monitor = new HeartbeatMonitor();
  const message = {};
  monitor.start(() => message);
  await until(() => monitor.sendCallCount === 1);
  expect(monitor.sendMessage).toBe(message);
});

// MessageDispatcher

test("simple dispatch", async () => {
  const func1 = mock(async (_message: Buffer) => undefined);
  const func2 = mock((_message: Buffer) => undefined);
  const dispatcher = new MessageDispatcher<number, Buffer>();
  dispatcher.listenTo(1, func1);
  dispatcher.listenTo(2, func2);

  await Promise.all(dispatcher.dispatch(1, Buffer.from("123")));
  expect(func1).toHaveBeenCalledTimes(1);
  expect(func1).toHaveBeenCalledWith(Buffer.from("123"));

  await Promise.all(dispatcher.dispatch(2, Buffer.from("456")));
  expect(func1).toHaveBeenCalledTimes(1);
  expect(func2).toHaveBeenCalledWith(Buffer.from("456"));
});

test("dispatch with filter", async () => {
  let dispatched = null as number | null;
  const dispatcher = new MessageDispatcher<number, number>();
  dispatcher.listenTo(
    1,
    async (value) => {
      dispatched = value;
    },
    (message) => message % 2 === 0,
  );
  await Promise.all(dispatcher.dispatch(1, 1));
  expect(dispatched).toBeNull();
  await Promise.all(dispatcher.dispatch(1, 2));
  expect(dispatched).toBe(2);
});
