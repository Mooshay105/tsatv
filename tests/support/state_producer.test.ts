import { expect, test } from "bun:test";
import { StateProducer } from "../../src/support/state_producer.ts";

class DummyStateProducer extends StateProducer<any> {
  stateWasUpdatedCalled = false;

  override stateWasUpdated(): void {
    this.stateWasUpdatedCalled = true;
  }
}

class DummyListener {
  fooCalled = false;
  fooCalls = 0;

  foo(): void {
    this.fooCalled = true;
    this.fooCalls += 1;
  }

  bar(): void {
    throw new Error("error");
  }
}

test("call to unknown method does nothing", () => {
  const producer = new StateProducer<any>();
  producer.listener.missing();
});

test("call to existing method", () => {
  const listener = new DummyListener();
  const producer = new StateProducer<DummyListener>();
  producer.listener = listener;
  producer.listener.foo();
  expect(listener.fooCalled).toBe(true);
});

test("call to removed listener does nothing", () => {
  const listener = new DummyListener();
  const producer = new StateProducer<DummyListener>();
  producer.listener = listener;
  producer.listener = null;
  producer.listener.bar();
});

test("call ignore max count", () => {
  const listener = new DummyListener();
  const producer = new StateProducer<DummyListener>(2);
  producer.listener = listener;
  producer.listener.foo();
  expect(listener.fooCalls).toBe(1);
  producer.listener.foo();
  expect(listener.fooCalls).toBe(2);
  producer.listener.foo();
  expect(listener.fooCalls).toBe(2);
});

test("call state was updated after update no listener", () => {
  const producer = new DummyStateProducer();
  producer.listener.missing();
  expect(producer.stateWasUpdatedCalled).toBe(true);
  producer.stateWasUpdatedCalled = false;
  producer.listener.foo();
  expect(producer.stateWasUpdatedCalled).toBe(true);
});

test("call state was updated after update with listener", () => {
  const listener = new DummyListener();
  const producer = new DummyStateProducer();
  producer.listener = listener;
  producer.listener.missing();
  expect(producer.stateWasUpdatedCalled).toBe(false);
  producer.listener.foo();
  expect(producer.stateWasUpdatedCalled).toBe(true);
});

test("inline listener is not garbage collected", async () => {
  const producer = new StateProducer<DummyListener>();
  const calls: string[] = [];
  // No other reference to the listener object is kept (pyatv #2853 hardware test)
  producer.listener = {
    fooCalled: false,
    fooCalls: 0,
    barCalled: false,
    foo() {
      calls.push("foo");
    },
  } as unknown as DummyListener;

  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    await Bun.sleep(1);
  }
  producer.listener.foo();
  expect(calls).toEqual(["foo"]);
});
