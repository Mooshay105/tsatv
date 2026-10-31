import { beforeEach, expect, test } from "bun:test";
import { Cache } from "../../src/support/cache.ts";

const [ID1, ID2, ID3] = ["id1", "id2", "id3"];
const [DATA1, DATA2, DATA3] = [123, 456, 789];

let cache: Cache<string, number>;
beforeEach(() => {
  cache = new Cache(2);
});

test("cache is empty", () => expect(cache.empty()).toBe(true));

test("put get item", () => {
  cache.put(ID1, DATA1);
  expect(cache.get(ID1)).toBe(DATA1);
});

test("put get multiple", () => {
  cache.put(ID1, DATA1);
  cache.put(ID2, DATA2);
  expect(cache.get(ID1)).toBe(DATA1);
  expect(cache.get(ID2)).toBe(DATA2);
});

test("cache not empty", () => {
  cache.put(ID1, DATA1);
  expect(cache.empty()).toBe(false);
});

test("cache has item", () => {
  cache.put(ID1, DATA1);
  expect(cache.has(ID1)).toBe(true);
  expect(cache.has(ID2)).toBe(false);
});

test("cache size", () => {
  expect(cache.size).toBe(0);
  cache.put(ID1, DATA1);
  expect(cache.size).toBe(1);
});

test("put same identifier replaces data", () => {
  cache.put(ID1, DATA1);
  cache.put(ID1, DATA2);
  expect(cache.get(ID1)).toBe(DATA2);
  expect(cache.size).toBe(1);
});

test("put removes oldest", () => {
  cache.put(ID1, DATA1);
  cache.put(ID2, DATA2);
  cache.put(ID3, DATA3);
  expect(cache.size).toBe(2);
  expect(cache.has(ID1)).toBe(false);
  expect(cache.has(ID2)).toBe(true);
  expect(cache.has(ID3)).toBe(true);
});

test("get makes data newer", () => {
  cache.put(ID1, DATA1);
  cache.put(ID2, DATA2);
  cache.get(ID1);
  cache.put(ID3, DATA3);
  expect(cache.size).toBe(2);
  expect(cache.has(ID1)).toBe(true);
  expect(cache.has(ID2)).toBe(false);
  expect(cache.has(ID3)).toBe(true);
});

test("get latest identifier", () => {
  expect(cache.latest()).toBeNull();
  cache.put(ID1, DATA1);
  expect(cache.latest()).toBe(ID1);
  cache.put(ID2, DATA2);
  expect(cache.latest()).toBe(ID2);
  cache.get(ID1);
  expect(cache.latest()).toBe(ID1);
});
