/** Functional tests pyatv.core.mdns. */

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as mdns from "../../src/core/mdns.ts";
import * as net from "../../src/support/net.ts";
import * as fakeUdns from "../fake_udns.ts";
import { until } from "../utils.ts";

const SERVICE_NAME = "Kitchen";
const MEDIAREMOTE_SERVICE = "_mediaremotetv._tcp.local";
const SERVICES_PER_REQUEST = 3;

const TEST_SERVICES = () =>
  Object.fromEntries([fakeUdns.mrpService(SERVICE_NAME, SERVICE_NAME, "mrp_id", { addresses: ["127.0.0.1"], port: 1234 })]);

const genTestServices = (count: number) => Array.from({ length: count }, (_, i) => `srv${i}._tcp.local`);

let udnsServer: fakeUdns.FakeUdns;
const spies: Array<{ mockRestore(): void }> = [];
let clients: Array<Promise<void>> = [];
let conditions = { responses: 1, requests: 0 };

beforeEach(async () => {
  udnsServer = new fakeUdns.FakeUdns(TEST_SERVICES());
  await udnsServer.start();
  conditions = { responses: 1, requests: 0 };
  clients = [];

  spies.push(spyOn(net, "getPrivateAddresses").mockImplementation(() => ["127.0.0.1"]));

  // Requests are normally not sent to localhost, so fake that localhost is not loopback
  spies.push(spyOn(mdns.mdnsHooks, "isLoopback").mockImplementation(() => false));

  // Make sure multicast does not listen on any global port (i.e. 5353)
  const realMcastSocket = net.mcastSocket;
  spies.push(
    spyOn(net, "mcastSocket").mockImplementation((addr: string | null, port = 0) =>
      realMcastSocket(addr, port === udnsServer.port ? port : 0),
    ),
  );

  // Hook into multicast protocol and abort waiting when expected responses arrived
  spies.push(
    spyOn(mdns.mdnsHooks, "onMulticastProtocol").mockImplementation((protocol) => {
      const checkCond = () => {
        if (protocol.queryResponses.size === conditions.responses) return false;
        if (conditions.requests === 0) return true;
        return udnsServer.requestCount < conditions.responses;
      };
      clients.push(
        (async () => {
          await until(() => !checkCond());
          protocol.semaphore.release();
        })(),
      );
    }),
  );
});

afterEach(async () => {
  await Promise.all(clients);
  while (spies.length) spies.pop()!.mockRestore();
  udnsServer.close();
});

const multicastFastexit = (c: Partial<typeof conditions>) => Object.assign(conditions, c);

async function unicast(serviceNames: string[], timeout = 1): Promise<[mdns.Response, fakeUdns.FakeDnsService | undefined]> {
  return [await mdns.unicast("127.0.0.1", serviceNames, udnsServer.port, timeout), TEST_SERVICES()[serviceNames[0]!]];
}

test("unicast has valid service", async () => {
  const [resp, service] = await unicast([MEDIAREMOTE_SERVICE]);
  expect(resp.services.length).toBe(1);
  expect(resp.services[0]!.type).toBe(MEDIAREMOTE_SERVICE);
  expect(resp.services[0]!.name).toBe(service!.name);
  expect(resp.services[0]!.port).toBe(service!.port);
});

test.each([
  [1, 1],
  [SERVICES_PER_REQUEST, 1],
  [SERVICES_PER_REQUEST + 1, 2],
  [2 * SERVICES_PER_REQUEST + 1, 3],
])("unicast multiple requests %p", async (serviceCount, expectedRequests) => {
  await unicast(genTestServices(serviceCount));
  expect(udnsServer.requestCount).toBe(expectedRequests);
});

test("unicast resend if no response", async () => {
  udnsServer.skipCount = 2;
  const [resp, service] = await unicast([MEDIAREMOTE_SERVICE], 3);
  expect(resp.services.length).toBe(1);
  expect(resp.services[0]!.type).toBe(MEDIAREMOTE_SERVICE);
  expect(resp.services[0]!.name).toBe(service!.name);
  expect(resp.services[0]!.port).toBe(service!.port);
});

