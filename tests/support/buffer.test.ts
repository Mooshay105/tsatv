import { describe, expect, test } from "bun:test";
import { InvalidStateError } from "../../src/exceptions.ts";
import { SemiSeekableBuffer } from "../../src/support/buffer.ts";
import { b } from "../utils.ts";

const BUFFER_SIZE = 5;
const HEADROOM = 2;

const buffer = () => new SemiSeekableBuffer(BUFFER_SIZE, { seekableHeadroom: 0 });
const headroomBuffer = () => new SemiSeekableBuffer(BUFFER_SIZE, { seekableHeadroom: HEADROOM });
const protectedBuffer = () => {
  const buf = new SemiSeekableBuffer(BUFFER_SIZE, { seekableHeadroom: HEADROOM });
  buf.protectedHeadroom = true;
  return buf;
};

test("get empty buffer", () => {
  expect(buffer().get(1)).toEqual(b(""));
});

test("add and get", () => {
  const buf = buffer();
  buf.add(b("abc"));
  expect(buf.get(1)).toEqual(b("a"));
  expect(buf.get(2)).toEqual(b("bc"));
  expect(buf.get(1)).toEqual(b(""));
});

test("add until full", () => {
  const buf = buffer();
  expect(buf.add(b("a".repeat(BUFFER_SIZE - 1)))).toBe(BUFFER_SIZE - 1);
  expect(buf.add(b("aa"))).toBe(1);
  expect(buf.add(b("a"))).toBe(0);
});

test("buffer size", () => {
  const buf = buffer();
  expect(buf.size).toBe(0);
  buf.add(b("a"));
  expect(buf.size).toBe(1);
  expect(buf.length).toBe(1);
  buf.add(b("abc"));
  expect(buf.size).toBe(4);
  buf.add(b("a".repeat(BUFFER_SIZE - 4)));
  expect(buf.size).toBe(BUFFER_SIZE);
  buf.add(b("a"));
  expect(buf.size).toBe(BUFFER_SIZE);
  expect(buf.length).toBe(BUFFER_SIZE);
});

test("buffer emptyness", () => {
  const buf = buffer();
  expect(buf.empty()).toBe(true);
  buf.add(b("a"));
  expect(buf.empty()).toBe(false);
  buf.get(1);
  expect(buf.empty()).toBe(true);
});

test("buffer remaining", () => {
  const buf = buffer();
  expect(buf.remaining).toBe(BUFFER_SIZE);
  buf.add(b("a"));
  expect(buf.remaining).toBe(BUFFER_SIZE - 1);
  buf.add(b("a".repeat(BUFFER_SIZE)));
  expect(buf.remaining).toBe(0);
});

test("position no seeking", () => {
  const buf = buffer();
  expect(buf.position).toBe(0);
  buf.add(b("aaa"));
  expect(buf.position).toBe(0);
  buf.get(1);
  expect(buf.position).toBe(1);
  buf.get(2);
  expect(buf.position).toBe(3);
  buf.get(3);
  expect(buf.position).toBe(3);
});

test("invalid seekable headroom", () => {
  expect(() => new SemiSeekableBuffer(1, { seekableHeadroom: 2 })).toThrow(RangeError);
});

test("seek outside of buffer", () => {
  expect(headroomBuffer().seek(1)).toBe(false);
});

test("simple seek within headroom", () => {
  const buf = headroomBuffer();
  buf.add(b("aaaa"));
  expect(buf.seek(1)).toBe(true);
  expect(buf.seek(2)).toBe(false);
  expect(buf.seek(0)).toBe(true);
});

test("seek outside of headroom not possible", () => {
  const buf = headroomBuffer();
  buf.add(b("a".repeat(BUFFER_SIZE)));
  expect(buf.seek(HEADROOM - 1)).toBe(true);
  expect(buf.seek(HEADROOM)).toBe(false);
});

test("get partial data allows seeking", () => {
  const buf = headroomBuffer();
  buf.add(b("abcde"));
  expect(buf.get(1)).toEqual(b("a"));
  expect(buf.size).toBe(4);
  expect(buf.position).toBe(1);
  buf.seek(0);
  expect(buf.size).toBe(5);
  expect(buf.position).toBe(0);
  expect(buf.get(1)).toEqual(b("a"));
  expect(buf.size).toBe(4);
  expect(buf.position).toBe(1);
});

