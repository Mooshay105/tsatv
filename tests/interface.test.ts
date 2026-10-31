/** Unit tests for pyatv.interface. */

import { describe, expect, test } from "bun:test";
import * as convert from "../src/convert.ts";
import {
  DeviceModel,
  DeviceState,
  FeatureName,
  FeatureState,
  MediaType,
  OperatingSystem,
  RepeatState,
  ShuffleState,
} from "../src/const.ts";
import { NotSupportedError } from "../src/exceptions.ts";
import * as iface from "../src/interface.ts";
import { App, DeviceInfo, FeatureInfo, Playing, type PlayingInit } from "../src/interface.ts";

const eqTestCases: Array<[keyof PlayingInit, unknown, unknown]> = [
  ["mediaType", MediaType.Video, MediaType.Music],
  ["deviceState", DeviceState.Idle, DeviceState.Playing],
  ["title", "foo", "bar"],
  ["artist", "abra", "kadabra"],
  ["album", "banana", "apple"],
  ["genre", "cat", "mouse"],
  ["totalTime", 210, 2000],
  ["position", 555, 888],
  ["shuffle", ShuffleState.Albums, ShuffleState.Songs],
  ["repeat", RepeatState.Track, RepeatState.All],
  ["hash", "hash1", "hash2"],
  ["seriesName", "show1", "show2"],
  ["seasonNumber", 1, 20],
  ["episodeNumber", 13, 24],
  ["contentIdentifier", "abc", "def"],
];

class TestClass {}
iface.registerCommands(TestClass, {
  testMethod: "Help text.",
  anotherMethod: "Some other help text. More text here. Test.",
  someProperty: "Property help",
  abbrevHelp: "Type, e.g. a, b or c.",
  abbrevHelpMoreText: "Type, e.g. a, b or c. Some other text.",
  _privateMethodIgnored: "Not parsed.",
});

class FeaturesDummy extends iface.Features {
  constructor(private readonly featureMap: Map<FeatureName, FeatureState>) {
    super();
  }

  override getFeature(feature: FeatureName): FeatureInfo {
    return new FeatureInfo(this.featureMap.get(feature) ?? FeatureState.Unsupported);
  }
}

const methods = () => iface.retrieveCommands(TestClass);

// COMMANDS

test("get commands", () => {
  const m = methods();
  expect(Object.keys(m).length).toBe(5);
  expect(m).toHaveProperty("testMethod");
  expect(m).toHaveProperty("anotherMethod");
  expect(m).toHaveProperty("someProperty");
  expect(m).toHaveProperty("abbrevHelp");
});

test("get first sentence without leading period in doc", () => {
  const m = methods();
  expect(m.testMethod).toBe("Help text");
  expect(m.anotherMethod).toBe("Some other help text");
  expect(m.someProperty).toBe("Property help");
});

test("try to be smart with abbreviations", () => {
  const m = methods();
  expect(m.abbrevHelp).toBe("Type, e.g. a, b or c");
  expect(m.abbrevHelpMoreText).toBe("Type, e.g. a, b or c");
});

// PLAYING

test("playing media type and playstate", () => {
  const out = String(new Playing({ mediaType: MediaType.Video, deviceState: DeviceState.Playing }));
  expect(out).toContain(convert.mediaTypeStr(MediaType.Video));
  expect(out).toContain(convert.deviceStateStr(DeviceState.Playing));
});

test("playing basic fields", () => {
  const out = String(
    new Playing({
      title: "mytitle",
      artist: "myartist",
      album: "myalbum",
      genre: "mygenre",
      seriesName: "myseries",
      seasonNumber: 1245,
      episodeNumber: 2468,
      contentIdentifier: "content_id",
      itunesStoreIdentifier: 123456789,
    }),
  );
  for (const s of ["mytitle", "myartist", "myalbum", "mygenre", "myseries", "1245", "2468", "content_id", "123456789"]) {
    expect(out).toContain(s);
  }
});

test.each([
  [null, 10, null],
  [5, null, 5],
  [-1, null, 0],
  [-1, 10, 0],
  [5, 10, 5],
  [11, 10, 10],
])("playing position force in range %p %p", (position, totalTime, expected) => {
  expect(new Playing({ position, totalTime }).position).toBe(expected);
});

test("playing only position", () => expect(String(new Playing({ position: 1234 }))).toContain("1234"));
test("playing only total time", () => expect(String(new Playing({ totalTime: 5678 }))).toContain("5678"));
test("playing both position and total time", () => {
  expect(String(new Playing({ position: 1234, totalTime: 5678 }))).toContain("1234/5678");
});

