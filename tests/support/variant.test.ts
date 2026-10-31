import { expect, test } from "bun:test";
import { readVariant, writeVariant } from "../../src/support/variant.ts";
import { b } from "../utils.ts";

test("read single byte", () => {
  expect(readVariant(b("\x00"))[0]).toBe(0x00);
  expect(readVariant(b("\x35"))[0]).toBe(0x35);
});

test("read multiple bytes", () => {
  expect(readVariant(b("\xb5\x44"))[0]).toBe(8757);
  expect(readVariant(b("\xc5\x92\x01"))[0]).toBe(18757);
});

test("read and return remaining data", () => {
  const [value, remaining] = readVariant(b("\xb5\x44\xca\xfe"));
  expect(value).toBe(8757);
  expect(remaining).toEqual(b("\xca\xfe"));
});

test("read invalid variant", () => {
  expect(() => readVariant(b("\x80"))).toThrow();
});

test("write single byte", () => {
  expect(writeVariant(0x00)).toEqual(b("\x00"));
  expect(writeVariant(0x35)).toEqual(b("\x35"));
});

test("write multiple bytes", () => {
  expect(writeVariant(8757)).toEqual(b("\xb5\x44"));
  expect(writeVariant(18757)).toEqual(b("\xc5\x92\x01"));
});
