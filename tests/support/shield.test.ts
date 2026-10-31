import { expect, test } from "bun:test";
import { BlockedStateError, InvalidStateError } from "../../src/exceptions.ts";
import * as shield from "../../src/support/shield.ts";

class Dummy {}

test("shield object", () => {
  const obj = new Dummy();
  expect(shield.isShielded(obj)).toBe(false);
  const obj2 = shield.shield(obj);
  expect(obj).toBe(obj2);
  expect(shield.isShielded(obj)).toBe(true);
});

test("cannot block unshielded object", () => {
  expect(() => shield.block(new Dummy())).toThrow(InvalidStateError);
});

test("is blocking does not raise on unshielded object", () => {
  expect(shield.isBlocking(new Dummy())).toBe(false);
});

test("block shielded object", () => {
  const obj = new Dummy();
  shield.shield(obj);
  expect(shield.isBlocking(obj)).toBe(false);
  shield.block(obj);
  expect(shield.isBlocking(obj)).toBe(true);
});

class GuardedClass {
  guardedMethod(a: number): number {
    return a * a;
  }

  unguardedMethod(b: number): number {
    return b + b;
  }
}
shield.guardMethods(GuardedClass, ["guardedMethod"]);

test("guarded methods", () => {
  const obj = new GuardedClass();
  shield.shield(obj);
  expect(obj.guardedMethod(2)).toBe(4);
  expect(obj.unguardedMethod(4)).toBe(8);
  shield.block(obj);
  expect(() => obj.guardedMethod(2)).toThrow(BlockedStateError);
  expect(obj.unguardedMethod(5)).toBe(10);
});