test("playing shuffle and repeat", () => {
  const out = String(new Playing({ shuffle: ShuffleState.Songs, repeat: RepeatState.Track }));
  expect(out).toContain("Shuffle: Songs");
  expect(out).toContain("Repeat: Track");
});

test("playing generate same hash", () => {
  const playing = new Playing({ title: "title", artist: "artist", album: "album", totalTime: 123 });
  expect(playing.hash).toBe("538df531d1715629fdd87affd0c5957bcbf54cd89180778071e6535b7df4e22c");
  const playing2 = new Playing({ title: "dummy", artist: "test", album: "none", totalTime: 321 });
  expect(playing2.hash).toBe("80045c05d18382f33a5369fd5cdfc6ae42c3eb418125f638d7a31ab173b01ade");
});

test("playing custom hash", () => expect(new Playing({ hash: "dummy" }).hash).toBe("dummy"));

test("playing eq ensure member count", () => {
  expect(Object.keys(new Playing()).length).toBe(16);
});

describe("playing field equality", () => {
  test.each(eqTestCases)("%s", (prop, value1, value2) => {
    const playing1 = new Playing({ [prop]: value1 });
    const playing2 = new Playing({ [prop]: value2 });
    const playing3 = new Playing({ [prop]: value2 });
    expect(playing1.equals(playing1)).toBe(true);
    expect(playing1.equals(playing2)).toBe(false);
    expect(playing2.equals(playing3)).toBe(true);
  });

  test.each(eqTestCases)("init %s", (prop, value1) => {
    expect((new Playing({ [prop]: value1 }) as any)[prop]).toBe(value1);
  });
});

// METADATA

test("metadata rest not supported", async () => {
  const metadata = new iface.Metadata();
  expect(() => metadata.deviceId).toThrow(NotSupportedError);
  await expect(metadata.artwork()).rejects.toBeInstanceOf(NotSupportedError);
  expect(() => metadata.artworkId).toThrow(NotSupportedError);
  await expect(metadata.playing()).rejects.toBeInstanceOf(NotSupportedError);
});

// DEVICE INFO

