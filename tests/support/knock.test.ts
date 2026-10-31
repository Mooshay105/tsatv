/** Unit tests for port knocker module. */

import { afterEach, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { knock, knocker, knockHooks } from "../../src/support/knock.ts";
import { until } from "../utils.ts";

const LOCALHOST = "127.0.0.1";
const LINK_LOCAL = "169.254.0.0";
const MULTICAST_IP = "224.0.0.251";

interface KnockServer {
  port: number;
  gotKnock: boolean;
  count: number;
}

const servers: net.Server[] = [];

async function knockServer(): Promise<KnockServer> {
  const info: KnockServer = { port: 0, gotKnock: false, count: 0 };
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      throw new Error("no data shall be received");
    });
    socket.on("close", () => {
      info.gotKnock = true;
      info.count += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  info.port = (server.address() as net.AddressInfo).port;
  servers.push(server);
  return info;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.close();
});

test("single port knock", async () => {
  const server = await knockServer();
  await knock(LOCALHOST, [server.port], 1);
  await until(() => server.gotKnock);
});

test("multi port knock", async () => {
  const server1 = await knockServer();
  const server2 = await knockServer();
  await knock(LOCALHOST, [server1.port, server2.port], 1);
  await until(() => server1.gotKnock);
  await until(() => server2.gotKnock);
});

test("continuous knocking", async () => {
  const server = await knockServer();
  knocker(LOCALHOST, [server.port], 6);
  await until(() => server.count === 1);
});

test("knock does not raise", async () => {
  await knockServer();
  const task = knocker(LOCALHOST, [1], 0.5);
  // Knocking on a non-listening port should not raise
  await task;
});

test("knock times out", async () => {
  const task = knocker(LINK_LOCAL, [1], 0.3);
  // Knocking on link-local will timeout and should not raise
  await task;
});

test("abort knock unreachable host", async () => {
  const start = performance.now();
  const task = knocker(MULTICAST_IP, [1], 3);
  await task;
  expect(performance.now() - start).toBeLessThan(1000);
});

test("abort knock down host", async () => {
  const start = performance.now();
  const results: Array<() => Promise<{ close(): void }>> = [
    async () => ({ close() {} }),
    async () => ({ close() {} }),
    async () => {
      const err = new Error("host down");
      (err as any).code = "EHOSTDOWN";
      throw err;
    },
    async () => ({ close() {} }),
  ];
  const spy = spyOn(knockHooks, "openConnection").mockImplementation(() => results.shift()!());
  const task = knocker("127.0.0.1", [1, 2, 3, 4], 3);
  await task;
  spy.mockRestore();
  expect(performance.now() - start).toBeLessThan(1000);
});

test("abort knock unhandled exception", async () => {
  const spy = spyOn(knockHooks, "openConnection").mockImplementation(async () => {
    throw new TypeError("value error");
  });
  const task = knocker("127.0.0.1", [1, 2, 3, 4], 3);
  await expect(task).rejects.toBeInstanceOf(TypeError);
  spy.mockRestore();
});
