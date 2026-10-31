/** Various helper methods used by test cases. */

import { existsSync } from "node:fs";
import path from "node:path";
import { expect } from "bun:test";
import { realSleep, setSleepImpl, TimeoutError } from "../src/support/asyncio.ts";
import type { BaseConfig } from "../src/interface.ts";
import type { Protocol } from "../src/const.ts";

const fakeSleepState = { sleepTime: [0.0] as number[], totalSleep: 0.0, active: false, generation: 0 };

// Schedule the "sleep" at the end of the event queue in order to give others the
// possibility to run.
async function fakeSleep(time: number): Promise<void> {
  const generation = fakeSleepState.generation;
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      // Ignore sleeps started by a previous test (still running in the background)
      if (generation !== fakeSleepState.generation) return resolve();
      fakeSleepState.sleepTime.unshift(time);
      fakeSleepState.totalSleep += time;
      resolve();
    }),
  );
}

/** Stub sleep to not make tests slow. */
export function stubSleep(fn?: (seconds: number) => Promise<void>): number {
  setSleepImpl(fn ?? fakeSleep);
  fakeSleepState.active = !fn;
  if (fakeSleepState.active) {
    if (fakeSleepState.sleepTime.length === 1) return fakeSleepState.sleepTime[0]!;
    return fakeSleepState.sleepTime.pop()!;
  }
  return 0.0;
}

/** Restore original sleep method. */
export function unstubSleep(): void {
  fakeSleepState.generation += 1;
  fakeSleepState.sleepTime = [0.0];
  fakeSleepState.totalSleep = 0.0;
  fakeSleepState.active = false;
  setSleepImpl(undefined);
}

/** Return total amount of fake time slept. */
export function totalSleepTime(): number {
  return fakeSleepState.active ? fakeSleepState.totalSleep : 0.0;
}

/** Perform a GET-request to a specified URL. Returns [data or null, status]. */
export async function simpleGet(url: string): Promise<[Buffer | null, number]> {
  const response = await fetch(url);
  if (response.status < 200 || response.status >= 300) return [null, response.status];
  return [Buffer.from(await response.arrayBuffer()), response.status];
}

/**
 * Wait until a predicate is fulfilled.
 *
 * Predicate may return a boolean or a tuple [condition, returnValue].
 */
export async function until<T = unknown>(
  pred: () => boolean | [boolean, T] | Promise<boolean | [boolean, T]> | unknown,
  timeout = 5,
): Promise<T | undefined> {
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const value = await pred();
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "boolean") {
      if (value[0]) return value[1] as T;
    } else if (value) {
      return undefined;
    }
    if (timeout !== null && Date.now() >= deadline) throw new TimeoutError("until timed out");
    await realSleep(0.01);
  }
}

/** Return absolute path to data directory used by tests. */
export function dataRoot(): string {
  return path.join(import.meta.dir, "data");
}

/** Return absolute path to a test file in the data directory. */
export function dataPath(filename: string): string {
  const absPath = path.join(import.meta.dir, "data", filename);
  if (!existsSync(absPath)) throw new Error(`test file does not exist: ${filename}`);
  return absPath;
}

export function assertDevice(
  atv: BaseConfig,
  name: string,
  address: string,
  identifier: string | null,
  protocol: Protocol,
  port: number,
  creds: string | null = null,
): void {
  expect(atv.name).toBe(name);
  expect(atv.address).toBe(address);
  expect(atv.identifier).toBe(identifier);
  expect(atv.getService(protocol)).toBeTruthy();
  expect(atv.getService(protocol)!.port).toBe(port);
  expect(atv.getService(protocol)!.credentials).toBe(creds);
}

/** Return if all strings are in text. */
export function allIn(text: string, ...strings: string[]): boolean {
  return strings.every((s) => text.includes(s));
}

/** Byte string helper (like Python b"..." with \x escapes written as latin1). */
export function b(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

/**
 * Run a function with a fake current time (seconds since epoch) for pyatv.
 *
 * Equivalent of the faketime context manager in pyatv (which patches datetime.now). Each
 * call to "now" consumes the next time, the last one is repeated.
 */
export async function faketime<T>(times: number[], fn: () => Promise<T>): Promise<T> {
  const { mrpHooks } = await import("../src/protocols/mrp/index.ts");
  const original = mrpHooks.now;
  let remaining = [...times];
  mrpHooks.now = () => {
    if (remaining.length === 0) return original();
    const next = remaining[0]!;
    if (remaining.length > 1) remaining = remaining.slice(1);
    return next;
  };
  try {
    return await fn();
  } finally {
    mrpHooks.now = original;
  }
}
