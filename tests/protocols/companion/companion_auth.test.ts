/** Functional authentication tests with fake Companion Apple TV. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { pair } from "../../../src/index.ts";
import { CLIENT_CREDENTIALS, PIN_CODE } from "../../../src/auth/server_auth.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import { PairingError } from "../../../src/exceptions.ts";
import type { PairingHandler } from "../../../src/interface.ts";
import type { FakeCompanionState } from "../../fake_device/companion.ts";
import "../../fake_device/companion.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import "../../fake_device/mrp.ts";

let fakeAtv: FakeAppleTV;
let state: FakeCompanionState;
let service: ManualService;
let conf: AppleTV;
let handle: PairingHandler | null;

beforeEach(async () => {
  fakeAtv = new FakeAppleTV();
  fakeAtv.addService(Protocol.MRP);
  [state] = fakeAtv.addService(Protocol.Companion);
  await fakeAtv.start();

  service = new ManualService(null, Protocol.Companion, fakeAtv.getPort(Protocol.Companion), {});
  conf = new AppleTV("127.0.0.1", "Test device");
  conf.addService(new ManualService("mrp_id", Protocol.MRP, fakeAtv.getPort(Protocol.MRP), {}));
  conf.addService(service);
  handle = null;
});

afterEach(async () => {
  await handle?.close();
  await fakeAtv.stop();
});

test("pairing with device", async () => {
  handle = await pair(conf, Protocol.Companion);

  expect(service.credentials).toBeNull();
  expect(handle.deviceProvidesPin).toBe(true);

  await handle.begin();
  handle.pin(PIN_CODE);
  await handle.finish();

  expect(handle.hasPaired).toBe(true);
  expect(state.hasPaired).toBe(true);
  expect(service.credentials).not.toBeNull();
});

test("pairing with existing credentials", async () => {
  service.credentials = CLIENT_CREDENTIALS;

  handle = await pair(conf, Protocol.Companion);

  expect(handle.hasPaired).toBe(false);
  expect(service.credentials).not.toBeNull();
  expect(handle.deviceProvidesPin).toBe(true);

  await handle.begin();
  handle.pin(PIN_CODE);
  await handle.finish();

  expect(handle.hasPaired).toBe(true);
  expect(state.hasPaired).toBe(true);
  expect(service.credentials).not.toBeNull();
});

test("pairing no pin", async () => {
  handle = await pair(conf, Protocol.Companion);
  await handle.begin();
  await expect(handle.finish()).rejects.toThrow(PairingError);
});

test("pairing with bad pin", async () => {
  handle = await pair(conf, Protocol.Companion);

  expect(service.credentials).toBeNull();
  expect(handle.deviceProvidesPin).toBe(true);

  await handle.begin();
  handle.pin(PIN_CODE + 1);

  await expect(handle.finish()).rejects.toThrow(PairingError);

  expect(handle.hasPaired).toBe(false);
  expect(state.hasPaired).toBe(false);
  expect(service.credentials).toBeNull();
});
