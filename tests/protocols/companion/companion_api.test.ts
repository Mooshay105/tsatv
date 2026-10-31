/** Unit tests for pyatv.protocols.companion.api. */

import { expect, test } from "bun:test";
import { TouchAction } from "../../../src/const.ts";
import { CompanionAPI, TOUCHPAD_DELAY_MS } from "../../../src/protocols/companion/api.ts";
import { realSleep } from "../../../src/support/asyncio.ts";
import { stubSleep } from "../../utils.ts";

function recordingApi(): [CompanionAPI, Array<{ x: number; y: number; mode: TouchAction; time: number }>] {
  const events: Array<{ x: number; y: number; mode: TouchAction; time: number }> = [];
  const api = Object.create(CompanionAPI.prototype) as CompanionAPI;
  api.hidEvent = async (x: number, y: number, mode: TouchAction) => {
    events.push({ x, y, mode, time: performance.now() });
  };
  return [api, events];
}

test("swipe waits between press and first hold (pyatv #2914)", async () => {
  const [api, events] = recordingApi();
  const log: string[] = [];
  const hidEvent = api.hidEvent;
  api.hidEvent = async (x, y, mode) => {
    log.push(TouchAction[mode]!);
    await hidEvent(x, y, mode);
  };
  stubSleep(async (seconds) => {
    log.push(`sleep ${seconds}`);
    await realSleep(seconds);
  });
  await api.swipe(500, 100, 500, 900, 100);

  expect(log.slice(0, 3)).toEqual(["Press", `sleep ${TOUCHPAD_DELAY_MS / 1000}`, "Hold"]);
  expect(events.at(-1)).toMatchObject({ x: 500, y: 900, mode: TouchAction.Release });
});

test("swipe release is clamped to touchpad", async () => {
  const [api, events] = recordingApi();
  await api.swipe(100, 100, 1500.7, -20, 50);
  expect(events.at(-1)).toMatchObject({ x: 1000, y: 0, mode: TouchAction.Release });
  for (const event of events) {
    expect(Number.isInteger(event.x) && Number.isInteger(event.y)).toBe(true);
  }
});