test("unicast specific service", async () => {
  const [resp] = await unicast([SERVICE_NAME + "." + MEDIAREMOTE_SERVICE]);
  expect(resp.services.length).toBe(1);
  const service = TEST_SERVICES()[MEDIAREMOTE_SERVICE]!;
  expect(resp.services[0]!.type).toBe(MEDIAREMOTE_SERVICE);
  expect(resp.services[0]!.name).toBe(service.name);
  expect(resp.services[0]!.port).toBe(service.port);
});

test("unicast includes sleep proxy service", async () => {
  udnsServer.services = {
    "_test._tcp.local": { name: "test", addresses: ["127.0.0.1"], port: 1234, properties: {}, model: null },
    "_sleep-proxy._udp.local": { name: "sleepy", addresses: ["127.0.0.1"], port: 5678, properties: {}, model: null },
  };
  const [resp] = await unicast(["_test._tcp.local"]);
  expect(resp.services.length).toBe(2);
  const proxy = resp.services.find((s) => s.type === "_sleep-proxy._udp.local")!;
  expect(proxy.name).toBe("sleepy");
  expect(proxy.port).toBe(5678);
});

test("multicast no response", async () => {
  multicastFastexit({ responses: 0, requests: 0 });
  await mdns.multicast([], { address: "127.0.0.1", port: udnsServer.port });
});

test("multicast has valid service", async () => {
  multicastFastexit({ responses: 1, requests: 0 });
  const resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp.length).toBe(1);
  const first = resp[0]!.services[0]!;
  expect(first.type).toBe(MEDIAREMOTE_SERVICE);
  expect(first.name).toBe(SERVICE_NAME);
  expect(first.port).toBe(1234);
});

test("multicast end condition met", async () => {
  multicastFastexit({ responses: 1, requests: 10 });
  const actor = mock((_r: mdns.Response) => undefined);
  const resp = await mdns.multicast([MEDIAREMOTE_SERVICE], {
    address: "127.0.0.1",
    port: udnsServer.port,
    endCondition: (response) => {
      actor(response);
      return true;
    },
  });
  expect(resp.length).toBe(1);
  expect(actor).toHaveBeenCalledTimes(1);
  expect(actor.mock.calls[0]![0].services).toEqual(resp[0]!.services);
});

test("multicast sleeping device", async () => {
  multicastFastexit({ responses: 0, requests: 3 });
  udnsServer.sleepProxy = true;
  udnsServer.services = {
    [MEDIAREMOTE_SERVICE]: { name: SERVICE_NAME, addresses: [], port: 0, properties: {}, model: null },
  };
  let resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp.length).toBe(0);

  multicastFastexit({ responses: 1, requests: 0 });
  udnsServer.services = TEST_SERVICES();
  resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp.length).toBe(1);
});

test("multicast deep sleep", async () => {
  multicastFastexit({ responses: 1, requests: 0 });
  let resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp[0]!.deepSleep).toBe(false);

  udnsServer.sleepProxy = true;
  multicastFastexit({ responses: 1, requests: 0 });
  resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp[0]!.deepSleep).toBe(true);
});

test("multicast device model", async () => {
  multicastFastexit({ responses: 1, requests: 0 });
  let resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp[0]!.model).toBeFalsy();

  udnsServer.services = {
    [MEDIAREMOTE_SERVICE]: { name: SERVICE_NAME, addresses: ["127.0.0.1"], port: 1234, properties: {}, model: "dummy" },
  };
  multicastFastexit({ responses: 1, requests: 0 });
  resp = await mdns.multicast([MEDIAREMOTE_SERVICE], { address: "127.0.0.1", port: udnsServer.port });
  expect(resp[0]!.model).toBe("dummy");
});
