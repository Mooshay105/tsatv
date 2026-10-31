/** Unit tests for pyatv.protocols.dmap.daap. */

import { expect, test } from "bun:test";
import { DeviceState, MediaType } from "../../../src/const.ts";
import { UnknownMediaKindError, UnknownPlayStateError } from "../../../src/exceptions.ts";
import { mediaKind, msToS, playstate } from "../../../src/protocols/dmap/daap.ts";

test("unknown media kind", () => {
  expect(mediaKind(1)).toBe(MediaType.Unknown);
  expect(mediaKind(32770)).toBe(MediaType.Unknown);
});

test("video media kinds", () => {
  for (const kind of [3, 7, 32, 11, 12, 13, 18]) expect(mediaKind(kind)).toBe(MediaType.Video);
});

test("music media kinds", () => {
  for (const kind of [2, 4, 36, 10, 14, 17, 21]) expect(mediaKind(kind)).toBe(MediaType.Music);
});

test("tv kinds", () => {
  expect(mediaKind(8)).toBe(MediaType.TV);
  expect(mediaKind(64)).toBe(MediaType.TV);
});

test("unknown media kind throws", () => {
  expect(() => mediaKind(99999)).toThrow(UnknownMediaKindError);
});

test("device state no media", () => {
  expect(playstate(null)).toBe(DeviceState.Idle);
});

test("regular playstates", () => {
  expect(playstate(0)).toBe(DeviceState.Idle);
  expect(playstate(1)).toBe(DeviceState.Loading);
  expect(playstate(2)).toBe(DeviceState.Stopped);
  expect(playstate(3)).toBe(DeviceState.Paused);
  expect(playstate(4)).toBe(DeviceState.Playing);
  expect(playstate(5)).toBe(DeviceState.Seeking);
  expect(playstate(6)).toBe(DeviceState.Seeking);
});

test("unknown playstate throws", () => {
  expect(() => playstate(99999)).toThrow(UnknownPlayStateError);
});

test("no time returns zero", () => expect(msToS(null)).toBe(0));

test("time in seconds", () => {
  expect(msToS(400)).toBe(0);
  expect(msToS(501)).toBe(1);
  expect(msToS(36000)).toBe(36);
});

test("invalid time", () => expect(msToS(2 ** 32 - 1)).toBe(0));
