/** Unit tests for pyatv.protocols.raop.fifo. */

import { expect, test } from "bun:test";
import { NotImplementedError } from "../../../src/exceptions.ts";
import { PacketFifo } from "../../../src/protocols/raop/fifo.ts";

test("add to fifo", () => {
  const fifo = new PacketFifo<number>(10);
  expect(fifo.size).toBe(0);
  fifo.set(123, 456);
  expect(fifo.size).toBe(1);
});

test("add existing to fifo", () => {
  const fifo = new PacketFifo<number>(10);
  fifo.set(123, 456);
  expect(() => fifo.set(123, 789)).toThrow(RangeError);
});

test("add index not int raises", () => {
  const fifo = new PacketFifo<number>(10);
  expect(() => fifo.set("test" as unknown as number, 123)).toThrow(TypeError);
});

test("get missing from fifo", () => {
  const fifo = new PacketFifo<number>(10);
  expect(() => fifo.get(123)).toThrow(RangeError);
});

test("get index not int raises", () => {
  const fifo = new PacketFifo<number>(10);
  expect(() => fifo.get("test" as unknown as number)).toThrow(TypeError);
});

test("in operator", () => {
  const fifo = new PacketFifo<number>(10);
  expect(fifo.has(1)).toBe(false);
  fifo.set(1, 0);
  expect(fifo.has(1)).toBe(true);
});

test("add multiple", () => {
  const fifo = new PacketFifo<number>(10);
  fifo.set(0, 1);
  fifo.set(1, 2);
  fifo.set(2, 3);
  expect(fifo.get(0)).toBe(1);
  expect(fifo.get(1)).toBe(2);
  expect(fifo.get(2)).toBe(3);
  expect(fifo.size).toBe(3);
});

test("add overflow removes oldest", () => {
  const fifo = new PacketFifo<number>(2);
  fifo.set(0, 1);
  fifo.set(1, 2);

  fifo.set(2, 3);
  expect(fifo.size).toBe(2);
  expect(fifo.has(0)).toBe(false);
  expect(fifo.get(1)).toBe(2);
  expect(fifo.get(2)).toBe(3);

  fifo.set(3, 4);
  expect(fifo.size).toBe(2);
  expect(fifo.has(1)).toBe(false);
  expect(fifo.get(2)).toBe(3);
  expect(fifo.get(3)).toBe(4);
});

test("clear fifo", () => {
  const fifo = new PacketFifo<number>(2);
  fifo.set(0, 1);
  fifo.set(1, 2);
  fifo.clear();
  expect(fifo.size).toBe(0);
});

test("del not supported", () => {
  const fifo = new PacketFifo<number>(2);
  fifo.set(0, 1);
  expect(() => fifo.delete(0)).toThrow(NotImplementedError);
});

test("iter over indices", () => {
  const fifo = new PacketFifo<number>(10);
  fifo.set(1, 1);
  fifo.set(2, 2);
  fifo.set(3, 2);
  let sum = 0;
  for (const i of fifo) sum += i;
  expect(sum).toBe(1 + 2 + 3);
});

test("str", () => {
  const fifo = new PacketFifo<number>(2);
  expect(String(fifo)).toBe("[]");
  fifo.set(1, 2);
  fifo.set(2, 3);
  expect(String(fifo)).toBe("[1, 2]");
});

test("repr", () => {
  const fifo = new PacketFifo<number>(2);
  expect(fifo.repr()).toBe("{}");
  fifo.set(1, 2);
  fifo.set(2, 3);
  expect(fifo.repr()).toBe("{1: 2, 2: 3}");
});
