import { describe, expect, test } from "bun:test";
import { CaseInsensitiveDict, dictMerge, dictSubtract, SharedData } from "../../src/support/collections.ts";

const sentinel = (name: string) => Symbol.for(name);

const fixtureDict = () => {
  const ret = new CaseInsensitiveDict<symbol>();
  ret.set("foo", sentinel("foo"));
  return ret;
};

const KEYS = ["foo", "FOO", "Foo", "fOO"];
const NEW_KEYS = ["bar", "BAR", "Bar", "bAR"];

describe("CaseInsensitiveDict", () => {
  test.each(KEYS)("getitem %s", (key) => {
    expect(fixtureDict().get(key)).toBe(sentinel("foo"));
  });

  for (const key of KEYS) {
    test.each(NEW_KEYS)(`setitem ${key} %s`, (newKey) => {
      const d = fixtureDict();
      d.set(key, sentinel("Foo"));
      expect(d.get(key)).not.toBe(sentinel("foo"));
      expect(d.get(key)).toBe(sentinel("Foo"));
      expect(d.size).toBe(1);
      d.set(newKey, sentinel(newKey));
      d.set("bar", sentinel(newKey));
      expect(d.size).toBe(2);
    });
  }

  test.each(KEYS)("delitem %s", (key) => {
    const d = fixtureDict();
    d.delete(key);
    expect(d.size).toBe(0);
    expect(() => d.getItem("foo")).toThrow();
  });

  test.each(KEYS)("contains %s", (key) => {
    expect(fixtureDict().has(key)).toBe(true);
  });

  test("equals case insensitive", () => {
    const other = new CaseInsensitiveDict<symbol>();
    other.set("FOO", sentinel("foo"));
    expect(fixtureDict().equals(other)).toBe(true);
  });

  test("equals plain dict", () => {
    expect(fixtureDict().equals({ Foo: sentinel("foo") })).toBe(true);
  });

  test("init mapping", () => {
    const cid = new CaseInsensitiveDict({ FOO: sentinel("FOO"), bAr: sentinel("bAr") });
    expect(cid.get("foo")).toBe(sentinel("FOO"));
    expect(cid.get("bar")).toBe(sentinel("bAr"));
    expect(cid.size).toBe(2);
  });

  test("init iterable", () => {
    const cid = new CaseInsensitiveDict<symbol>([
      ["fOO", sentinel("fOO")],
      ["BaR", sentinel("BaR")],
    ]);
    expect(cid.get("foo")).toBe(sentinel("fOO"));
    expect(cid.get("bar")).toBe(sentinel("BaR"));
    expect(cid.size).toBe(2);
  });
});

describe("dict_merge", () => {
  test.each([
    [{ a: 1 }, {}, { a: 1 }],
    [{}, { a: 1 }, { a: 1 }],
    [{ a: 1 }, { a: 2 }, { a: 1 }],
  ])("%p + %p", (dictA, dictB, expected) => {
    expect(dictMerge({ ...dictA }, dictB)).toEqual(expected);
  });

  test("returns dict_a", () => {
    const dictA = { a: 1 };
    expect(dictMerge(dictA, { b: 2 })).toBe(dictA);
  });

  test("overwrite", () => {
    expect(dictMerge({ a: 1 }, { a: 2 }, true)).toEqual({ a: 2 });
  });
});

describe("dict_subtract", () => {
  test.each([
    [{ a: 1 }, { a: 2 }, {}],
    [{ a: 1 }, { b: 2 }, { a: 1 }],
    [{ a: 1, c: 2 }, { c: 123, b: 2 }, { a: 1 }],
    [{ a: { b: 2 } }, { a: { b: 3 } }, { a: {} }],
    [{ a: { b: 2 } }, { a: { c: 3 } }, { a: { b: 2 } }],
  ] as Array<[any, any, any]>)("%p - %p", (dictA, dictB, expected) => {
    expect(dictSubtract(dictA, dictB)).toEqual(expected);
  });

  test("remove if same value", () => {
    expect(dictSubtract({ a: 1, b: 2 }, { a: 1, b: 3 }, true)).toEqual({ b: 2 });
  });
});

test("shared data", async () => {
  const shared = new SharedData<number>();
  const result = shared.wait();
  shared.set(1234);
  expect(await result).toBe(1234);
});
