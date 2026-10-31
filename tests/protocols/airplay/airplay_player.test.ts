/** Unit tests for pyatv.protocols.airplay.player. */

import { expect, test } from "bun:test";
import { NO_CREDENTIALS } from "../../../src/auth/hap_pairing.ts";
import { AuthenticationError, PlaybackError } from "../../../src/exceptions.ts";
import { AirPlayPlayer } from "../../../src/protocols/airplay/player.ts";
import { StreamContext } from "../../../src/protocols/raop/protocols/index.ts";
import { AirPlayV1 } from "../../../src/protocols/raop/protocols/airplayv1.ts";
import { RtspSession } from "../../../src/support/rtsp.ts";
import { totalSleepTime } from "../../utils.ts";
import { useAirPlayDevice } from "./shared.ts";

const STREAM = "http://airplaystream";
const START_POSITION = 0.8;

const fixture = useAirPlayDevice();

async function airplayPlayer(): Promise<AirPlayPlayer> {
  const rtsp = new RtspSession(await fixture.connection());
  const context = new StreamContext();
  context.credentials = NO_CREDENTIALS;
  return new AirPlayPlayer(rtsp, new AirPlayV1(context, rtsp));
}

test("play video", async () => {
  fixture.usecase.airplayPlaybackIdle();
  fixture.usecase.airplayPlaybackPlaying();
  fixture.usecase.airplayPlaybackIdle();

  await (await airplayPlayer()).playUrl(STREAM, START_POSITION);

  expect(fixture.state.lastAirplayUrl).toBe(STREAM);
  expect(fixture.state.lastAirplayStart).toBe(START_POSITION);
  expect(fixture.state.lastAirplayUuid).not.toBeNull();
  expect(totalSleepTime()).toBeCloseTo(2.0);
});

test("play video no permission", async () => {
  fixture.usecase.airplayPlaybackPlayingNoPermission();
  await expect((await airplayPlayer()).playUrl(STREAM, START_POSITION)).rejects.toThrow(AuthenticationError);
});

test("play with retries", async () => {
  fixture.usecase.airplayPlayFailure(2);
  fixture.usecase.airplayPlaybackPlaying();
  fixture.usecase.airplayPlaybackIdle();

  await (await airplayPlayer()).playUrl(STREAM, START_POSITION);
  expect(fixture.state.playCount).toBe(3);
});

test("play with too many retries", async () => {
  fixture.usecase.airplayPlayFailure(10);
  fixture.usecase.airplayPlaybackPlaying();
  fixture.usecase.airplayPlaybackIdle();

  await expect((await airplayPlayer()).playUrl(STREAM, START_POSITION)).rejects.toThrow(PlaybackError);
});
