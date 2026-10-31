/** Functional tests using the API with a fake Apple TV. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { connect } from "../../../src/index.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import {
  DeviceModel,
  DeviceState,
  FeatureName,
  FeatureState,
  InputAction,
  MediaType,
  OperatingSystem,
  PowerState,
  Protocol,
  ShuffleState,
} from "../../../src/const.ts";
import { OutputDevice, type PowerListener } from "../../../src/interface.ts";
import * as pb from "../../../src/protocols/mrp/protobuf/index.ts";
import { BasicHttpServer, HttpRequest, HttpResponse, HttpSimpleRouter, httpServer } from "../../../src/support/http.ts";
import type { Server } from "../../../src/support/transport.ts";
import {
  assertFeatures,
  commonFunctionalTests,
  type FunctionalFixture,
  playing,
  waitForButtonPress,
} from "../../common_functional_tests.ts";
import { DEVICE_CREDENTIALS } from "../../fake_device/airplay.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import {
  APP_NAME,
  BUILD_NUMBER,
  DEVICE_MODEL,
  DEVICE_UID,
  OS_VERSION,
  PLAYER_IDENTIFIER,
  VOLUME_STEP,
} from "../../fake_device/mrp.ts";
import { faketime, stubSleep, until } from "../../utils.ts";

const ARTWORK_BYTES = Buffer.from("1234");
const ARTWORK_MIMETYPE = "image/png";
const ARTWORK_ID = "artwork_id1";

const DEMO_APP_NAME = "Demo App";
const TEST_PLAYER = "com.github.postlund.test";

const CommandInfo = pb.Command;

const fx = {} as FunctionalFixture & { artworkServer: Server | null };

beforeEach(async () => {
  fx.fakeAtv = new FakeAppleTV();
  [fx.state, fx.usecase] = fx.fakeAtv.addService(Protocol.MRP);
  [fx.airplayState, fx.airplayUsecase] = fx.fakeAtv.addService(Protocol.AirPlay);
  await fx.fakeAtv.start();

  fx.conf = new AppleTV("127.0.0.1", "Test device");
  fx.conf.addService(new ManualService("mrp_id", Protocol.MRP, fx.fakeAtv.getPort(Protocol.MRP), {}));
  const airplayService = new ManualService("airplay_id", Protocol.AirPlay, fx.fakeAtv.getPort(Protocol.AirPlay), {
    features: "0x1", // AirPlayVideoV1 supported
  });
  airplayService.credentials = DEVICE_CREDENTIALS;
  fx.conf.addService(airplayService);
  fx.atv = await connect(fx.conf);
  fx.artworkServer = null;
});

afterEach(async () => {
  await Promise.allSettled(fx.atv.close());
  fx.artworkServer?.close();
  await fx.fakeAtv.stop();
});

async function serveArtwork(path: string): Promise<number> {
  const handler = new HttpSimpleRouter();
  handler.addRoute(
    "GET",
    path,
    (_request: HttpRequest) => new HttpResponse("HTTP", "1.0", 200, "OK", { "Content-Type": ARTWORK_MIMETYPE }, ARTWORK_BYTES),
  );
  const [server, port] = await httpServer(() => new BasicHttpServer(handler));
  fx.artworkServer = server;
  return port;
}

const sameDevices = (actual: OutputDevice[], expected: OutputDevice[]) =>
  actual.length === expected.length && actual.every((device, i) => device.equals(expected[i]));

commonFunctionalTests(fx, {
  supportedVolumeControls: [FeatureName.VolumeUp, FeatureName.VolumeDown, FeatureName.Volume, FeatureName.SetVolume],
});

for (const button of ["up", "down", "left", "right", "select", "menu"] as const) {
  test(`button ${button} actions`, async () => {
    await fx.atv.remoteControl[button](InputAction.DoubleTap);
    await waitForButtonPress(fx, button, InputAction.DoubleTap);

    await fx.atv.remoteControl[button](InputAction.Hold);
    await waitForButtonPress(fx, button, InputAction.Hold);
  });
}

test("button top menu", async () => {
  await fx.atv.remoteControl.topMenu();
  await waitForButtonPress(fx, "top_menu", InputAction.SingleTap);
});

test("button home", async () => {
  await fx.atv.remoteControl.home();
  await waitForButtonPress(fx, "home", InputAction.SingleTap);

  await fx.atv.remoteControl.home(InputAction.DoubleTap);
  await waitForButtonPress(fx, "home", InputAction.DoubleTap);

  await fx.atv.remoteControl.home(InputAction.Hold);
  await waitForButtonPress(fx, "home", InputAction.Hold);
});

test("button home hold", async () => {
  await fx.atv.remoteControl.homeHold();
  await waitForButtonPress(fx, "home", InputAction.Hold);
});

test("button suspend", async () => {
  await fx.atv.remoteControl.suspend();
  await until(() => fx.state.lastButtonPressed === "suspend");
});

test("button wakeup", async () => {
  await fx.atv.remoteControl.wakeup();
  await until(() => fx.state.lastButtonPressed === "wakeup");
});

test("shuffle state albums", async () => {
  fx.usecase.exampleVideo({ shuffle: ShuffleState.Albums });
  const p = await playing(fx, { shuffle: ShuffleState.Albums });
  expect(p.shuffle).toBe(ShuffleState.Albums);
});

test("set shuffle albums", async () => {
  fx.usecase.exampleVideo();
  await fx.atv.remoteControl.setShuffle(ShuffleState.Albums);
  const p = await playing(fx, { shuffle: ShuffleState.Albums });
  expect(p.shuffle).toBe(ShuffleState.Albums);
});

test("metadata artwork id", async () => {
  fx.usecase.exampleVideo();
  fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE, ARTWORK_ID);
  await playing(fx, { title: "dummy" });
  expect(fx.atv.metadata.artworkId).toBe(ARTWORK_ID);
});

test("metadata artwork id no identifier", async () => {
  fx.usecase.exampleVideo({ identifier: "some_id" });
  fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE, null);
  await playing(fx, { title: "dummy" });
  expect(fx.atv.metadata.artworkId).toBe("some_id");
});

test("metadata artwork erroneously available", async () => {
  fx.usecase.exampleVideo();

  // Metadata suggests that artwork is available but no artwork is available when
  // requested by client
  fx.usecase.changeArtwork(null, ARTWORK_MIMETYPE, ARTWORK_ID);
  await playing(fx, { title: "dummy" });

  expect(await fx.atv.metadata.artwork(123, 456)).toBeNull();
});

test("metadata artwork width and height", async () => {
  fx.usecase.exampleVideo();
  fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE, "artwork", 111, 222);
  await playing(fx, { title: "dummy" });

  // Request one size but simulate that a smaller artwork was returned
  const artwork = await fx.atv.metadata.artwork(123, 456);
  expect(artwork!.width).toBe(111);
  expect(artwork!.height).toBe(222);
});

test("metadata artwork url", async () => {
  const port = await serveArtwork("/test");

  fx.usecase.exampleVideo();
  fx.usecase.changeArtwork(Buffer.alloc(0), "", "artwork", null, null, `http://localhost:${port}/test`);
  await playing(fx, { title: "dummy" });

  const artwork = await fx.atv.metadata.artwork(123, 456);
  expect(artwork!.bytes).toEqual(ARTWORK_BYTES);
  expect(artwork!.mimetype).toBe(ARTWORK_MIMETYPE);
});

test("metadata artwork url in identifier", async () => {
  const port = await serveArtwork("/test/123x456bb.png");

  fx.usecase.exampleVideo();
  fx.usecase.changeArtwork(
    Buffer.alloc(0),
    "",
    `http://localhost:${port}/test/{w}x{h}{c}.{f}`,
    null,
    null,
    `http://localhost:${port}/test/1200x1200bb.heic`,
  );
  await playing(fx, { title: "dummy" });

  const artwork = await fx.atv.metadata.artwork(123, 456);
  expect(artwork!.bytes).toEqual(ARTWORK_BYTES);
  expect(artwork!.mimetype).toBe(ARTWORK_MIMETYPE);
});

test("item updates", async () => {
  fx.usecase.videoPlaying({ paused: false, title: "dummy", totalTime: 100, position: 1, identifier: "id", artist: "some artist" });

  await faketime([0], async () => {
    await playing(fx, { title: "dummy" });

    // Trigger update of single item by changing title
    fx.usecase.changeMetadata({ title: "foobar", identifier: "id" });
    const p = await playing(fx, { title: "foobar" });

    // Make sure other metadata is untouched
    expect(p.title).toBe("foobar");
    expect(p.artist).toBe("some artist");
    expect(p.totalTime).toBe(100);
    expect(p.position).toBe(1);
  });
});

test("item id hash", async () => {
  const initialHash = (await fx.atv.metadata.playing()).hash;

  // Verify that content identifier is used as hash
  fx.usecase.exampleVideo({ identifier: "some_id" });
  const p = await playing(fx, { title: "dummy" });
  expect(p.hash).toBe("some_id");

  // Ensure that we fall back to initial hash if nothing is playing
  fx.usecase.nothingPlaying();
  const nothingPlaying = await playing(fx, { deviceState: DeviceState.Idle });
  expect(nothingPlaying.hash).toBe(initialHash);
});

test("metadata playback rate device state", async () => {
  fx.usecase.exampleVideo({ paused: false, playbackRate: 0.0 });
  let p = await playing(fx, { title: "dummy" });
  expect(p.deviceState).toBe(DeviceState.Playing);

  fx.usecase.changeMetadata({ title: "dummy2", playbackRate: 1.0 });
  p = await playing(fx, { title: "dummy2" });
  expect(p.deviceState).toBe(DeviceState.Playing);

  fx.usecase.exampleVideo({ paused: true, title: "dummy3", playbackRate: 0.0 });
  p = await playing(fx, { title: "dummy3" });
  expect(p.deviceState).toBe(DeviceState.Paused);
});

test("power state", async () => {
  const listener: PowerListener & { oldState: PowerState | null; newState: PowerState | null } = {
    oldState: null,
    newState: null,
    powerstateUpdate(oldState: PowerState, newState: PowerState) {
      this.oldState = oldState;
      this.newState = newState;
    },
  };
  fx.atv.power.listener = listener;

  // Check initial power state during connect
  expect(fx.atv.power.powerState).toBe(PowerState.On);

  // Check if power state changes after turn_off command
  await fx.atv.power.turnOff();
  expect(stubSleep()).toBeCloseTo(0.1);
  await until(() => fx.atv.power.powerState === PowerState.Off);
  await until(() => listener.oldState === PowerState.On);
  await until(() => listener.newState === PowerState.Off);

  // Check if power state changes after turn_on command
  await fx.atv.power.turnOn();
  await until(() => fx.atv.power.powerState === PowerState.On);
  await until(() => listener.oldState === PowerState.Off);
  await until(() => listener.newState === PowerState.On);
});

test("power state acknowledgement", async () => {
  expect(fx.atv.power.powerState).toBe(PowerState.On);
  await fx.atv.power.turnOff(true);
  expect(fx.atv.power.powerState).toBe(PowerState.Off);
  await fx.atv.power.turnOn(true);
  expect(fx.atv.power.powerState).toBe(PowerState.On);
});

test("basic device info", () => {
  expect(fx.atv.deviceInfo.operatingSystem).toBe(OperatingSystem.TvOS);
  expect(fx.atv.deviceInfo.buildNumber).toBe(BUILD_NUMBER);
  expect(fx.atv.deviceInfo.version).toBe(OS_VERSION);
  expect(fx.atv.deviceInfo.rawModel).toBe(DEVICE_MODEL);
  expect(fx.atv.deviceInfo.model).toBe(DeviceModel.Gen4K);
});

test("always available features", () => {
  assertFeatures(
    fx,
    FeatureState.Available,
    FeatureName.Down,
    FeatureName.Home,
    FeatureName.HomeHold,
    FeatureName.Left,
    FeatureName.Menu,
    FeatureName.Right,
    FeatureName.Select,
    FeatureName.TopMenu,
    FeatureName.Up,
    FeatureName.TurnOn,
    FeatureName.TurnOff,
    FeatureName.PowerState,
    FeatureName.OutputDevices,
    FeatureName.AddOutputDevices,
    FeatureName.RemoveOutputDevices,
    FeatureName.SetOutputDevices,
  );
});

test("features artwork", async () => {
  assertFeatures(fx, FeatureState.Unavailable, FeatureName.Artwork);

  fx.usecase.exampleVideo();
  fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE, ARTWORK_ID);
  await playing(fx, { title: "dummy" });

  assertFeatures(fx, FeatureState.Available, FeatureName.Artwork);
});

test("features with supported commands", async () => {
  const featureMap = new Map<FeatureName, number>([
    [FeatureName.Next, CommandInfo.NextTrack],
    [FeatureName.Pause, CommandInfo.Pause],
    [FeatureName.Play, CommandInfo.Play],
    [FeatureName.PlayPause, CommandInfo.TogglePlayPause],
    [FeatureName.Previous, CommandInfo.PreviousTrack],
    [FeatureName.Stop, CommandInfo.Stop],
    [FeatureName.SetPosition, CommandInfo.SeekToPlaybackPosition],
    [FeatureName.SetRepeat, CommandInfo.ChangeRepeatMode],
    [FeatureName.SetShuffle, CommandInfo.ChangeShuffleMode],
    [FeatureName.Shuffle, CommandInfo.ChangeShuffleMode],
    [FeatureName.Repeat, CommandInfo.ChangeRepeatMode],
    [FeatureName.SkipForward, CommandInfo.SkipForward],
    [FeatureName.SkipBackward, CommandInfo.SkipBackward],
  ]);

  // No supported commands by default
  fx.usecase.exampleVideo();
  await playing(fx, { title: "dummy" });
  assertFeatures(fx, FeatureState.Unavailable, ...featureMap.keys());

  // Inject all expected commands to be enabled
  fx.usecase.exampleVideo({ title: "dummy2", supportedCommands: [...featureMap.values()] });
  await playing(fx, { title: "dummy2" });
  assertFeatures(fx, FeatureState.Available, ...featureMap.keys());
});

test("playing app", async () => {
  fx.usecase.nothingPlaying();

  // Nothing playing => no app running
  expect(fx.atv.metadata.app).toBeNull();
  expect(fx.atv.features.getFeature(FeatureName.App).state).toBe(FeatureState.Unavailable);

  fx.usecase.exampleVideo();
  await playing(fx, { title: "dummy" });

  // Video playing with default app
  expect(fx.atv.metadata.app!.name).toBe(APP_NAME);
  expect(fx.atv.metadata.app!.identifier).toBe(PLAYER_IDENTIFIER);
  expect(fx.atv.features.getFeature(FeatureName.App).state).toBe(FeatureState.Available);

  // Change app display_name name
  fx.usecase.updateClient(DEMO_APP_NAME);
  fx.usecase.changeMetadata({ title: "dummy2" });
  await playing(fx, { title: "dummy2" });
  expect(fx.atv.metadata.app!.name).toBe(DEMO_APP_NAME);

  // Do not include display name and reuse previous one
  fx.usecase.updateClient(null);
  fx.usecase.changeMetadata({ title: "dummy3" });
  await playing(fx, { title: "dummy3" });
  expect(fx.atv.metadata.app!.name).toBe(DEMO_APP_NAME);
});

test("skip forward backward", async () => {
  fx.usecase.exampleVideo({ supportedCommands: [CommandInfo.SkipForward, CommandInfo.SkipBackward], skipTime: 12 });

  // Get initial position and use as base
  let prevPosition = (await playing(fx, { title: "dummy" })).position!;

  await fx.atv.remoteControl.skipForward();
  fx.usecase.changeMetadata({ title: "dummy2" });
  let metadata = await playing(fx, { title: "dummy2" });
  expect(metadata.position).toBe(prevPosition + 12);
  prevPosition = metadata.position!;

  // Change skip time 8 to verify that we respect provided values
  fx.usecase.changeState({ title: "dummy3", skipTime: 8 });
  metadata = await playing(fx, { title: "dummy3" });

  await fx.atv.remoteControl.skipBackward();
  fx.usecase.changeMetadata({ title: "dummy4" });
  metadata = await playing(fx, { title: "dummy4" });
  expect(metadata.position).toBe(prevPosition - 8);
  prevPosition = metadata.position!;

  // Test specified skip time
  await fx.atv.remoteControl.skipForward(17);
  fx.usecase.changeMetadata({ title: "dummy5" });
  metadata = await playing(fx, { title: "dummy5" });
  expect(metadata.position).toBe(prevPosition + 17);
});

test("button play pause", async () => {
  fx.usecase.exampleVideo({ supportedCommands: [CommandInfo.TogglePlayPause] });
  await playing(fx, { title: "dummy" });
  await fx.atv.remoteControl.playPause();
  await until(() => fx.state.lastButtonPressed === "playpause");
});

test("play pause emulation", async () => {
  fx.usecase.exampleVideo({ paused: false });
  await playing(fx, { deviceState: DeviceState.Playing });
  assertFeatures(fx, FeatureState.Unavailable, FeatureName.PlayPause);

  await fx.atv.remoteControl.playPause();
  await until(() => fx.state.lastButtonPressed === "pause");

  fx.usecase.exampleVideo({ paused: true, supportedCommands: [CommandInfo.Play, CommandInfo.Pause] });
  await playing(fx, { deviceState: DeviceState.Paused });
  assertFeatures(fx, FeatureState.Available, FeatureName.PlayPause);

  await fx.atv.remoteControl.playPause();
  await until(() => fx.state.lastButtonPressed === "play");
});

test("update client before setstate", async () => {
  fx.usecase.updateClient(APP_NAME, TEST_PLAYER);
  fx.usecase.exampleVideo({ title: "test", player: TEST_PLAYER, appName: null });

  await playing(fx, { title: "test" });
  expect(fx.atv.metadata.app!.name).toBe(APP_NAME);
  expect(fx.atv.metadata.app!.identifier).toBe(TEST_PLAYER);
});

test("set default commands", async () => {
  fx.usecase.defaultSupportedCommands([CommandInfo.Play, CommandInfo.Pause]);
  fx.usecase.exampleVideo();

  await playing(fx, { title: "dummy" });
  assertFeatures(fx, FeatureState.Available, FeatureName.Play, FeatureName.Pause);
});

test("playing immutable update content item", async () => {
  fx.usecase.exampleVideo({ position: 1 });
  const p = await playing(fx, { title: "dummy" });

  fx.usecase.changeMetadata({ position: 100 });
  await playing(fx, { position: 100 });

  expect(p.position).toBe(1);
});

test("metadata tv playing", async () => {
  fx.usecase.tvPlaying({
    paused: false,
    seriesName: "tv",
    totalTime: 40,
    position: 10,
    seasonNumber: 12,
    episodeNumber: 4,
    contentIdentifier: "identifier",
    itunesStoreIdentifier: 123456789,
  });

  await faketime([0], async () => {
    const p = await playing(fx, { seriesName: "tv" });
    expect(p.mediaType).toBe(MediaType.Video);
    expect(p.deviceState).toBe(DeviceState.Playing);
    expect(p.seriesName).toBe("tv");
    expect(p.totalTime).toBe(40);
    expect(p.position).toBe(10);
    expect(p.seasonNumber).toBe(12);
    expect(p.episodeNumber).toBe(4);
    expect(p.contentIdentifier).toBe("identifier");
    expect(p.itunesStoreIdentifier).toBe(123456789);
  });

  assertFeatures(
    fx,
    FeatureState.Available,
    FeatureName.SeriesName,
    FeatureName.TotalTime,
    FeatureName.Position,
    FeatureName.SeasonNumber,
    FeatureName.EpisodeNumber,
    FeatureName.ContentIdentifier,
  );
});

test("absolute volume features", async () => {
  const features = [FeatureName.Volume, FeatureName.SetVolume];
  assertFeatures(fx, FeatureState.Unavailable, ...features);

  fx.usecase.changeVolumeControl(true, false, true);
  fx.usecase.exampleVideo({ title: "dummy2" });
  await playing(fx, { title: "dummy2" });
  assertFeatures(fx, FeatureState.Unavailable, ...features);

  fx.usecase.changeVolumeControl(true, true, false);
  fx.usecase.exampleVideo({ title: "dummy3" });
  await playing(fx, { title: "dummy3" });
  assertFeatures(fx, FeatureState.Available, ...features);

  fx.usecase.changeVolumeControl(true, true, true);
  fx.usecase.exampleVideo({ title: "dummy4" });
  await playing(fx, { title: "dummy4" });
  assertFeatures(fx, FeatureState.Available, ...features);
});

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) || a === b;
const setVolumeAvailable = () => until(() => fx.atv.features.inState(FeatureState.Available, FeatureName.SetVolume));

test("volume change", async () => {
  fx.usecase.changeVolumeControl(true);
  await until(() => isClose(fx.atv.audio.volume, 0.0));
  await setVolumeAvailable();

  // Manually set a new volume level
  await fx.atv.audio.setVolume(20.0);
  await until(() => isClose(fx.atv.audio.volume, 20.0));

  // Trigger volume change from device
  fx.usecase.setVolume(0.3, DEVICE_UID);
  await until(() => isClose(fx.atv.audio.volume, 30.0));
});

for (const [kind, relative] of [
  ["relative", true],
  ["absolute", false],
] as const) {
  test(`audio volume up increases volume ${kind}`, async () => {
    fx.usecase.changeVolumeControl(true, true, relative);
    await setVolumeAvailable();
    await fx.atv.audio.setVolume(20.0);
    await until(() => isClose(fx.atv.audio.volume, 20.0));

    await fx.atv.audio.volumeUp();
    await until(() => fx.atv.audio.volume === Math.round(20.0 + VOLUME_STEP * 100.0));

    await fx.atv.audio.volumeUp();
    await until(() => fx.atv.audio.volume === Math.round(20.0 + 2 * VOLUME_STEP * 100.0));
  });

  test(`audio volume down decreases volume ${kind}`, async () => {
    fx.usecase.changeVolumeControl(true, true, relative);
    fx.usecase.changeVolumeControl(true);
    await setVolumeAvailable();
    await fx.atv.audio.setVolume(20.0);
    await until(() => isClose(fx.atv.audio.volume, 20.0));

    await fx.atv.audio.volumeDown();
    await until(() => fx.atv.audio.volume === Math.round(20 - VOLUME_STEP * 100.0));

    await fx.atv.audio.volumeDown();
    await until(() => fx.atv.audio.volume === Math.round(20 - 2 * VOLUME_STEP * 100.0));
  });

  test(`audio volume up above max ${kind}`, async () => {
    fx.usecase.changeVolumeControl(true, true, relative);
    await setVolumeAvailable();
    await fx.atv.audio.setVolume(100.0);
    await until(() => isClose(fx.atv.audio.volume, 100.0));

    // Should not yield a timeout
    await fx.atv.audio.volumeUp();
  });

  test(`audio volume down below zero ${kind}`, async () => {
    fx.usecase.changeVolumeControl(true, true, relative);
    await setVolumeAvailable();
    await fx.atv.audio.setVolume(0.0);
    await until(() => isClose(fx.atv.audio.volume, 0.0));

    // Should not yield a timeout
    await fx.atv.audio.volumeDown();
  });
}

test("volume clustered devices", async () => {
  const clusterId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  fx.usecase.setClusterId(clusterId);
  fx.usecase.changeVolumeControl(true);
  await setVolumeAvailable();

  // Manually set a new volume level
  await fx.atv.audio.setVolume(20.0);
  await until(() => isClose(fx.atv.audio.volume, 20.0));

  // Trigger volume change from device with wrong id
  fx.usecase.setVolume(0.3, DEVICE_UID);
  await until(() => isClose(fx.atv.audio.volume, 20.0));

  // Trigger volume change from device
  fx.usecase.setVolume(0.3, clusterId);
  await until(() => isClose(fx.atv.audio.volume, 30.0));
});

test("output devices", () => {
  expect(sameDevices(fx.atv.audio.outputDevices, [new OutputDevice("E510C430-B01D-45DF-B558-6EA6F8251069", "Fake MRP ATV")])).toBe(
    true,
  );
});

test("output devices change", async () => {
  const atvDevice = new OutputDevice("E510C430-B01D-45DF-B558-6EA6F8251069", "Fake MRP ATV");
  const deviceAA = new OutputDevice("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "Device AA");

  await fx.atv.audio.addOutputDevices("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  await until(() => sameDevices(fx.atv.audio.outputDevices, [atvDevice, deviceAA]));

  await fx.atv.audio.removeOutputDevices("E510C430-B01D-45DF-B558-6EA6F8251069");
  await until(() => sameDevices(fx.atv.audio.outputDevices, [deviceAA]));

  await fx.atv.audio.setOutputDevices("E510C430-B01D-45DF-B558-6EA6F8251069");
  await until(() => sameDevices(fx.atv.audio.outputDevices, [atvDevice]));
});
