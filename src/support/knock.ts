/**
 * Module used to knock on TCP ports.
 *
 * This module will open a TCP-connection to one or more ports on a given host and
 * immediately close it. The use case for this is to wake a device sleeping via a
 * Bonjour sleep proxy. Such a device will automatically be woken up in case any of
 * its services are accessed, something this module will try to emulate.
 */

import net from "node:net";
import { sleep } from "./asyncio.ts";
import { getLogger } from "./logging.ts";

const LOGGER = getLogger("pyatv.support.knock");

const ABORT_KNOCK_ERRNOS = new Set(["EHOSTDOWN", "EHOSTUNREACH", "ENETUNREACH"]);

const SLEEP_AFTER_CONNECT = 0.1;
const KNOCK_TIMEOUT_BUFFER = SLEEP_AFTER_CONNECT * 2;

/** Hooks that can be replaced in tests. */
export const knockHooks = {
  openConnection(address: string, port: number): Promise<{ close(): void }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: address, port });
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve({ close: () => socket.destroy() });
      });
      socket.once("error", (err) => {
        socket.destroy();
        reject(err);
      });
    });
  },
};

class KnockTimeout extends Error {}

/** Open a connection to the device to wake a given host. */
async function asyncKnock(address: string, port: number, timeout: number): Promise<void> {
  let writer: { close(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connection = knockHooks.openConnection(address, port);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new KnockTimeout()), Math.max(0, timeout) * 1000);
    });
    connection.then(
      (w) => {
        // Close late connections (after timeout)
        if (!writer && timer === undefined) w.close();
      },
      () => undefined,
    );
    writer = await Promise.race([connection, timeoutPromise]);
    clearTimeout(timer);
    await sleep(SLEEP_AFTER_CONNECT);
  } catch (ex: any) {
    clearTimeout(timer);
    timer = undefined;
    if (ex instanceof KnockTimeout) return;
    // If we get EHOSTDOWN or EHOSTUNREACH we can give up as its not going to wake a
    // device that is not there
    const code = ex?.code ?? ex?.errno;
    if (ABORT_KNOCK_ERRNOS.has(code)) throw ex;
    // Other OS errors (e.g. connection refused) are ignored
    if (code !== undefined) return;
    throw ex;
  } finally {
    if (writer) writer.close();
  }
}

/** Knock on a set of ports for a given host. */
export async function knock(address: string, ports: number[], timeout: number): Promise<void> {
  const knockRuntime = timeout - KNOCK_TIMEOUT_BUFFER;
  const tasks: Array<Promise<void>> = [];
  for (const port of ports) {
    LOGGER.debug("Knocking at port %s on %s", port, address);
    tasks.push(asyncKnock(address, port, knockRuntime));
  }
  // Wait for all knocks to finish or the first one to fail. OS errors (unreachable
  // hosts) abort knocking, but are not raised.
  await new Promise<void>((resolve, reject) => {
    let remaining = tasks.length;
    if (remaining === 0) resolve();
    for (const task of tasks) {
      task.then(
        () => {
          if (--remaining === 0) resolve();
        },
        (err) => {
          const code = err?.code ?? err?.errno;
          if (code !== undefined) resolve();
          else reject(err);
        },
      );
    }
  });
}

/**
 * Continuously knock on a set of ports.
 *
 * Starts knocking in the background and returns the knocking task (promise).
 */
export function knocker(address: string, ports: number[], timeout = 4): Promise<void> {
  const task = knock(address, ports, timeout);
  task.catch(() => undefined);
  return task;
}