test("get all headroom disallows seeking", () => {
  const buf = headroomBuffer();
  buf.add(b("abcde"));
  expect(buf.get(2)).toEqual(b("ab"));
  expect(buf.seek(0)).toBe(false);
  expect(buf.size).toBe(3);
  expect(buf.position).toBe(2);
});

test("can add after headroom is removed", () => {
  const buf = headroomBuffer();
  buf.add(b("abcde"));
  buf.get(3);
  expect(buf.size).toBe(2);
  expect(buf.position).toBe(3);
  buf.add(b("abcde"));
  expect(buf.size).toBe(5);
  expect(buf.position).toBe(3);
  expect(buf.get(5)).toEqual(b("deabc"));
  expect(buf.size).toBe(0);
  expect(buf.position).toBe(8);
  buf.add(b("abcde"));
  expect(buf.size).toBe(5);
  expect(buf.position).toBe(8);
  expect(buf.get(5)).toEqual(b("abcde"));
  expect(buf.size).toBe(0);
  expect(buf.position).toBe(13);
});

test("enable disable protected after get fails", () => {
  const buf = protectedBuffer();
  buf.add(b("abc"));
  buf.get(1);
  buf.protectedHeadroom = true;
  expect(() => {
    buf.protectedHeadroom = false;
  }).toThrow(InvalidStateError);
});

test("protected does not remove data", () => {
  const buf = protectedBuffer();
  buf.add(b("abcdef"));
  expect(buf.size).toBe(5);
  expect(buf.position).toBe(0);
  expect(buf.get(2)).toEqual(b("ab"));
  expect(buf.size).toBe(3);
  expect(buf.position).toBe(2);
  expect(buf.get(4)).toEqual(b("cde"));
  expect(buf.size).toBe(0);
  expect(buf.position).toBe(5);
  expect(buf.add(b("ggg"))).toBe(0);
  expect(buf.size).toBe(0);
  expect(buf.position).toBe(5);
  expect(buf.seek(0)).toBe(true);
  expect(buf.size).toBe(5);
  expect(buf.position).toBe(0);
  expect(buf.get(5)).toEqual(b("abcde"));
  expect(buf.size).toBe(0);
  expect(buf.position).toBe(5);
});

test("disable protected headroom after using it", () => {
  const buf = protectedBuffer();
  buf.add(b("abcdef"));
  expect(buf.get(2)).toEqual(b("ab"));
  expect(buf.size).toBe(3);
  expect(buf.position).toBe(2);
  expect(buf.seek(0)).toBe(true);
  buf.protectedHeadroom = false;
  expect(buf.get(6)).toEqual(b("abcde"));
  expect(buf.size).toBe(0);
  expect(buf.position).toBe(5);
  expect(buf.add(b("hij"))).toBe(3);
  expect(buf.size).toBe(3);
  expect(buf.position).toBe(5);
});

test("protected headroom constructor", () => {
  const buf = new SemiSeekableBuffer(BUFFER_SIZE, { seekableHeadroom: HEADROOM, protectedHeadroom: true });
  buf.add(b("abcde"));
  expect(buf.get(HEADROOM)).toEqual(b("ab"));
  expect(buf.position).toBe(2);
  expect(buf.seek(0)).toBe(true);
  expect(buf.position).toBe(0);
});

describe("fits in buffer", () => {
  test.each([
    [b("a"), true],
    [b("aa"), true],
    [b("aaa"), false],
    [1, true],
    [2, true],
    [3, false],
  ] as Array<[Buffer | number, boolean]>)("%p -> %p", (data, expected) => {
    const buf = buffer();
    buf.add(b("abc"));
    expect(buf.fits(data)).toBe(expected);
  });
});

test("fits with headroom present", () => {
  const buf = buffer();
  buf.add(b("a".repeat(BUFFER_SIZE)));
  buf.get(1);
  expect(buf.fits(2)).toBe(false);
});

test("seek current position ok", () => {
  const buf = buffer();
  expect(buf.seek(0)).toBe(true);
  buf.add(b("a".repeat(BUFFER_SIZE)));
  buf.get(HEADROOM);
  expect(buf.seek(1)).toBe(false);
  expect(buf.seek(2)).toBe(true);
});