test.each([
  [{}, OperatingSystem.Unknown, null, null, DeviceModel.Unknown, null, null],
  [
    {
      [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS,
      [DeviceInfo.VERSION]: "1.0",
      [DeviceInfo.BUILD_NUMBER]: "ABC",
      [DeviceInfo.MODEL]: DeviceModel.Gen3,
      [DeviceInfo.MAC]: "AA:BB:CC:DD:EE:FF",
      [DeviceInfo.OUTPUT_DEVICE_ID]: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    },
    OperatingSystem.TvOS,
    "1.0",
    "ABC",
    DeviceModel.Gen3,
    "AA:BB:CC:DD:EE:FF",
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  ],
] as Array<[Record<string, unknown>, OperatingSystem, any, any, DeviceModel, any, any]>)(
  "device info various input %#",
  (properties, os, version, buildNumber, model, mac, outputDeviceId) => {
    const devInfo = new DeviceInfo({ ...properties });
    expect(devInfo.operatingSystem).toBe(os);
    expect(devInfo.version).toBe(version);
    expect(devInfo.buildNumber).toBe(buildNumber);
    expect(devInfo.model).toBe(model);
    expect(devInfo.mac).toBe(mac);
    expect(devInfo.outputDeviceId).toBe(outputDeviceId);
  },
);

test.each<Record<string, unknown>>([
  { [DeviceInfo.OPERATING_SYSTEM]: "bad" },
  { [DeviceInfo.VERSION]: 123 },
  { [DeviceInfo.BUILD_NUMBER]: 456 },
  { [DeviceInfo.MODEL]: "bad" },
  { [DeviceInfo.MAC]: 789 },
  { [DeviceInfo.OUTPUT_DEVICE_ID]: 0 },
])("device info bad types %p", (properties) => {
  expect(() => new DeviceInfo(properties)).toThrow(TypeError);
});

test.each([
  [DeviceModel.AirPortExpress, OperatingSystem.AirPortOS],
  [DeviceModel.AirPortExpressGen2, OperatingSystem.AirPortOS],
  [DeviceModel.HomePod, OperatingSystem.TvOS],
  [DeviceModel.HomePodMini, OperatingSystem.TvOS],
  [DeviceModel.Gen2, OperatingSystem.TvOS],
  [DeviceModel.Gen3, OperatingSystem.TvOS],
  [DeviceModel.Gen4, OperatingSystem.TvOS],
  [DeviceModel.Gen4K, OperatingSystem.TvOS],
  [DeviceModel.AppleTV4KGen2, OperatingSystem.TvOS],
  [DeviceModel.AppleTV4KGen3, OperatingSystem.TvOS],
])("device info guess os %p", (model, expectedOs) => {
  expect(new DeviceInfo({ [DeviceInfo.MODEL]: model }).operatingSystem).toBe(expectedOs);
});

test.each([
  [{ [DeviceInfo.VERSION]: "1.0" }, "1.0"],
  [{ [DeviceInfo.BUILD_NUMBER]: "18M60" }, "14.7"],
  [{ [DeviceInfo.VERSION]: "1.0", [DeviceInfo.BUILD_NUMBER]: "18M60" }, "1.0"],
])("device info resolve version from build number %#", (properties, expected) => {
  expect(new DeviceInfo(properties).version).toBe(expected);
});

test("device info raw model", () => {
  expect(new DeviceInfo({ [DeviceInfo.RAW_MODEL]: "raw" }).rawModel).toBe("raw");
});

test("device info apple tv 3 str", () => {
  const devInfo = new DeviceInfo({
    [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.Legacy,
    [DeviceInfo.VERSION]: "2.2.3",
    [DeviceInfo.BUILD_NUMBER]: "13D333",
    [DeviceInfo.MODEL]: DeviceModel.Gen3,
    [DeviceInfo.MAC]: "aa:bb:cc:dd:ee:ff",
  });
  expect(String(devInfo)).toBe("Apple TV 3, ATV SW 2.2.3 build 13D333");
});

test("device info homepod mini str", () => {
  const devInfo = new DeviceInfo({
    [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS,
    [DeviceInfo.VERSION]: "1.2.3",
    [DeviceInfo.BUILD_NUMBER]: "19A123",
    [DeviceInfo.MODEL]: DeviceModel.HomePodMini,
    [DeviceInfo.MAC]: "aa:bb:cc:dd:ee:ff",
  });
  expect(String(devInfo)).toBe("HomePod Mini, tvOS 1.2.3 build 19A123");
});

test("device info unknown str", () => expect(String(new DeviceInfo({}))).toBe("Unknown, Unknown OS"));
test("device info raw model str", () => {
  expect(String(new DeviceInfo({ [DeviceInfo.RAW_MODEL]: "raw" }))).toBe("raw, Unknown OS");
});

test.each([
  [DeviceModel.Unknown, "raw", "raw"],
  [DeviceModel.Gen3, "raw", "Apple TV 3"],
])("model str %p", (model, rawModel, expected) => {
  expect(new DeviceInfo({ [DeviceInfo.MODEL]: model, [DeviceInfo.RAW_MODEL]: rawModel }).modelStr).toBe(expected);
});

// FEATURES

test("all unsupported features", () => {
  const features = new FeaturesDummy(new Map([[FeatureName.Play, FeatureState.Unsupported]]));
  expect(features.allFeatures().size).toBe(0);
});

test("all include unsupported features", () => {
  const features = new FeaturesDummy(new Map([[FeatureName.Play, FeatureState.Unsupported]]));
  const all = features.allFeatures(true);
  expect(new Set(all.keys())).toEqual(new Set(iface.ALL_FEATURE_NAMES));
  expect(new Set([...all.values()].map((f) => f.state))).toEqual(new Set([FeatureState.Unsupported]));
});

test("features in state", () => {
  const features = new FeaturesDummy(
    new Map([
      [FeatureName.Play, FeatureState.Unsupported],
      [FeatureName.Pause, FeatureState.Available],
    ]),
  );
  expect(features.inState(FeatureState.Unknown, FeatureName.Play)).toBe(false);
  expect(features.inState([FeatureState.Unknown], FeatureName.Play)).toBe(false);
  expect(features.inState(FeatureState.Unsupported, FeatureName.Play)).toBe(true);
  expect(features.inState([FeatureState.Unsupported], FeatureName.Play)).toBe(true);
  expect(features.inState([FeatureState.Unsupported], FeatureName.Play, FeatureName.Pause)).toBe(false);
  expect(
    features.inState([FeatureState.Unsupported, FeatureState.Available], FeatureName.Play, FeatureName.Pause),
  ).toBe(true);
});

// APP

test("app properties", () => {
  const app = new App("name", "id");
  expect(app.name).toBe("name");
  expect(app.identifier).toBe("id");
});

test("app str", () => expect(String(new App("name", "id"))).toBe("App: name (id)"));

test("app equality", () => {
  const n = null as any;
  expect(new App(n, n).equals("test")).toBe(false);
  expect(new App(n, n).equals(new App(n, n))).toBe(true);
  expect(new App("test", n).equals(new App(n, n))).toBe(false);
  expect(new App("test", n).equals(new App("test", n))).toBe(true);
  expect(new App(n, "test").equals(new App(n, n))).toBe(false);
  expect(new App(n, "test").equals(new App(n, "test"))).toBe(true);
  expect(new App("test", "test2").equals(new App("test", "test2"))).toBe(true);
});
