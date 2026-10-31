/** Functional authentication tests with fake MRP Apple TV. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as pyatv from "../../../src/index.ts";
import { CLIENT_CREDENTIALS, CLIENT_IDENTIFIER, PIN_CODE } from "../../../src/auth/server_auth.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import { PairingError } from "../../../src/exceptions.ts";
import type { AppleTV as AppleTVInterface, PairingHandler } from "../../../src/interface.ts";
import { MemoryStorage } from "../../../src/storage/memory_storage.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import "../../fake_device/mrp.ts";
import type { FakeMrpState } from "../../fake_device/mrp.ts";

let fakeAtv: FakeAppleTV;
let state: FakeMrpState;
let storage: MemoryStorage;
let service: ManualService;
let conf: AppleTV;
let handle: PairingHandler | AppleTVInterface | null;

beforeEach(async () => {
  fakeAtv = new FakeAppleTV();
  [state] = fakeAtv.addService<FakeMrpState>(Protocol.MRP);
  await fakeAtv.start();

  storage = new MemoryStorage();
  service = new ManualService(CLIENT_IDENTIFIER, Protocol.MRP, fakeAtv.getPort(Protocol.MRP), {});
  conf = new AppleTV("127.0.0.1", "Apple TV");
  conf.addService(service);
  handle = null;
});

afterEach(async () => {
  if (handle) {
    const result = handle.close();
    if (result instanceof Promise) await result;
    else await Promise.all(result as Set<Promise<unknown>>);
  }
  await fakeAtv.stop();
});

test("pairing with device", async () => {
  const h = await pyatv.pair(conf, Protocol.MRP, { storage });
  handle = h;
  expect(service.credentials).toBeNull();
  expect(h.deviceProvidesPin).toBe(true);

  await h.begin();
  h.pin(PIN_CODE);
  await h.finish();

  expect(h.hasPaired).toBe(true);
  expect(state.hasPaired).toBe(true);
  expect(service.credentials).not.toBeNull();
  expect(storage.settings[0]!.protocols.mrp.credentials).toBe(service.credentials);

  // Client should verify keys after pairing, needed from tvOS 14
  expect(state.hasAuthenticated).toBe(true);
});

test("pairing with existing credentials", async () => {
  service.credentials = CLIENT_CREDENTIALS;
  const h = await pyatv.pair(conf, Protocol.MRP, { storage });
  handle = h;

  expect(h.hasPaired).toBe(false);
  expect(service.credentials).not.toBeNull();
  expect(h.deviceProvidesPin).toBe(true);

  await h.begin();
  h.pin(PIN_CODE);
  await h.finish();

  expect(h.hasPaired).toBe(true);
  expect(state.hasPaired).toBe(true);
  expect(service.credentials).not.toBeNull();
  expect(storage.settings[0]!.protocols.mrp.credentials).toBe(service.credentials);
  expect(state.hasAuthenticated).toBe(true);
});

test("pairing with bad pin", async () => {
  const h = await pyatv.pair(conf, Protocol.MRP);
  handle = h;
  expect(service.credentials).toBeNull();
  expect(h.deviceProvidesPin).toBe(true);

  await h.begin();
  h.pin(PIN_CODE + 1);
  await expect(h.finish()).rejects.toBeInstanceOf(PairingError);

  expect(h.hasPaired).toBe(false);
  expect(state.hasPaired).toBe(false);
  expect(service.credentials).toBeNull();
  expect(state.hasAuthenticated).toBe(false);
});

test("authentication", async () => {
  service.credentials = CLIENT_CREDENTIALS;
  handle = await pyatv.connect(conf);
  expect(state.hasAuthenticated).toBe(true);
});
