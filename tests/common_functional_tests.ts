/** Common functional tests for all protocols. */

import { expect, test } from "bun:test";
import { connect, pair } from "../src/index.ts";
import { AppleTV, ManualService } from "../src/conf.ts";
import { DeviceState, FeatureName, FeatureState, InputAction, MediaType, Protocol, RepeatState, ShuffleState } from "../src/const.ts";
import { DeviceIdMissingError, InvalidCredentialsError, NoServiceError, AuthenticationError } from "../src/exceptions.ts";
import type * as iface from "../src/interface.ts";
import { Semaphore, waitFor } from "../src/support/asyncio.ts";
import { getLogger } from "../src/support/logging.ts";
import type { FakeAirPlayState, FakeAirPlayUseCases } from "./fake_device/airplay.ts";
import type { FakeAppleTV } from "./fake_device/index.ts";
import { dataPath, faketime, until } from "./utils.ts";

const LOGGER = getLogger("tests.common_functional_tests");

export const ARTWORK_BYTES = Buffer.from("1234");
export const ARTWORK_BYTES2 = Buffer.from("4321");
export const ARTWORK_MIMETYPE = "image/png";
export const ARTWORK_WIDTH = 512;
export const ARTWORK_HEIGHT = 512;
export const ARTWORK_ID = "artwork_id1";
export const EXAMPLE_STREAM = "http://stream";

/** State shared between tests (set up by the protocol specific test file). */
export interface FunctionalFixture {
  fakeAtv: FakeAppleTV;
  atv: iface.AppleTV;
  conf: AppleTV;
  state: any;
  usecase: any;
  airplayState: FakeAirPlayState;
  airplayUsecase: FakeAirPlayUseCases;
}

/** Poll "playing" until all specified fields have the expected values. */
export async function playing(fx: FunctionalFixture, conditions: Record<string, unknown> = {}): Promise<iface.Playing> {
  return (await until(async () => {
    const result = await fx.atv.metadata.playing();
    const ok = Object.entries(conditions).every(([field, value]) => (result as any)[field] === value);
    return [ok, result];
  }))!;
}

export function assertFeatures(fx: FunctionalFixture, state: FeatureState, ...features: FeatureName[]): void {
  for (const feature of features) {
    expect(fx.atv.features.getFeature(feature).state, `${FeatureName[feature]} has wrong state`).toBe(state);
  }
}

export async function waitForButtonPress(fx: FunctionalFixture, button: string, action: InputAction | null): Promise<void> {
  await until(() => fx.state.lastButtonPressed === button);
  await until(() => fx.state.lastButtonAction === action);
}

export class DummyDeviceListener implements iface.DeviceListener {
  readonly closedSem = new Semaphore(0);
  readonly lostSem = new Semaphore(0);

  connectionLost(_exception: Error): void {
    this.lostSem.release();
  }

  connectionClosed(): void {
    this.closedSem.release();
  }
}

const enumValues = <T extends number>(e: Record<string, string | number>): T[] =>
  Object.values(e).filter((v): v is T => typeof v === "number") as T[];

export interface CommonOptions {
  /** Volume related features supported by the protocol. */
  supportedVolumeControls: FeatureName[];
  /** Names of tests that are overridden (or not applicable) for the protocol. */
  overrides?: string[];
}

