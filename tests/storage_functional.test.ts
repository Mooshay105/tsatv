/**
 * Functional tests for storage.
 *
 * Tests for top level methods such as scan, pair and connect.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, pair } from "../src/index.ts";
import { Protocol } from "../src/const.ts";
import type { Storage } from "../src/interface.ts";
import { settingsHooks } from "../src/settings.ts";
import { FileStorage } from "../src/storage/file_storage.ts";
import { airplayService } from "./fake_udns.ts";
import { useUdnsServer } from "./fixtures.ts";
import { autouseSpies } from "./setup.ts";
import { mockProtocol } from "./protocols/mock_protocol.ts";

const udns = useUdnsServer();

// Replaces pyfakefs (mockfs) with a temporary directory
let tmpDir: string;
let storageFilename: string;

beforeEach(() => {
  udns.server.addService(airplayService("airplay", "aa:bb:cc:dd:ee:ff"));
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "pyatv-storage-"));
  storageFilename = path.join(tmpDir, "pyatv.conf");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function newStorage(filename: string): Promise<Storage> {
  const storage = new FileStorage(filename);
  await storage.load();
  return storage;
}

test("scan inserts into storage", async () => {
  const storage1 = await newStorage(storageFilename);

  // Scan for the device, get settings for it and save everything to storage
  const conf = (await udns.unicastScan({ storage: storage1 }))[0]!;
  const settings1 = await storage1.getSettings(conf);
  await storage1.save();

  // Open a new storage (based on the same file as above) and extract same settings.
  // Compare content to ensure they are exactly the same.
  const storage2 = await newStorage(storageFilename);
  const settings2 = await storage2.getSettings(conf);
  expect(settings2.toDict()).toEqual(settings1.toDict());
});

test("provides storage to pairing handler", async () => {
  const urandom = spyOn(settingsHooks, "urandom").mockImplementation((n: number) => Buffer.alloc(n));
  autouseSpies.push(urandom);

  const storage = await newStorage(storageFilename);

  const conf = (await udns.unicastScan({ storage }))[0]!;
  const settings = await storage.getSettings(conf);

  await mockProtocol(Protocol.AirPlay, async (airplayMock) => {
    // Calling pair will save Core instance in protocol mock
    await pair(conf, Protocol.AirPlay);
    expect(airplayMock.core!.settings.toDict()).toEqual(settings.toDict());
  });
});

test("provides storage to connect", async () => {
  const storage = await newStorage(storageFilename);

  const conf = (await udns.unicastScan({ storage }))[0]!;
  const settings = await storage.getSettings(conf);
  settings.protocols.airplay.credentials = "creds";

  await mockProtocol(Protocol.AirPlay, async (airplayMock) => {
    const atv = await connect(conf, { storage });
    try {
      // connect will create a copy of the config and load settings in there. Extract
      // the config actually used via Core instance.
      const service = airplayMock.core!.config.getService(Protocol.AirPlay)!;
      expect(service.credentials).toBe("creds");
    } finally {
      atv.close();
    }
  });
});
