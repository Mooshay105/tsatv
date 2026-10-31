/** Functional tests using the API with a fake DMAP Apple TV. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { connect } from "../../../src/index.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { FeatureName, FeatureState, InputAction, OperatingSystem, Protocol, RepeatState, ShuffleState } from "../../../src/const.ts";
import { AuthenticationError, NotSupportedError } from "../../../src/exceptions.ts";
import type * as iface from "../../../src/interface.ts";
import { waitFor } from "../../../src/support/asyncio.ts";
import { getLogger } from "../../../src/support/logging.ts";
import {
  assertFeatures,
  commonFunctionalTests,
  DummyDeviceListener,
  type FunctionalFixture,
  playing,
  waitForButtonPress,
} from "../../common_functional_tests.ts";
import { DEVICE_CREDENTIALS } from "../../fake_device/airplay.ts";
import "../../fake_device/dmap.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import { until } from "../../utils.ts";

const LOGGER = getLogger("tests.protocols.dmap.functional");

const HSGID = "12345678-6789-1111-2222-012345678911";
const PAIRING_GUID = "0x0000000000000001";
const SESSION_ID = 55555;

const ARTWORK_BYTES = Buffer.from("1234");
const ARTWORK_MIMETYPE = "image/png";

const SKIP_TIME = 10;

const dummyPushListener: iface.PushListener = {
  playstatusUpdate(updater) {
    updater.stop();
  },
  playstatusError() {},
};

const fx = {} as FunctionalFixture & { dmapService: ManualService; extraAtvs: iface.AppleTV[] };

async function getConnectedDevice(hsgid: string): Promise<iface.AppleTV> {
  fx.dmapService = new ManualService("dmapid", Protocol.DMAP, fx.fakeAtv.serverPort, {});
  fx.dmapService.credentials = hsgid;
  const airplayService = new ManualService("airplay_id", Protocol.AirPlay, fx.fakeAtv.getPort(Protocol.AirPlay), {
    features: "0x1", // AirPlayVideoV1 supported
  });
  airplayService.credentials = DEVICE_CREDENTIALS;
  fx.conf = new AppleTV("127.0.0.1", "Apple TV", { properties: { "_appletv-v2._tcp.local": {} } });
  fx.conf.addService(fx.dmapService);
  fx.conf.addService(airplayService);
  const atv = await connect(fx.conf);
  fx.extraAtvs.push(atv);
  return atv;
}

beforeEach(async () => {
  fx.extraAtvs = [];
  fx.fakeAtv = new FakeAppleTV();
  [fx.state, fx.usecase] = fx.fakeAtv.addService(Protocol.DMAP, { hsgid: HSGID, pairingGuid: PAIRING_GUID, sessionId: SESSION_ID });
  [fx.airplayState, fx.airplayUsecase] = fx.fakeAtv.addService(Protocol.AirPlay);
  await fx.fakeAtv.start();
  fx.atv = await getConnectedDevice(HSGID);
});

afterEach(async () => {
  for (const atv of fx.extraAtvs) await Promise.allSettled(atv.close());
  await fx.fakeAtv.stop();
});

commonFunctionalTests(fx, { supportedVolumeControls: [FeatureName.VolumeUp, FeatureName.VolumeDown] });

test("app not supported", () => {
  expect(() => fx.atv.metadata.app).toThrow(NotSupportedError);
});

test("connect failed", async () => {
  // Twice since the client will retry one time
  fx.usecase.makeLoginFail();
  fx.usecase.makeLoginFail();
  await expect(getConnectedDevice(HSGID)).rejects.toThrow(AuthenticationError);
});

// This test verifies issue #2 (automatic re-login). It uses the artwork API, but it
// could have been any API since the login code is the same.
test("relogin if session expired", async () => {
  // Here, we are logged in and currently have a session id. These usescases will
  // result in being logged out (HTTP 403) and forcing a re-login with a new session
  // id (1234)
  fx.usecase.exampleVideo();
  fx.usecase.forceRelogin(1234);
  fx.usecase.artworkNoPermission();
  fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE);

  const artwork = await fx.atv.metadata.artwork();
  expect(artwork!.bytes).toEqual(ARTWORK_BYTES);
});

test("metadata artwork size", async () => {
  fx.usecase.exampleVideo();
  fx.usecase.changeArtwork(ARTWORK_BYTES, ARTWORK_MIMETYPE);
  await playing(fx, { title: "dummy" });

  // DMAP does not indicate dimensions of artwork, so -1 is returned here. In the
  // future, extracting dimensions from PNG header should be feasible.
  const artwork = await fx.atv.metadata.artwork(123, 456);
  expect(artwork).not.toBeNull();
  expect(artwork!.width).toBe(-1);
  expect(artwork!.height).toBe(-1);

  // Verify that the specified width and height was requested
  expect(fx.state.lastArtworkWidth).toBe(123);
  expect(fx.state.lastArtworkHeight).toBe(456);
});

test("login with pairing guid succeed", async () => {
  fx.atv.close();

  // This call will connect and trigger re-login
  await getConnectedDevice(PAIRING_GUID);
});

test("connection lost", async () => {
  fx.usecase.serverClosesConnection();

  const deviceListener = new DummyDeviceListener();
  fx.atv.listener = deviceListener;
  fx.atv.pushUpdater.listener = dummyPushListener;
  fx.atv.pushUpdater.start();

  await waitFor(deviceListener.lostSem.acquire(), 3.0);
});

test("button unsupported raises", async () => {
  for (const button of ["home", "suspend", "wakeup"] as const) {
    await expect((fx.atv.remoteControl[button] as () => Promise<void>).call(fx.atv.remoteControl)).rejects.toThrow(
      NotSupportedError,
    );
  }
});

test("button top menu", async () => {
  await fx.atv.remoteControl.topMenu();
  await waitForButtonPress(fx, "topmenu", InputAction.SingleTap);
});

test("button play pause", async () => {
  await fx.atv.remoteControl.playPause();
  await until(() => fx.state.lastButtonPressed === "playpause");
});

test("shuffle state albums", async () => {
  // DMAP does not support "albums" as shuffle state, so it is mapped to "songs"
  fx.usecase.exampleVideo({ shuffle: ShuffleState.Albums });
  const p = await playing(fx, { shuffle: ShuffleState.Songs });
  expect(p.shuffle).toBe(ShuffleState.Songs);
});

test("set shuffle albums", async () => {
  fx.usecase.exampleVideo();

  // DMAP does not support "albums" as shuffle state, so it is mapped to "songs"
  await fx.atv.remoteControl.setShuffle(ShuffleState.Albums);
  const p = await playing(fx, { shuffle: ShuffleState.Songs });
  expect(p.shuffle).toBe(ShuffleState.Songs);
});

test("play url no service", async () => {
  const conf = new AppleTV("127.0.0.1", "Apple TV");
  conf.addService(fx.dmapService);

  const atv = await connect(conf);
  fx.extraAtvs.push(atv);
  await expect(atv.stream.playUrl("http://123")).rejects.toThrow(NotSupportedError);
  atv.close();
});

test("basic device info", () => {
  expect(fx.atv.deviceInfo.operatingSystem).toBe(OperatingSystem.Legacy);
});

test("always available features", () => {
  assertFeatures(
    fx,
    FeatureState.Available,
    FeatureName.Down,
    FeatureName.Left,
    FeatureName.Menu,
    FeatureName.Right,
    FeatureName.Select,
    FeatureName.TopMenu,
    FeatureName.Up,
  );
});

test("unsupported features", () => {
  assertFeatures(
    fx,
    FeatureState.Unsupported,
    FeatureName.Home,
    FeatureName.HomeHold,
    FeatureName.Suspend,
    FeatureName.WakeUp,
    FeatureName.PowerState,
    FeatureName.TurnOn,
    FeatureName.TurnOff,
    FeatureName.App,
  );
});

test("always unknown features", () => {
  assertFeatures(
    fx,
    FeatureState.Unknown,
    FeatureName.Artwork,
    FeatureName.Next,
    FeatureName.Pause,
    FeatureName.Play,
    FeatureName.PlayPause,
    FeatureName.Previous,
    FeatureName.SetPosition,
    FeatureName.SetRepeat,
    FeatureName.SetShuffle,
    FeatureName.Stop,
    FeatureName.SkipForward, // Depends on SetPosition
    FeatureName.SkipBackward, // Depends on SetPosition
  );
});

test("features shuffle repeat", async () => {
  fx.usecase.nothingPlaying();
  await playing(fx);
  assertFeatures(fx, FeatureState.Unavailable, FeatureName.Shuffle, FeatureName.Repeat);

  fx.usecase.exampleMusic({ shuffle: ShuffleState.Albums, repeat: RepeatState.Track });
  await playing(fx, { title: "music" });
  assertFeatures(fx, FeatureState.Available, FeatureName.Shuffle, FeatureName.Repeat);
});

test("skip forward backward", async () => {
  fx.usecase.exampleVideo();

  let prevPosition = (await playing(fx, { title: "dummy" })).position!;

  await fx.atv.remoteControl.skipForward();
  let metadata = await playing(fx);
  expect(metadata.position).toBe(prevPosition + SKIP_TIME);
  prevPosition = metadata.position!;

  await fx.atv.remoteControl.skipBackward();
  metadata = await playing(fx);
  expect(metadata.position).toBe(prevPosition - SKIP_TIME);
  prevPosition = metadata.position!;

  await fx.atv.remoteControl.skipForward(13.0);
  metadata = await playing(fx);
  expect(metadata.position).toBe(prevPosition + 13);
  prevPosition = metadata.position!;

  await fx.atv.remoteControl.skipBackward(11.0);
  metadata = await playing(fx);
  expect(metadata.position).toBe(prevPosition - 11);
});

/**
 * Test that revision is reset when an error occurs during push update.
 *
 * This test sets up video as playing with revision 0. When the push updater starts,
 * that video is returned to the listener. After that, the next update is fetched with
 * revision 1. Since no media is configured for that revision, an error occurs where new
 * video is configured for revision 0 again (now with "title2" as title), which is
 * fetched and returned to the listener.
 */
test("reset revision if push updates fail", async () => {
  const listener = {
    playing: null as iface.Playing | null,
    playstatusUpdate(_updater: iface.PushUpdater, playstatus: iface.Playing) {
      LOGGER.debug("Got playstatus: %s", playstatus);
      this.playing = playstatus;
    },
    playstatusError(_updater: iface.PushUpdater, exception: Error) {
      LOGGER.warning("Got error: %s", exception);

      // Set new content for revision 0 as an error should reset revision
      fx.usecase.exampleVideo({ title: "video2", revision: 0 });
    },
  };

  fx.usecase.exampleVideo({ title: "video1", revision: 0 });

  fx.atv.pushUpdater.listener = listener;
  fx.atv.pushUpdater.start();

  await until(() => listener.playing?.title === "video2");
  expect(listener.playing!.title).toBe("video2");
});
