/** Collections for pyatv. */

import { Event, waitFor } from "./asyncio.ts";

type Dict = Record<string, any>;

/**
 * Merge items from dictB into dictA, not overriding existing keys.
 *
 * Returns dictA (which is modified in place).
 */
export function dictMerge<T extends Dict>(dictA: T, dictB: Dict, allowOverwrite = false): T {
  for (const [key, value] of Object.entries(dictB)) {
    if (allowOverwrite || !(key in dictA)) {
      (dictA as Dict)[key] = value;
    }
  }
  return dictA;
}

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/**
 * Subtract items from a dict (based on key) recursively.
 *
 * If removeIfSameValue is set to true, keys will only be removed if they have the
 * same value, e.g. if a=1 in dictA and a=1 also in dictB.
 */
export function dictSubtract(dictA: Dict, dictB: Dict, removeIfSameValue = false): Dict {
  const diff: Dict = {};
  for (const [key, val] of Object.entries(dictA)) {
    if (isPlainObject(val)) {
      diff[key] = dictSubtract(val, dictB[key] ?? {});
    } else if (!(key in dictB) || (removeIfSameValue && dictA[key] !== dictB[key])) {
      diff[key] = val;
    }
  }
  return diff;
}

/**
 * A mapping where the keys are compared case-insensitively.
 *
 * Keys are stored lower-cased (just like the Python version).
 */
export class CaseInsensitiveDict<T = string> extends Map<string, T> {
  constructor(init?: Iterable<readonly [string, T]> | Record<string, T> | null) {
    super();
    if (init) {
      const entries =
        Symbol.iterator in Object(init) ? (init as Iterable<readonly [string, T]>) : Object.entries(init as Record<string, T>);
      for (const [key, value] of entries) this.set(key, value);
    }
  }

  override get(key: string): T | undefined {
    return super.get(key.toLowerCase());
  }

  override set(key: string, value: T): this {
    return super.set(key.toLowerCase(), value);
  }

  override has(key: string): boolean {
    return typeof key === "string" && super.has(key.toLowerCase());
  }

  override delete(key: string): boolean {
    return super.delete(key.toLowerCase());
  }

  /** Get value or throw KeyError-like error. */
  getItem(key: string): T {
    if (!this.has(key)) throw new Error(`KeyError: ${key}`);
    return this.get(key) as T;
  }

  /** Compare with another mapping, keys compared case-insensitively. */
  equals(other: Map<string, T> | Record<string, T>): boolean {
    const entries = other instanceof Map ? [...other.entries()] : Object.entries(other);
    if (entries.length !== this.size) return false;
    for (const [key, value] of entries) {
      if (typeof key !== "string" || !this.has(key) || this.get(key) !== value) return false;
    }
    return true;
  }

  toObject(): Record<string, T> {
    return Object.fromEntries(this.entries());
  }

  override toString(): string {
    return JSON.stringify(this.toObject());
  }
}

/** Synchronization barrier used to synchronize data transfer between tasks. */
export class SharedData<T> {
  private readonly _event = new Event();
  private _data: T | undefined;

  /** Wait for shared data to arrive. */
  async wait(timeout = 5.0): Promise<T> {
    await waitFor(this._event.wait(), timeout);
    return this._data as T;
  }

  /** Signal that shared data has arrived. */
  set(data: T): void {
    this._data = data;
    this._event.set();
  }
}
