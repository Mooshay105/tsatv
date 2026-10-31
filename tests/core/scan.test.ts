/** Unit tests for scan module (zeroconf based scanners are not ported). */

import { expect, spyOn, test } from "bun:test";
import type { Response, Service } from "../../src/core/mdns.ts";
import { getUniqueIdentifiers, scanHooks } from "../../src/core/scan.ts";

const TEST_SERVICE1: Service = { type: "_service1._tcp.local", name: "service1", address: null, port: 0, properties: { a: "b" } };
const TEST_SERVICE2: Service = { type: "_service2._tcp.local", name: "service2", address: null, port: 0, properties: { c: "d" } };

const response = (): Response => ({ services: [], deepSleep: false, model: null });

test("unique identifier empty", () => {
  expect([...getUniqueIdentifiers(response())].length).toBe(0);
});

test("unique identifiers", () => {
  const resp = response();
  resp.services.push(TEST_SERVICE1, TEST_SERVICE2);
  const ids = ["id1", "id2"];
  const mock = spyOn(scanHooks, "getUniqueId").mockImplementation(() => ids.shift()!);
  const identifiers = getUniqueIdentifiers(resp);
  expect(identifiers.next().value).toBe("id1");
  expect(mock).toHaveBeenLastCalledWith("_service1._tcp.local", "service1", { a: "b" });
  expect(identifiers.next().value).toBe("id2");
  expect(mock).toHaveBeenLastCalledWith("_service2._tcp.local", "service2", { c: "d" });
  expect(identifiers.next().done).toBe(true);
  mock.mockRestore();
});
