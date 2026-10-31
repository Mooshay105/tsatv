/** Unit tests for pyatv.support.opack. */

import { expect, test } from "bun:test";
import { NotImplementedError } from "../../src/exceptions.ts";
import { Float } from "../../src/support/float.ts";
import { pack, sizedInt, unpack } from "../../src/support/opack.ts";
import { UUID } from "../../src/support/uuid.ts";
import { b } from "../utils.ts";
import { MORE_PTR_PACKED, MORE_PTR_UNPACKED_INPUT } from "./opack_data.ts";

const rep = (s: string, n: number) => s.repeat(n);

// pack

test("pack unsupported type", () => {
  expect(() => pack(new Set())).toThrow(TypeError);
});

test("pack boolean", () => {
  expect(pack(true)).toEqual(b("\x01"));
  expect(pack(false)).toEqual(b("\x02"));
});

test("pack none", () => {
  expect(pack(null)).toEqual(b("\x04"));
});

test("pack uuid", () => {
  expect(pack(new UUID("{12345678-1234-5678-1234-567812345678}"))).toEqual(
    b("\x05\x12\x34\x56\x78\x12\x34\x56\x78\x12\x34\x56\x78\x12\x34\x56\x78"),
  );
});

test("pack absolute time", () => {
  expect(() => pack(new Date())).toThrow(NotImplementedError);
});

test("pack small integers", () => {
  expect(pack(0)).toEqual(b("\x08"));
  expect(pack(0xf)).toEqual(b("\x17"));
  expect(pack(0x27)).toEqual(b("\x2f"));
});

test("pack larger integers", () => {
  expect(pack(0x28)).toEqual(b("\x30\x28"));
  expect(pack(0x1ff)).toEqual(b("\x31\xff\x01"));
  expect(pack(0x1ffffff)).toEqual(b("\x32\xff\xff\xff\x01"));
  expect(pack(0x1ffffffffffffffn)).toEqual(b("\x33\xff\xff\xff\xff\xff\xff\xff\x01"));
});

test("pack sized integers", () => {
  expect(pack(sizedInt(0x1, 1))).toEqual(b("\x30\x01"));
  expect(pack(sizedInt(0x1, 2))).toEqual(b("\x31\x01\x00"));
  expect(pack(sizedInt(0x1, 4))).toEqual(b("\x32\x01\x00\x00\x00"));
  expect(pack(sizedInt(0x1, 8))).toEqual(b("\x33\x01\x00\x00\x00\x00\x00\x00\x00"));
});

test("pack float64", () => {
  expect(pack(new Float(1.0))).toEqual(b("\x36\x00\x00\x00\x00\x00\x00\xf0\x3f"));
  expect(pack(1.5)).toEqual(b("\x36\x00\x00\x00\x00\x00\x00\xf8\x3f"));
});

test("pack short strings", () => {
  expect(pack("a")).toEqual(b("\x41\x61"));
  expect(pack("abc")).toEqual(b("\x43\x61\x62\x63"));
  expect(pack(rep("a", 0x20))).toEqual(b("\x60" + rep("\x61", 0x20)));
});

test("pack longer strings", () => {
  expect(pack(rep("a", 33))).toEqual(b("\x61\x21" + rep("\x61", 33)));
  expect(pack(rep("a", 256))).toEqual(b("\x62\x00\x01" + rep("\x61", 256)));
});

test("pack short raw bytes", () => {
  expect(pack(b("\xac"))).toEqual(b("\x71\xac"));
  expect(pack(b("\x12\x34\x56"))).toEqual(b("\x73\x12\x34\x56"));
  expect(pack(b(rep("\xad", 0x20)))).toEqual(b("\x90" + rep("\xad", 0x20)));
});

test("pack longer raw bytes", () => {
  expect(pack(b(rep("\x61", 33)))).toEqual(b("\x91\x21" + rep("\x61", 33)));
  expect(pack(b(rep("\x61", 256)))).toEqual(b("\x92\x00\x01" + rep("\x61", 256)));
  expect(pack(b(rep("\x61", 65536)))).toEqual(b("\x93\x00\x00\x01\x00" + rep("\x61", 65536)));
});

test("pack array", () => {
  expect(pack([])).toEqual(b("\xd0"));
  expect(pack([1, "test", false])).toEqual(b("\xd3\x09\x44\x74\x65\x73\x74\x02"));
  expect(pack([[true]])).toEqual(b("\xd1\xd1\x01"));
});

