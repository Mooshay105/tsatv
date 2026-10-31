/** Unit tests for interface implementations in pyatv.protocols.companion. */

import { expect, mock, test } from "bun:test";
import { KeyboardFocusState, Protocol } from "../../../src/const.ts";
import { type Core, CoreStateDispatcher, ProtocolStateDispatcher, type StateMessage, UpdatedState } from "../../../src/core/index.ts";
import { MessageDispatcher } from "../../../src/core/protocol.ts";
import type { CompanionAPI } from "../../../src/protocols/companion/api.ts";
import { CompanionKeyboard } from "../../../src/protocols/companion/index.ts";

class CompanionApiMock extends MessageDispatcher<string, Record<string, unknown>> {
  async inject(eventName: string, data: Record<string, unknown>): Promise<void> {
    await Promise.all(this.dispatch(eventName, data));
  }
}

test.each([
  ["_tiStarted", { _tiD: Buffer.alloc(0) }, KeyboardFocusState.Focused],
  ["_tiStopped", {}, KeyboardFocusState.Unfocused],
] as Array<[string, Record<string, unknown>, KeyboardFocusState]>)(
  "keyboard handle text input dispatches %s",
  async (event, data, expectedState) => {
    const apiMock = new CompanionApiMock();
    const stateDispatcher = new ProtocolStateDispatcher(Protocol.Companion, new CoreStateDispatcher());
    new CompanionKeyboard(apiMock as unknown as CompanionAPI, { stateDispatcher } as unknown as Core);

    const callback = mock((_message: StateMessage) => {});
    stateDispatcher.listenTo(UpdatedState.KeyboardFocus, callback);

    await apiMock.inject(event, data);
    await new Promise((resolve) => setImmediate(resolve));

    expect(callback).toHaveBeenCalled();
    expect(callback.mock.calls[0]![0].value).toBe(expectedState);
  },
);
