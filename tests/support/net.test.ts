/** Unit tests for pyatv.support.net. */

import { beforeEach, expect, spyOn, test } from "bun:test";
import net from "node:net";
import * as netsupport from "../../src/support/net.ts";

let adapters: netsupport.Adapter[];

beforeEach(() => {
  adapters = [];
  spyOn(netsupport, "getAdapters").mockImplementation(() => adapters);
});

const mockAddress = (iface: string, address: string) => {
  adapters.push(netsupport.makeAdapter(iface, [[address, 32]]));
};

test("no address", () => {
  expect(netsupport.getPrivateAddresses()).toEqual([]);
});

test("private addresses", () => {
  mockAddress("wlan0", "10.0.0.1");
  mockAddress("eth0", "192.168.0.1");
  mockAddress("eth1", "172.16.0.1");
  expect(netsupport.getPrivateAddresses()).toEqual(["10.0.0.1", "192.168.0.1", "172.16.0.1"]);
});

test("private addresses without loopback", () => {
  mockAddress("wlan0", "10.0.0.1");
  mockAddress("lo", "127.0.0.1");
  expect(netsupport.getPrivateAddresses(false)).toEqual(["10.0.0.1"]);
});

test("public addresses", () => {
  mockAddress("eth0", "1.2.3.4");
  mockAddress("eth1", "8.8.8.8");
  expect(netsupport.getPrivateAddresses()).toEqual([]);
});

test("localhost", () => {
  mockAddress("eth0", "127.0.0.1");
  expect(netsupport.getPrivateAddresses()).toEqual(["127.0.0.1"]);
});

test("local address reaching", () => {
  adapters.push(netsupport.makeAdapter("eth0", [["10.0.0.5", 24]]));
  expect(netsupport.getLocalAddressReaching("10.0.0.100")).toBe("10.0.0.5");
  expect(netsupport.getLocalAddressReaching("10.0.1.100")).toBeNull();
});

test("keepalive", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise((resolve) => client.once("connect", resolve));
  // No assert, as we're just testing that enabling keepalive works
  netsupport.tcpKeepalive(client);
  client.destroy();
  server.close();
});

test("unused port", () => {
  const port = netsupport.unusedPort();
  expect(port).toBeGreaterThan(0);
  expect(port).toBeLessThan(65536);
});
