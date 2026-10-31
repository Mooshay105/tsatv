import { expect, test } from "bun:test";
import { defpacket } from "../../src/support/packet.ts";
import { b } from "../utils.ts";

const Foo = defpacket("Foo", { a: "c", b: "h" });
const Bar = Foo.extend("Bar", { c: "I" });

test("encode messages", () => {
  expect(Foo.encode(b("\x16"), 0x123)).toEqual(b("\x16\x01\x23"));
});

test("decode message", () => {
  const decoded = Foo.decode(b("\x16\x01\x23"));
  expect(decoded.a).toEqual(b("\x16"));
  expect(decoded.b).toBe(0x123);
});

test("decode with excessive data", () => {
  const decoded = Foo.decode(b("\x17\x02\x34\x11\x22\x33"), true);
  expect(decoded.a).toEqual(b("\x17"));
  expect(decoded.b).toBe(0x234);
});

test("extend encode", () => {
  expect(Bar.encode(b("\x77"), 0x67, 0xaabbccdd)).toEqual(b("\x77\x00\x67\xaa\xbb\xcc\xdd"));
});

test("extend decode", () => {
  const decoded = Bar.decode(b("\x77\x00\x67\xaa\xbb\xcc\xdd"));
  expect(decoded.a).toEqual(b("\x77"));
  expect(decoded.b).toBe(0x0067);
  expect(decoded.c).toBe(0xaabbccdd);
});

test("message length", () => {
  expect(Foo.length).toBe(3);
  expect(Bar.length).toBe(3 + 4);
});