test("pack endless array", () => {
  expect(pack(Array(15).fill("a"))).toEqual(b("\xdf\x41\x61" + rep("\xa0", 14) + "\x03"));
});

test("pack dict", () => {
  expect(pack({})).toEqual(b("\xe0"));
  expect(
    pack(
      new Map<unknown, unknown>([
        ["a", 12],
        [false, null],
      ]),
    ),
  ).toEqual(b("\xe2\x41\x61\x14\x02\x04"));
  expect(pack(new Map([[true, { a: 2 }]]))).toEqual(b("\xe1\x01\xe1\x41\x61\x0a"));
});

test("pack endless dict", () => {
  const data: Record<string, string> = {};
  for (let x = 97; x < 127; x += 2) data[String.fromCharCode(x)] = String.fromCharCode(x + 1);
  const chars = Array.from({ length: 30 }, (_, i) => String.fromCharCode(97 + i));
  expect(pack(data)).toEqual(b("\xef" + "\x41" + chars.join("\x41") + "\x03"));
});

test("pack ptr", () => {
  expect(pack(["a", "a"])).toEqual(b("\xd2\x41\x61\xa0"));
  expect(pack(["foo", "bar", "foo", "bar"])).toEqual(b("\xd4\x43\x66\x6f\x6f\x43\x62\x61\x72\xa0\xa1"));
  expect(pack({ a: "b", c: { d: "a" }, d: true })).toEqual(
    b("\xe3\x41\x61\x41\x62\x41\x63\xe1\x41\x64\xa0\xa3\x01"),
  );
});

const moreData = () => Array.from({ length: 257 }, (_, x) => Buffer.from(String.fromCodePoint(x), "utf-8"));

test("pack more ptr", () => {
  const data = moreData();
  expect(pack([...data, ...data])).toEqual(MORE_PTR_PACKED);
});

// unpack

test("unpack unsupported type", () => {
  expect(() => unpack(b("\x00"))).toThrow(TypeError);
});

test("unpack boolean", () => {
  expect(unpack(b("\x01"))).toEqual([true, b("")]);
  expect(unpack(b("\x02"))).toEqual([false, b("")]);
});

test("unpack none", () => {
  expect(unpack(b("\x04"))).toEqual([null, b("")]);
});

test("unpack uuid", () => {
  const [value, rest] = unpack(b("\x05\x12\x34\x56\x78\x12\x34\x56\x78\x12\x34\x56\x78\x12\x34\x56\x78"));
  expect(value.equals(new UUID("{12345678-1234-5678-1234-567812345678}"))).toBe(true);
  expect(rest).toEqual(b(""));
});

test("unpack absolute time", () => {
  // TODO: This is not implemented, it only parses the time stamp as an integer
  expect(unpack(b("\x06\x01\x00\x00\x00\x00\x00\x00\x00"))).toEqual([1, b("")]);
});

test("unpack small integers", () => {
  expect(unpack(b("\x08"))).toEqual([0, b("")]);
  expect(unpack(b("\x17"))).toEqual([0xf, b("")]);
  expect(unpack(b("\x2f"))).toEqual([0x27, b("")]);
});

test("unpack larger integers", () => {
  expect(unpack(b("\x30\x28"))).toEqual([0x28, b("")]);
  expect(unpack(b("\x31\xff\x01"))).toEqual([0x1ff, b("")]);
  expect(unpack(b("\x32\xff\xff\xff\x01"))).toEqual([0x1ffffff, b("")]);
  expect(unpack(b("\x33\xff\xff\xff\xff\xff\xff\xff\x01"))).toEqual([0x1ffffffffffffffn, b("")]);
});

test("unpack float32", () => {
  expect(unpack(b("\x35\x00\x00\x80\x3f"))).toEqual([1.0, b("")]);
});

test("unpack float64", () => {
  expect(unpack(b("\x36\x00\x00\x00\x00\x00\x00\xf0\x3f"))).toEqual([1.0, b("")]);
});

test("unpack short strings", () => {
  expect(unpack(b("\x41\x61"))).toEqual(["a", b("")]);
  expect(unpack(b("\x43\x61\x62\x63"))).toEqual(["abc", b("")]);
  expect(unpack(b("\x60" + rep("\x61", 0x20)))).toEqual([rep("a", 0x20), b("")]);
});

