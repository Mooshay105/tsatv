/** Unit tests for pyatv.storage (using MemoryStorage as concrete implementation). */

import { beforeEach, expect, test } from "bun:test";
import { AppleTV, ManualService } from "../../src/conf.ts";
import { Protocol } from "../../src/const.ts";
import { DeviceIdMissingError, SettingsError } from "../../src/exceptions.ts";
import { StorageModel } from "../../src/storage/index.ts";
import { MemoryStorage } from "../../src/storage/memory_storage.ts";

let memoryStorage: MemoryStorage;
beforeEach(() => {
  memoryStorage = new MemoryStorage();
});

const protocolSetting = (settings: any, name: string) => settings.protocols[name];
const lower = (p: Protocol) => Protocol[p].toLowerCase();

test("load save does nothing", async () => {
  await memoryStorage.load();
  await memoryStorage.save();
});

test("get settings without identifier raises", async () => {
  const atv = new AppleTV("127.0.0.1", "test");
  await expect(memoryStorage.getSettings(atv)).rejects.toBeInstanceOf(DeviceIdMissingError);
});

test.each([
  [Protocol.AirPlay, true, "airplay"],
  [Protocol.Companion, false, "companion"],
  [Protocol.DMAP, false, "dmap"],
  [Protocol.MRP, false, "mrp"],
  [Protocol.RAOP, true, "raop"],
])("get settings for device %p", async (protocol, hasPassword, settingName) => {
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(
    new ManualService("id", protocol, 1234, {}, { credentials: "creds", password: hasPassword ? "password" : null }),
  );
  const settings = await memoryStorage.getSettings(atv);
  expect(settings.info.name).toBe("pyatv");
  expect(protocolSetting(settings, settingName).identifier).toBe("id");
  expect(protocolSetting(settings, settingName).credentials).toBe("creds");
  if (hasPassword) expect(protocolSetting(settings, settingName).password).toBe("password");
});

test("adding same config returns existing settings", async () => {
  expect(memoryStorage.settings.length).toBe(0);
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id", Protocol.DMAP, 1234, {}));
  await memoryStorage.getSettings(atv);
  expect(memoryStorage.settings.length).toBe(1);
  await memoryStorage.getSettings(atv);
  expect(memoryStorage.settings.length).toBe(1);
});

test("get all settings", async () => {
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id1", Protocol.DMAP, 1234, {}));
  const settings = await memoryStorage.getSettings(atv);
  const atv2 = new AppleTV("127.0.0.1", "test");
  atv2.addService(new ManualService("id2", Protocol.DMAP, 1234, {}));
  const settings2 = await memoryStorage.getSettings(atv2);
  expect(memoryStorage.settings.length).toBe(2);
  expect(memoryStorage.settings).toContain(settings);
  expect(memoryStorage.settings).toContain(settings2);
});

test("remove settings", async () => {
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id", Protocol.DMAP, 1234, {}));
  const settings = await memoryStorage.getSettings(atv);
  expect(memoryStorage.settings.length).toBe(1);
  expect(await memoryStorage.removeSettings(settings)).toBe(true);
  expect(memoryStorage.settings.length).toBe(0);
  expect(await memoryStorage.removeSettings(settings)).toBe(false);
});

test.each([Protocol.AirPlay, Protocol.Companion, Protocol.MRP, Protocol.RAOP])(
  "settings prioritized over config %p",
  async (protocol) => {
    const atv = new AppleTV("127.0.0.1", "test");
    const dmapService = new ManualService("id1", Protocol.DMAP, 1234, {});
    const mrpService = new ManualService("id2", protocol, 1234, {}, { credentials: "creds" });
    atv.addService(dmapService);
    atv.addService(mrpService);

    // Load settings once to insert initial settings into storage
    let settings = await memoryStorage.getSettings(atv);

    // Change something and read from storage again. What is stored in storage should
    // overwrite manual changes.
    dmapService.credentials = "dmap_creds";
    settings = await memoryStorage.getSettings(atv);

    expect(settings.protocols.dmap.credentials).toBeNull();
    expect(protocolSetting(settings, lower(protocol)).identifier).toBe("id2");
    expect(protocolSetting(settings, lower(protocol)).credentials).toBe("creds");
  },
);

test.each([Protocol.DMAP, Protocol.MRP, Protocol.AirPlay, Protocol.Companion, Protocol.RAOP])(
  "update config changes to storage %p",
  async (protocol) => {
    const atv = new AppleTV("127.0.0.1", "test");
    const service = new ManualService("id2", protocol, 1234, {}, { credentials: "test" });
    atv.addService(service);

    let settings = await memoryStorage.getSettings(atv);
    expect(protocolSetting(settings, lower(protocol)).credentials).toBe("test");

    service.credentials = "foobar";
    await memoryStorage.updateSettings(atv);

    settings = await memoryStorage.getSettings(atv);
    expect(protocolSetting(settings, lower(protocol)).credentials).toBe("foobar");
  },
);

test("change info is device dependent", async () => {
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id1", Protocol.DMAP, 1234, {}));
  let settings = await memoryStorage.getSettings(atv);
  settings.info.name = "first";

  const atv2 = new AppleTV("127.0.0.1", "test");
  atv2.addService(new ManualService("id2", Protocol.DMAP, 1234, {}));
  const settings2 = await memoryStorage.getSettings(atv2);
  settings2.info.name = "second";

  settings = await memoryStorage.getSettings(atv);
  expect(settings.info.name).toBe("first");
});

test("unsupported version raises", () => {
  expect(() => {
    memoryStorage.storageModel = new StorageModel(2, []);
  }).toThrow(SettingsError);
});

test("change field reflected in changed property", async () => {
  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(true);
  memoryStorage.updateHash(memoryStorage.toDict());
  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(false);

  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id1", Protocol.DMAP, 1234, {}));
  const settings = await memoryStorage.getSettings(atv);

  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(true);
  memoryStorage.updateHash(memoryStorage.toDict());

  settings.info.name = "test";
  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(true);
  memoryStorage.updateHash(memoryStorage.toDict());
  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(false);
});

test("set model reflects changed property", async () => {
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id1", Protocol.DMAP, 1234, {}));
  await memoryStorage.getSettings(atv);

  const newStorage = new MemoryStorage();
  newStorage.updateHash(newStorage.toDict());

  newStorage.storageModel = memoryStorage.storageModel;
  expect(newStorage.hasChanged(newStorage.toDict())).toBe(true);

  newStorage.updateHash(newStorage.toDict());
  expect(newStorage.hasChanged(newStorage.toDict())).toBe(false);
});

test("save updates changed property", async () => {
  const atv = new AppleTV("127.0.0.1", "test");
  atv.addService(new ManualService("id1", Protocol.DMAP, 1234, {}));
  await memoryStorage.getSettings(atv);
  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(true);
  await memoryStorage.save();
  expect(memoryStorage.hasChanged(memoryStorage.toDict())).toBe(false);
});