/** Register the common functional tests for a protocol. */
export function commonFunctionalTests(fx: FunctionalFixture, options: CommonOptions): void {
  const overrides = new Set(options.overrides ?? []);
  const ptest = (name: string, fn: () => Promise<void> | void) => {
    if (!overrides.has(name)) test(name, fn);
  };

  ptest("connect missing device id", async () => {
    const conf = new AppleTV("1.2.3.4", "Apple TV");
    conf.addService(new ManualService(null, Protocol.Companion, 1234, {}));
    await expect(connect(conf)).rejects.toThrow(DeviceIdMissingError);
  });

  ptest("connect no service", async () => {
    const conf = new AppleTV("1.2.3.4", "Apple TV");
    await expect(connect(conf, { protocol: Protocol.AirPlay })).rejects.toThrow(NoServiceError);
  });

  ptest("pair missing service", async () => {
    const conf = new AppleTV("1.2.3.4", "Apple TV");
    await expect(pair(conf, Protocol.DMAP)).rejects.toThrow(NoServiceError);
  });

  ptest("invalid credentials format", async () => {
    fx.conf.mainService().credentials = "bad";
    await expect(connect(fx.conf)).rejects.toThrow(InvalidCredentialsError);
  });

  ptest("conf is a copy", async () => {
    const protocol = fx.conf.mainService().protocol;

    // Update credentials in the config passed to connect
    fx.conf.getService(protocol)!.merge(new ManualService("test", protocol, 0, {}, { credentials: "1234" }));

    // This should not result in a change to the service within the connected object
    const service = fx.atv.service;
    expect(service.protocol).toBe(protocol);
    expect(service.credentials).not.toBe("1234");
  });

  ptest("invalid airplay credentials format", async () => {
    fx.conf.getService(Protocol.AirPlay)!.credentials = "bad";
    fx.airplayUsecase.airplayRequireAuthentication();
    await expect(connect(fx.conf)).rejects.toThrow(InvalidCredentialsError);
  });

  ptest("play url", async () => {
    fx.airplayUsecase.airplayPlaybackIdle();
    fx.airplayUsecase.airplayPlaybackPlaying();
    fx.airplayUsecase.airplayPlaybackIdle();

    await fx.atv.stream.playUrl(EXAMPLE_STREAM);
    expect(fx.airplayState.lastAirplayUrl).toBe(EXAMPLE_STREAM);
    fx.atv.stream.close();
  });

  ptest("play url not authenticated error", async () => {
    fx.conf.getService(Protocol.AirPlay)!.credentials = null;
    fx.airplayUsecase.airplayAlwaysFailAuthentication();
    await expect(fx.atv.stream.playUrl(EXAMPLE_STREAM)).rejects.toThrow(AuthenticationError);
  });

  ptest("play url authenticated", async () => {
    fx.airplayUsecase.airplayRequireAuthentication();
    fx.airplayUsecase.airplayPlaybackIdle();
    fx.airplayUsecase.airplayPlaybackPlaying();
    fx.airplayUsecase.airplayPlaybackIdle();

    await fx.atv.stream.playUrl(EXAMPLE_STREAM);
    expect(fx.airplayState.lastAirplayUrl).toBe(EXAMPLE_STREAM);
  });

  // This is not a very good test as it doesn't really test that much. Once I get
  // around improving the AirPlay testing situation this should be improved.
  ptest("play local file", async () => {
    fx.airplayUsecase.airplayPlaybackIdle();
    fx.airplayUsecase.airplayPlaybackPlaying();
    fx.airplayUsecase.airplayPlaybackIdle();

    await fx.atv.stream.playUrl(dataPath("testfile.txt"));

    expect(fx.airplayState.lastAirplayUrl).toMatch(/http:\/\/127.0.0.1:[0-9]+\/testfile.txt/);
    expect(fx.airplayState.lastAirplayStart).toBe(0);
    expect(fx.airplayState.lastAirplayUuid).not.toBeNull();
    expect(fx.airplayState.lastAirplayContent).toEqual(Buffer.from("a file for testing"));
  });

  const buttons: Array<[string, keyof iface.RemoteControl, string, InputAction | null]> = [
    ["button up", "up", "up", InputAction.SingleTap],
    ["button down", "down", "down", InputAction.SingleTap],
    ["button left", "left", "left", InputAction.SingleTap],
    ["button right", "right", "right", InputAction.SingleTap],
    ["button select", "select", "select", InputAction.SingleTap],
    ["button menu", "menu", "menu", InputAction.SingleTap],
    ["button play", "play", "play", null],
    ["button pause", "pause", "pause", null],
    ["button stop", "stop", "stop", null],
    ["button next", "next", "nextitem", null],
    ["button previous", "previous", "previtem", null],
  ];
  for (const [name, method, button, action] of buttons) {
    ptest(name, async () => {
      await (fx.atv.remoteControl[method] as () => Promise<void>).call(fx.atv.remoteControl);
      await waitForButtonPress(fx, button, action);
    });
  }

  ptest("button volume up", async () => {
    await fx.atv.remoteControl.volumeUp();
    await until(() => fx.state.lastButtonPressed === "volumeup");
  });

  ptest("button volume down", async () => {
    await fx.atv.remoteControl.volumeDown();
    await until(() => fx.state.lastButtonPressed === "volumedown");
  });

  ptest("metadata device id", () => {
    expect(fx.conf.allIdentifiers).toContain(fx.atv.metadata.deviceId!);
  });

  ptest("close connection", async () => {
    const listener = new DummyDeviceListener();
    fx.atv.listener = listener;
    fx.atv.close();
    await waitFor(listener.closedSem.acquire(), 3.0);
  });

  ptest("metadata video paused", async () => {
    fx.usecase.videoPlaying({ paused: true, title: "dummy", totalTime: 100, position: 3 });

    await faketime([0], async () => {
      const p = await playing(fx, { title: "dummy" });
      expect(p.mediaType).toBe(MediaType.Video);
      expect(p.deviceState).toBe(DeviceState.Paused);
      expect(p.title).toBe("dummy");
      expect(p.totalTime).toBe(100);
      expect(p.position).toBe(3);
    });
  });

  ptest("metadata video playing", async () => {
    fx.usecase.videoPlaying({ paused: false, title: "video", totalTime: 40, position: 10 });

    await faketime([0], async () => {
      const p = await playing(fx, { title: "video" });
      expect(p.mediaType).toBe(MediaType.Video);
      expect(p.deviceState).toBe(DeviceState.Playing);
      expect(p.title).toBe("video");
      expect(p.totalTime).toBe(40);
      expect(p.position).toBe(10);
    });
  });

  ptest("metadata music paused", async () => {
    fx.usecase.musicPlaying({
      paused: true,
      title: "music",
      artist: "artist",
      album: "album",
      totalTime: 222,
      position: 49,
      genre: "genre",
    });

    await faketime([0], async () => {
      const p = await playing(fx, { title: "music" });
      expect(p.mediaType).toBe(MediaType.Music);
      expect(p.deviceState).toBe(DeviceState.Paused);
      expect(p.title).toBe("music");
      expect(p.artist).toBe("artist");
      expect(p.album).toBe("album");
      expect(p.genre).toBe("genre");
      expect(p.totalTime).toBe(222);
      expect(p.position).toBe(49);
    });
  });

  ptest("metadata music playing", async () => {
    fx.usecase.musicPlaying({
      paused: false,
      title: "music",
      artist: "test1",
      album: "test2",
      totalTime: 2,
      position: 1,
      genre: "genre",
    });

    await faketime([0], async () => {
      const p = await playing(fx, { title: "music" });
      expect(p.mediaType).toBe(MediaType.Music);
      expect(p.deviceState).toBe(DeviceState.Playing);
      expect(p.title).toBe("music");
      expect(p.artist).toBe("test1");
      expect(p.album).toBe("test2");
      expect(p.genre).toBe("genre");
      expect(p.totalTime).toBe(2);
      expect(p.position).toBe(1);
    });
  });

  ptest("seek in playing media", async () => {
    fx.usecase.videoPlaying({ paused: false, title: "dummy", totalTime: 40, position: 10 });

    await faketime([0], async () => {
      await fx.atv.remoteControl.setPosition(30);
      const p = await playing(fx, { position: 30 });
      expect(p.position).toBe(30);
    });
  });

  ptest("metadata artwork", async () => {
    fx.usecase.exampleVideo();
    fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE);

    await playing(fx, { title: "dummy" });
    const artwork = await fx.atv.metadata.artwork();
    expect(artwork).not.toBeNull();
    expect(artwork!.bytes).toEqual(ARTWORK_BYTES);
    expect(artwork!.mimetype).toBe(ARTWORK_MIMETYPE);
  });

  ptest("metadata artwork cache", async () => {
    fx.usecase.exampleVideo();
    fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE, ARTWORK_ID);

    await playing(fx, { title: "dummy" });

    let artwork = await fx.atv.metadata.artwork();
    expect(artwork).not.toBeNull();
    expect(artwork!.bytes).toEqual(ARTWORK_BYTES);

    const artworkId = fx.atv.metadata.artworkId;

    // Change artwork data for same identifier (not really legal)
    fx.usecase.changeArtwork(ARTWORK_BYTES2, ARTWORK_MIMETYPE, ARTWORK_ID);

    // Expect previous data from cache
    artwork = await fx.atv.metadata.artwork();
    expect(artwork).not.toBeNull();
    expect(artwork!.bytes).toEqual(ARTWORK_BYTES);

    // Artwork identifier should be the same before as after
    expect(fx.atv.metadata.artworkId).toBe(artworkId);
  });

  ptest("push updates", async () => {
    const listener = {
      playing: null as iface.Playing | null,
      playstatusUpdate(_updater: iface.PushUpdater, playstatus: iface.Playing) {
        LOGGER.debug("Got playstatus: %s", playstatus);
        this.playing = playstatus;
      },
      playstatusError(_updater: iface.PushUpdater, _exception: Error) {},
    };

    // TODO: This test is a little weird as it leaks DMAP details (revision). Should
    // revise and make it better or use different tests for each protocol.
    fx.usecase.videoPlaying({ paused: false, title: "video1", totalTime: 40, position: 10, revision: 0 });
    fx.usecase.videoPlaying({ paused: true, title: "video2", totalTime: 30, position: 20, revision: 0 });

    await playing(fx);

    // Setup push updates which will instantly get the next one ("video2")
    fx.atv.pushUpdater.listener = listener;
    fx.atv.pushUpdater.start();

    // Check that we got the right one
    await until(() => listener.playing?.title === "video2");
    expect(listener.playing!.title).toBe("video2");
  });

  ptest("push updater active", async () => {
    const listener = {
      playstatusUpdate(_updater: iface.PushUpdater, _playstatus: iface.Playing) {},
      playstatusError(_updater: iface.PushUpdater, _exception: Error) {},
    };

    fx.usecase.videoPlaying({ paused: false, title: "video1", totalTime: 40, position: 10, revision: 0 });

    expect(fx.atv.pushUpdater.active).toBe(false);

    fx.atv.pushUpdater.listener = listener;
    fx.atv.pushUpdater.start();
    expect(fx.atv.pushUpdater.active).toBe(true);

    fx.atv.pushUpdater.stop();
    expect(fx.atv.pushUpdater.active).toBe(false);
  });

  ptest("metadata artwork none if not available", async () => {
    fx.usecase.exampleVideo();
    fx.usecase.changeArtwork(Buffer.alloc(0), null);

    await playing(fx, { title: "dummy" });
    expect(await fx.atv.metadata.artwork()).toBeNull();
  });

  ptest("metadata none type when not playing", async () => {
    fx.usecase.nothingPlaying();

    const p = await playing(fx);
    expect(p.mediaType).toBe(MediaType.Unknown);
    expect(p.deviceState).toBe(DeviceState.Idle);
  });

  ptest("repeat state", async () => {
    for (const repeat of enumValues<RepeatState>(RepeatState)) {
      fx.usecase.exampleVideo({ repeat });
      const p = await playing(fx, { repeat });
      expect(p.repeat).toBe(repeat);
    }
  });

  ptest("set repeat", async () => {
    fx.usecase.videoPlaying({ paused: false, title: "video", totalTime: 40, position: 10 });
    for (const repeat of enumValues<RepeatState>(RepeatState)) {
      await fx.atv.remoteControl.setRepeat(repeat);
      const p = await playing(fx, { repeat });
      expect(p.repeat).toBe(repeat);
    }
  });

  ptest("shuffle state common", async () => {
    for (const shuffle of [ShuffleState.Off, ShuffleState.Songs]) {
      fx.usecase.exampleVideo({ shuffle });
      const p = await playing(fx, { shuffle });
      expect(p.shuffle).toBe(shuffle);
    }
  });

  ptest("set shuffle common", async () => {
    fx.usecase.exampleVideo();
    for (const shuffle of [ShuffleState.Off, ShuffleState.Songs]) {
      await fx.atv.remoteControl.setShuffle(shuffle);
      const p = await playing(fx, { shuffle });
      expect(p.shuffle).toBe(shuffle);
    }
  });

  ptest("metadata loading", async () => {
    fx.usecase.mediaIsLoading();
    const p = await playing(fx, { deviceState: DeviceState.Loading });
    expect(p.deviceState).toBe(DeviceState.Loading);
  });

  ptest("metadata seeking", async () => {
    fx.usecase.exampleVideo({ paused: false, playbackRate: 2.0 });
    let p = await playing(fx, { title: "dummy" });
    expect(p.deviceState).toBe(DeviceState.Seeking);

    fx.usecase.exampleVideo({ paused: false, title: "dummy2", playbackRate: 1.0 });
    p = await playing(fx, { title: "dummy2" });
    expect(p.deviceState).toBe(DeviceState.Playing);

    fx.usecase.exampleVideo({ paused: false, title: "dummy3", playbackRate: -1.0 });
    p = await playing(fx, { title: "dummy3" });
    expect(p.deviceState).toBe(DeviceState.Seeking);
  });

  ptest("features when playing", async () => {
    const featureList = [
      FeatureName.Title,
      FeatureName.Artist,
      FeatureName.Album,
      FeatureName.Genre,
      FeatureName.TotalTime,
      FeatureName.Position,
    ];

    // At first, no feature is available
    fx.usecase.nothingPlaying();
    await playing(fx);
    assertFeatures(fx, FeatureState.Unavailable, ...featureList);

    // Play some music and all features should be available
    fx.usecase.exampleMusic();
    await playing(fx, { title: "music" });
    assertFeatures(fx, FeatureState.Available, ...featureList);
  });

  ptest("features play url", () => {
    // TODO: As availability is based on zeroconf properties, this test just verifies
    // that PlayUrl is available.
    assertFeatures(fx, FeatureState.Available, FeatureName.PlayUrl);
  });

  ptest("playing immutable", async () => {
    fx.usecase.exampleVideo();
    const p = await playing(fx, { title: "dummy" });

    // This is not allowed to modify "playing" instance above
    fx.usecase.exampleMusic();
    await playing(fx, { title: "music" });

    // Not a conclusive check but enough to cover the basic idea
    expect(p.title).toBe("dummy");
    expect(p.totalTime).toBe(123);
    expect(p.position).toBe(3);
  });

  ptest("volume controls", async () => {
    const controls = options.supportedVolumeControls;
    assertFeatures(fx, FeatureState.Unavailable, ...controls);

    fx.usecase.changeVolumeControl(false);
    fx.usecase.exampleVideo();
    await playing(fx, { title: "dummy" });
    assertFeatures(fx, FeatureState.Unavailable, ...controls);

    fx.usecase.changeVolumeControl(true);
    fx.usecase.exampleVideo({ title: "dummy2" });
    await playing(fx, { title: "dummy2" });
    assertFeatures(fx, FeatureState.Available, ...controls);
  });

  // As DMAP is request based, volume control availability will not be automatically
  // updated when changed, i.e. it needs to be requested. This is the reason for
  // retrieving what is playing.
  ptest("audio volume controls", async () => {
    fx.usecase.changeVolumeControl(true);
    await fx.atv.metadata.playing();

    await until(() => fx.atv.features.inState(FeatureState.Available, FeatureName.VolumeUp, FeatureName.VolumeDown));

    await fx.atv.audio.volumeUp();
    await until(() => fx.state.lastButtonPressed === "volumeup");

    await fx.atv.audio.volumeDown();
    await until(() => fx.state.lastButtonPressed === "volumedown");
  });
}
