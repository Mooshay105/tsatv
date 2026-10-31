/** Unit tests for pyatv.core. */

import { expect, mock, test } from "bun:test";
import { Protocol } from "../../src/const.ts";
import {
  AbstractPushUpdater,
  CoreStateDispatcher,
  ProtocolStateDispatcher,
  type StateMessage,
  UpdatedState,
} from "../../src/core/index.ts";
import { NotSupportedError } from "../../src/exceptions.ts";
import { Playing } from "../../src/interface.ts";

class PushUpdaterDummy extends AbstractPushUpdater {
  get active(): boolean {
    throw new NotSupportedError();
  }
  start(): void {
    throw new NotSupportedError();
  }
  stop(): void {
    throw new NotSupportedError();
  }
}

test.each([1, 2, 3])("post ignore duplicate update %p", async (updates) => {
  const stateDispatcher = new ProtocolStateDispatcher(Protocol.MRP, new CoreStateDispatcher());
  const listener = { playstatusUpdate: mock(() => undefined), stateUpdated: mock((_v: unknown) => undefined) };
  const playing = new Playing();

  stateDispatcher.listenTo(UpdatedState.Playing, (message: StateMessage) => {
    expect(message.protocol).toBe(Protocol.MRP);
    expect(message.state).toBe(UpdatedState.Playing);
    listener.stateUpdated(message.value);
  });

  const updater = new PushUpdaterDummy(stateDispatcher);
  updater.listener = listener as any;
  for (let i = 0; i < updates; i++) updater.postUpdate(playing);

  await new Promise((resolve) => setImmediate(resolve));

  expect(listener.playstatusUpdate).toHaveBeenCalledTimes(1);
  expect(listener.playstatusUpdate).toHaveBeenCalledWith(updater, playing);
  expect(listener.stateUpdated).toHaveBeenCalledTimes(1);
  expect(listener.stateUpdated).toHaveBeenCalledWith(playing);
});
