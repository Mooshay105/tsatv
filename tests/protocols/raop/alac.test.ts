/** Unit tests for uncompressed ALAC frames. */

import { expect, test } from "bun:test";
import { encodeUncompressedAlac } from "../../../src/protocols/raop/alac.ts";

// Small reference decoder for uncompressed ALAC frames
function decode(frame: Buffer): { tag: number; frames: number; samples: Buffer; end: number } {
  let pos = 0;
  const read = (bits: number) => {
    let value = 0;
    for (let i = 0; i < bits; i++, pos++) value = value * 2 + ((frame[pos >> 3]! >> (7 - (pos & 7))) & 1);
    return value;
  };
  const tag = read(3);
  expect(read(4)).toBe(0); // instance
  expect(read(12)).toBe(0); // unused
  expect(read(1)).toBe(1); // has size
  expect(read(2)).toBe(0); // shift
  expect(read(1)).toBe(1); // not compressed
  const frames = read(32);
  const channels = tag === 1 ? 2 : 1;
  const samples = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < samples.length; i++) samples[i] = read(8);
  return { tag, frames, samples, end: read(3) };
}

test("stereo frame round trip", () => {
  const pcm = Buffer.alloc(352 * 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 37) & 0xff;
  const frame = encodeUncompressedAlac(pcm, 2);
  const decoded = decode(frame);
  expect(decoded.tag).toBe(1);
  expect(decoded.frames).toBe(352);
  expect(decoded.samples).toEqual(pcm);
  expect(decoded.end).toBe(7);
  expect(frame.length).toBe(Math.ceil((55 + pcm.length * 8 + 3) / 8));
});

test("mono frame round trip", () => {
  const pcm = Buffer.from([0x12, 0x34, 0xff, 0xfe, 0x80, 0x00]);
  const decoded = decode(encodeUncompressedAlac(pcm, 1));
  expect(decoded.tag).toBe(0);
  expect(decoded.frames).toBe(3);
  expect(decoded.samples).toEqual(pcm);
});

test("partial frames are dropped", () => {
  expect(decode(encodeUncompressedAlac(Buffer.from([1, 2, 3, 4, 5]), 2)).frames).toBe(1);
});

test("unsupported channels", () => {
  expect(() => encodeUncompressedAlac(Buffer.alloc(12), 6)).toThrow(RangeError);
});
