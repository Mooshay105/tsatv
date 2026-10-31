/**
 * Functional tests for atvproxy.
 *
 * NB: There are no tests for atvproxy in pyatv. These tests put a proxy between pyatv
 * and a fake device and verify that traffic flows through it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { connect } from "../../src/index.ts";
import { CLIENT_CREDENTIALS } from "../../src/auth/server_auth.ts";
import { AppleTV, ManualService } from "../../src/conf.ts";
import { DeviceState, Protocol } from "../../src/const.ts";
import type * as iface from "../../src/interface.ts";
import { CompanionAppleTVProxy, MrpAppleTVProxy } from "../../src/scripts/atvproxy.ts";
import { createServer, type Server } from "../../src/support/transport.ts";
import "../fake_device/companion.ts";
import { FakeAppleTV } from "../fake_device/index.ts";
import "../fake_device/mrp.ts";
import { until } from "../utils.ts";

let fakeAtv: FakeAppleTV;
let proxyServer: Server | null;
let client: iface.AppleTV | null;
const proxies: Array<{ stop?(): void; connectionLost?(exc: Error | null): void }> = [];

beforeEach(async () => {
  fakeAtv = new FakeAppleTV(false);
  proxyServer = null;
  client = null;
});

afterEach(async () => {
  if (client) await Promise.allSettled(client.close());
  for (const proxy of proxies.splice(0)) proxy.stop?.() ?? proxy.connectionLost?.(null);
  proxyServer?.close();
  await fakeAtv.stop();
});

test("mrp proxy", async () => {
  const [, usecase] = fakeAtv.addService(Protocol.MRP);
  await fakeAtv.start();

  proxyServer = await createServer(
    () => {
      const proxy = new MrpAppleTVProxy("127.0.0.1", fakeAtv.getPort(Protocol.MRP), CLIENT_CREDENTIALS);
      proxies.push(proxy);
      void proxy.start();
      return proxy;
    },
    "127.0.0.1",
    0,
  );

  const conf = new AppleTV("127.0.0.1", "Proxy");
  conf.addService(new ManualService("mrp_id", Protocol.MRP, proxyServer.port, {}, { credentials: CLIENT_CREDENTIALS }));
  client = await connect(conf);

  usecase.exampleVideo({ paused: false, title: "via proxy" });
  await until(async () => (await client!.metadata.playing()).title === "via proxy");
  expect((await client.metadata.playing()).deviceState).toBe(DeviceState.Playing);
});

test("companion proxy", async () => {
  const [state, usecase] = fakeAtv.addService(Protocol.Companion);
  await fakeAtv.start();

  proxyServer = await createServer(
    () => {
      const proxy = new CompanionAppleTVProxy("127.0.0.1", fakeAtv.getPort(Protocol.Companion), CLIENT_CREDENTIALS);
      proxies.push(proxy);
      void proxy.start();
      return proxy;
    },
    "127.0.0.1",
    0,
  );

  const conf = new AppleTV("127.0.0.1", "Proxy");
  conf.addService(new ManualService("airplay_id", Protocol.AirPlay, 0, {}));
  conf.addService(new ManualService(null, Protocol.Companion, proxyServer.port, {}, { credentials: CLIENT_CREDENTIALS }));
  client = await connect(conf);

  usecase.setInstalledApps({ "com.test.app": "Test App" });
  const apps = await client.apps.appList();
  expect(apps.map((app) => app.identifier)).toEqual(["com.test.app"]);

  await client.apps.launchApp("com.test.app");
  await until(() => state.activeApp === "com.test.app");
});
