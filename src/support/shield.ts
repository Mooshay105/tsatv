/**
 * The shield module helps restricting access to an object.
 *
 * A shielded object can use the guard helper to block calls to particular methods
 * when block has been called.
 */

import { BlockedStateError, InvalidStateError } from "../exceptions.ts";

const SHIELD_VAR = Symbol.for("pyatv.shield_is_blocking");

/** Add shielding to an object. */
export function shield<T extends object>(obj: T): T {
  (obj as any)[SHIELD_VAR] = false;
  return obj;
}

/** Return if an object is shielded. */
export function isShielded(obj: object): boolean {
  return SHIELD_VAR in obj;
}

/** Change a shielded object into blocking state. */
export function block(obj: object): void {
  if (!isShielded(obj)) {
    throw new InvalidStateError("object is not shielded");
  }
  (obj as any)[SHIELD_VAR] = true;
}

/** Return if a shielded object is in blocking state. */
export function isBlocking(obj: object): boolean {
  return isShielded(obj) && (obj as any)[SHIELD_VAR] === true;
}

/** Raise BlockedStateError if object is blocking (call first in guarded methods). */
export function checkGuard(obj: object, name: string): void {
  if (isBlocking(obj)) {
    throw new BlockedStateError(`${name} is blocked`);
  }
}

/** Method decorator-like wrapper guarding a function. */
export function guard<A extends unknown[], R>(name: string, func: (this: any, ...args: A) => R) {
  return function (this: any, ...args: A): R {
    checkGuard(this, name);
    return func.apply(this, args);
  };
}

/**
 * Wrap given method names on a class prototype with guards.
 *
 * Usage: guardMethods(MyClass, ["foo", "bar"]).
 */
export function guardMethods(cls: { prototype: any }, names: string[]): void {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, name);
    if (!descriptor) throw new Error(`no method ${name} on ${String(cls)}`);
    if (typeof descriptor.value === "function") {
      const original = descriptor.value;
      if (original.constructor?.name === "AsyncFunction") {
        // Keep async semantics (reject instead of throwing synchronously)
        descriptor.value = async function (this: any, ...args: unknown[]) {
          checkGuard(this, name);
          return original.apply(this, args);
        };
      } else {
        descriptor.value = function (this: any, ...args: unknown[]) {
          checkGuard(this, name);
          return original.apply(this, args);
        };
      }
    } else if (descriptor.get) {
      const original = descriptor.get;
      descriptor.get = function (this: any) {
        checkGuard(this, name);
        return original.call(this);
      };
    }
    Object.defineProperty(cls.prototype, name, descriptor);
  }
}