test("unpack longer strings", () => {
  expect(unpack(b("\x61\x21" + rep("\x61", 33)))).toEqual([rep("a", 33), b("")]);
  expect(unpack(b("\x62\x00\x01" + rep("\x61", 256)))).toEqual([rep("a", 256), b("")]);
});

test("unpack short raw bytes", () => {
  expect(unpack(b("\x71\xac"))).toEqual([b("\xac"), b("")]);
  expect(unpack(b("\x73\x12\x34\x56"))).toEqual([b("\x12\x34\x56"), b("")]);
  expect(unpack(b("\x90" + rep("\xad", 0x20)))).toEqual([b(rep("\xad", 0x20)), b("")]);
});

test("unpack longer raw bytes", () => {
  expect(unpack(b("\x91\x21" + rep("\x61", 33)))).toEqual([b(rep("\x61", 33)), b("")]);
  expect(unpack(b("\x92\x00\x01" + rep("\x61", 256)))).toEqual([b(rep("\x61", 256)), b("")]);
  expect(unpack(b("\x93\x00\x00\x01\x00" + rep("\x61", 65536)))).toEqual([b(rep("\x61", 65536)), b("")]);
});

test("unpack array", () => {
  expect(unpack(b("\xd0"))).toEqual([[], b("")]);
  expect(unpack(b("\xd3\x09\x44\x74\x65\x73\x74\x02"))).toEqual([[1, "test", false], b("")]);
  expect(unpack(b("\xd1\xd1\x01"))).toEqual([[[true]], b("")]);
});

test("unpack endless array", () => {
  const list1 = "\xdf\x41\x61" + rep("\xa0", 15) + "\x03";
  const list2 = "\xdf\x41\x62" + rep("\xa1", 15) + "\x03";
  expect(unpack(b(list1))).toEqual([Array(16).fill("a"), b("")]);
  expect(unpack(b("\xd2" + list1 + list2))).toEqual([[Array(16).fill("a"), Array(16).fill("b")], b("")]);
});

test("unpack dict", () => {
  expect(unpack(b("\xe0"))).toEqual([{}, b("")]);
  expect(unpack(b("\xe2\x41\x61\x14\x02\x04"))).toEqual([
    new Map<unknown, unknown>([
      ["a", 12],
      [false, null],
    ]),
    b(""),
  ]);
  expect(unpack(b("\xe1\x01\xe1\x41\x61\x0a"))).toEqual([new Map([[true, { a: 2 }]]), b("")]);
});

test("unpack endless dict", () => {
  const expected: Record<string, string> = {};
  for (let x = 97; x < 127; x += 2) expected[String.fromCharCode(x)] = String.fromCharCode(x + 1);
  const chars = Array.from({ length: 30 }, (_, i) => String.fromCharCode(97 + i));
  expect(unpack(b("\xef" + "\x41" + chars.join("\x41") + "\x03"))).toEqual([expected, b("")]);
});

test("unpack ptr", () => {
  expect(unpack(b("\xd2\x41\x61\xa0"))).toEqual([["a", "a"], b("")]);
  expect(unpack(b("\xd4\x43\x66\x6f\x6f\x43\x62\x61\x72\xa0\xa1"))).toEqual([["foo", "bar", "foo", "bar"], b("")]);
  expect(unpack(b("\xe3\x41\x61\x41\x62\x41\x63\xe1\x41\x64\xa0\xa3\x01"))).toEqual([
    { a: "b", c: { d: "a" }, d: true },
    b(""),
  ]);
});

test("unpack more ptr", () => {
  const data = moreData();
  expect(unpack(MORE_PTR_UNPACKED_INPUT)).toEqual([[...data, ...data], b("")]);
});

test("unpack uid", () => {
  expect(unpack(b("\xdf\x30\x01\x30\x02\xc1\x01\x03"))).toEqual([[1, 2, 2], b("")]);
  expect(unpack(b("\xdf\x30\x01\x30\x02\xc2\x01\x00\x03"))).toEqual([[1, 2, 2], b("")]);
  expect(unpack(b("\xdf\x30\x01\x30\x02\xc3\x01\x00\x00\x03"))).toEqual([[1, 2, 2], b("")]);
  expect(unpack(b("\xdf\x30\x01\x30\x02\xc4\x01\x00\x00\x00\x03"))).toEqual([[1, 2, 2], b("")]);
});

test("pack and unpack round trip with sized int", () => {
  // Sized integers are unpacked as plain numbers in the TypeScript version
  expect(unpack(pack(sizedInt(1, 4)))).toEqual([1, b("")]);
});
