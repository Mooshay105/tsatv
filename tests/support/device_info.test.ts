import { expect, test } from "bun:test";
import { DeviceModel, OperatingSystem } from "../../src/const.ts";
import { lookupInternalName, lookupModel, lookupOs, lookupVersion } from "../../src/support/device_info.ts";

test.each([
  ["AppleTV6,2", DeviceModel.Gen4K],
  ["AudioAccessory5,1", DeviceModel.HomePodMini],
  ["AudioAccessory11,1", DeviceModel.HomePodMiniGen2],
  ["bad_model", DeviceModel.Unknown],
])("lookup model %s", (modelStr, expected) => {
  expect(lookupModel(modelStr)).toBe(expected);
});

test.each([
  ["J105aAP", DeviceModel.Gen4K],
  ["bad_name", DeviceModel.Unknown],
])("lookup internal name %s", (name, expected) => {
  expect(lookupInternalName(name)).toBe(expected);
});

test.each([
  [null, null],
  ["17J586", "13.0"],
  ["bad_version", null],
  ["16F123", "12.x"],
  ["17F123", "13.x"],
])("lookup version %p", (version, expected) => {
  expect(lookupVersion(version)).toBe(expected);
});

test.each([
  ["bad", OperatingSystem.Unknown],
  ["MacBookAir10,1", OperatingSystem.MacOS],
  ["iMac1,2", OperatingSystem.MacOS],
  ["Macmini1,1", OperatingSystem.MacOS],
  ["MacBookPro5,67", OperatingSystem.MacOS],
  ["Mac1,4", OperatingSystem.MacOS],
  ["MacPro19,4", OperatingSystem.MacOS],
  [DeviceModel.AirPortExpress, OperatingSystem.AirPortOS],
  [DeviceModel.AirPortExpressGen2, OperatingSystem.AirPortOS],
  [DeviceModel.HomePod, OperatingSystem.TvOS],
  [DeviceModel.HomePodGen2, OperatingSystem.TvOS],
  [DeviceModel.HomePodMini, OperatingSystem.TvOS],
  [DeviceModel.HomePodMiniGen2, OperatingSystem.TvOS],
  [DeviceModel.AppleTVGen1, OperatingSystem.Legacy],
  [DeviceModel.Gen2, OperatingSystem.Legacy],
  [DeviceModel.Gen3, OperatingSystem.Legacy],
  [DeviceModel.Gen4, OperatingSystem.TvOS],
  [DeviceModel.Gen4K, OperatingSystem.TvOS],
  [DeviceModel.AppleTV4KGen2, OperatingSystem.TvOS],
  [DeviceModel.AppleTV4KGen3, OperatingSystem.TvOS],
] as Array<[string | DeviceModel, OperatingSystem]>)("lookup os %p", (idOrModel, expected) => {
  expect(lookupOs(idOrModel)).toBe(expected);
});
