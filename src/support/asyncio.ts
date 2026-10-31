/**
 * Small asyncio-like primitives used throughout the library.
 *
 * Python's asyncio has a few primitives (Event, Future, wait_for, sleep, Lock) that
 * pyatv relies heavily on. This module provides equivalents built on promises.
 */

/** Raised when an operation times out (asyncio.TimeoutError). */
export class TimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? "operation timed out");
    this.name = "TimeoutError";
  }
}

/** Raised when a future/task is cancelled (asyncio.CancelledError). */
export class CancelledError extends Error {
  constructor(message?: string) {
    super(message ?? "cancelled");
    this.name = "CancelledError";
  }
}

export type SleepFn = (seconds: number) => Promise<void>;

export const realSleep: SleepFn = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));

let sleepImpl: SleepFn = realSleep;

/** Sleep for a number of seconds (can be stubbed in tests). */
export function sleep(seconds: number): Promise<void> {
  return sleepImpl(seconds);
}

/** Replace sleep implementation (mainly for tests). */
export function setSleepImpl(fn: SleepFn | undefined): void {
  sleepImpl = fn ?? realSleep;
}

/** Yield to event loop, letting other pending tasks run. */
export function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Python-like Future that can be resolved/rejected from outside. */
export class Future<T = unknown> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T) => void;
  private _reject!: (reason: unknown) => void;
  private _done = false;
  private _result?: T;
  private _exception?: unknown;
  private _cancelled = false;
  private _callbacks: Array<(fut: Future<T>) => void> = [];

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // Avoid unhandled rejection warnings, errors are retrieved via promise/result
    this.promise.catch(() => undefined);
  }

  done(): boolean {
    return this._done;
  }

  cancelled(): boolean {
    return this._cancelled;
  }

  setResult(value: T): void {
    if (this._done) throw new Error("future already done");
    this._done = true;
    this._result = value;
    this._resolve(value);
    this._runCallbacks();
  }

  setException(error: unknown): void {
    if (this._done) throw new Error("future already done");
    this._done = true;
    this._exception = error;
    this._reject(error);
    this._runCallbacks();
  }

  cancel(): boolean {
    if (this._done) return false;
    this._cancelled = true;
    this._done = true;
    this._exception = new CancelledError();
    this._reject(this._exception);
    this._runCallbacks();
    return true;
  }

  result(): T {
    if (!this._done) throw new Error("result is not set");
    if (this._exception !== undefined) throw this._exception;
    return this._result as T;
  }

  exception(): unknown {
    return this._exception;
  }

  addDoneCallback(callback: (fut: Future<T>) => void): void {
    if (this._done) {
      queueMicrotask(() => callback(this));
    } else {
      this._callbacks.push(callback);
    }
  }

  private _runCallbacks(): void {
    const callbacks = this._callbacks;
    this._callbacks = [];
    for (const callback of callbacks) {
      queueMicrotask(() => callback(this));
    }
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}

/** Equivalent of asyncio.Event. */
export class Event {
  private _set = false;
  private _waiters: Array<() => void> = [];

  isSet(): boolean {
    return this._set;
  }

  set(): void {
    if (this._set) return;
    this._set = true;
    const waiters = this._waiters;
    this._waiters = [];
    waiters.forEach((w) => w());
  }

  clear(): void {
    this._set = false;
  }

  wait(): Promise<void> {
    if (this._set) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }
}

/** Equivalent of asyncio.Lock. */
export class Lock {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  locked(): boolean {
    return this._locked;
  }

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise<void>((resolve) => this._waiters.push(resolve));
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Equivalent of asyncio.Semaphore. */
export class Semaphore {
  private _waiters: Array<() => void> = [];
  constructor(private _value = 1) {}

  async acquire(): Promise<void> {
    if (this._value > 0) {
      this._value--;
      return;
    }
    await new Promise<void>((resolve) => this._waiters.push(resolve));
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) next();
    else this._value++;
  }
}

/** Equivalent of asyncio.Queue (unbounded). */
export class Queue<T> {
  private _items: T[] = [];
  private _getters: Array<(item: T) => void> = [];

  put(item: T): void {
    const getter = this._getters.shift();
    if (getter) getter(item);
    else this._items.push(item);
  }

  putNowait(item: T): void {
    this.put(item);
  }

  get(): Promise<T> {
    if (this._items.length > 0) {
      return Promise.resolve(this._items.shift() as T);
    }
    return new Promise((resolve) => this._getters.push(resolve));
  }

  getNowait(): T {
    if (this._items.length === 0) throw new Error("queue empty");
    return this._items.shift() as T;
  }

  qsize(): number {
    return this._items.length;
  }

  empty(): boolean {
    return this._items.length === 0;
  }
}

/**
 * Wait for a promise to finish with a timeout (in seconds).
 *
 * A timeout of undefined/null means wait forever. Raises TimeoutError on timeout.
 */
export function waitFor<T>(
  promise: PromiseLike<T> | Promise<T>,
  timeout: number | null | undefined,
): Promise<T> {
  if (timeout === undefined || timeout === null) {
    return Promise.resolve(promise);
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), Math.max(0, timeout * 1000));
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Run a function with a timeout (equivalent of `async with async_timeout(x)`). */
export function asyncTimeout<T>(timeout: number | null | undefined, fn: () => Promise<T>): Promise<T> {
  return waitFor(fn(), timeout);
}

/**
 * Simple task wrapper with cooperative cancellation.
 *
 * JavaScript promises can not be cancelled, so a Task exposes an AbortSignal that
 * the running coroutine can check. Awaiting a cancelled task raises CancelledError.
 */
export class Task<T = unknown> {
  readonly controller = new AbortController();
  private readonly _future = new Future<T>();

  constructor(fn: (signal: AbortSignal) => Promise<T>) {
    Promise.resolve()
      .then(() => fn(this.controller.signal))
      .then(
        (value) => {
          if (!this._future.done()) this._future.setResult(value);
        },
        (err) => {
          if (!this._future.done()) this._future.setException(err);
        },
      );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): boolean {
    if (this._future.done()) return false;
    this.controller.abort();
    return this._future.cancel();
  }

  done(): boolean {
    return this._future.done();
  }

  cancelled(): boolean {
    return this._future.cancelled();
  }

  result(): T {
    return this._future.result();
  }

  exception(): unknown {
    return this._future.exception();
  }

  addDoneCallback(callback: (task: Task<T>) => void): void {
    this._future.addDoneCallback(() => callback(this));
  }

  get promise(): Promise<T> {
    return this._future.promise;
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this._future.promise.then(onfulfilled, onrejected);
  }
}

/** Create a new task (asyncio.ensure_future/create_task). */
export function createTask<T>(fn: (signal: AbortSignal) => Promise<T>): Task<T> {
  return new Task(fn);
}

/** Sleep that is aborted (raises CancelledError) when signal is aborted. */
export function abortableSleep(seconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(seconds);
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(seconds).then(() => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(new CancelledError());
      else resolve();
    }, reject);
  });
}

/** Equivalent of asyncio.gather(..., return_exceptions=True). */
export async function gatherSettled<T>(promises: Array<PromiseLike<T>>): Promise<Array<T | unknown>> {
  const results = await Promise.allSettled(promises);
  return results.map((r) => (r.status === "fulfilled" ? r.value : r.reason));
}
