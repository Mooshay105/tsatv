/** Generic functions for protocol logic. */

import { abortableSleep, CancelledError } from "../support/asyncio.ts";
import { getLogger } from "../support/logging.ts";

const LOGGER = getLogger("pyatv.core.protocol");

export const HEARTBEAT_INTERVAL = 30;
export const HEARTBEAT_RETRIES = 1; // One regular attempt + retries

export type DispatchFunc<M> = (message: M) => void | Promise<void>;
export type DispatchFilterFunc<M> = (message: M) => boolean;

const noFilter = () => true;

export interface HeartbeaterOptions<M> {
  finishFunc?: () => void;
  failureFunc?: (exc: Error) => void;
  messageFactory?: () => M | null;
  retries?: number;
  interval?: number;
  signal?: AbortSignal;
}

/** Periodically send heartbeat messages to device (until signal is aborted). */
export async function heartbeater<M = unknown>(
  name: string,
  senderFunc: (message: M | null) => Promise<unknown>,
  options: HeartbeaterOptions<M> = {},
): Promise<void> {
  const finishFunc = options.finishFunc ?? (() => undefined);
  const failureFunc = options.failureFunc ?? (() => undefined);
  const retries = options.retries ?? HEARTBEAT_RETRIES;
  const interval = options.interval ?? HEARTBEAT_INTERVAL;
  const signal = options.signal;

  LOGGER.debug("Starting heartbeat loop (%s)", name);
  let count = 0;
  let attempts = 0;
  const message = (options.messageFactory ?? (() => null))();
  for (;;) {
    try {
      // Re-attempts are made with no initial delay to more quickly recover a failed
      // heartbeat (if possible)
      if (attempts === 0) {
        await abortableSleep(interval, signal);
      }

      LOGGER.debug("Sending periodic heartbeat %d (%s)", count, name);
      await senderFunc(message);
      if (signal?.aborted) throw new CancelledError();
      LOGGER.debug("Got heartbeat %d (%s)", count, name);
      attempts = 0;
    } catch (exc) {
      if (exc instanceof CancelledError || signal?.aborted) {
        count += 1;
        break;
      }
      attempts += 1;
      if (attempts > retries) {
        LOGGER.debug("Heartbeat %d failed after %d tries (%s)", count, attempts, name);
        failureFunc(exc as Error);
        return;
      }
      LOGGER.debug("Heartbeat %d failed (%s)", count, name);
    }
    count += 1;
  }

  LOGGER.debug("Stopping heartbeat loop at %d (%s)", count, name);
  finishFunc();
}

/** Dispatch message to listeners based on a type. */
export class MessageDispatcher<T, M> {
  private readonly _listeners = new Map<T, Array<[DispatchFilterFunc<M>, DispatchFunc<M>]>>();

  /** Listen to a specific type of message type. */
  listenTo(dispatchType: T, func: DispatchFunc<M>, messageFilter: DispatchFilterFunc<M> = noFilter): void {
    let listeners = this._listeners.get(dispatchType);
    if (!listeners) {
      listeners = [];
      this._listeners.set(dispatchType, listeners);
    }
    listeners.push([messageFilter, func]);
  }

  /**
   * Dispatch a message to listeners.
   *
   * Listeners are called "soon" (in a microtask), returns promises for all calls.
   */
  dispatch(dispatchType: T, message: M): Array<Promise<void>> {
    const tasks: Array<Promise<void>> = [];
    const listeners = this._listeners.get(dispatchType) ?? [];
    for (const [filterFunc, func] of listeners) {
      if (!filterFunc(message)) continue;
      LOGGER.debug("Dispatching message with type %s to %s", dispatchType, func.name || "<anonymous>");
      tasks.push(
        new Promise<void>((resolve) => {
          queueMicrotask(async () => {
            // Make sure to catch any exceptions caused by the listener
            try {
              await func(message);
            } catch (ex) {
              if (!(ex instanceof CancelledError)) LOGGER.error("error during dispatch: %s", ex);
            }
            resolve();
          });
        }),
      );
    }
    return tasks;
  }
}
