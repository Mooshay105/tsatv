/** Unit tests for pyatv.conf. */

import { beforeEach, expect, test } from "bun:test";
import { AppleTV, ManualService } from "../src/conf.ts";
import { Protocol } from "../src/const.ts";
import { NoServiceError } from "../src/exceptions.ts";
import { Settings } from "../src/settings.ts";

const ADDRESS_1 = "127.0.0.1";
const NAME = "Alice";
const PORT_1 = 1234;
const PORT_2 = 5678;
const PORT_3 = 1111;
const PORT_4 = 5555;
const IDENTIFIER_1 = "id1";
const IDENTIFIER_2 = "id2";
const IDENTIFIER_3 = "id3";
const IDENTIFIER_4 = "id4";
const PASSWORD_1 = "password1";

const TEST_PROPERTIES: any = { "_test._tcp.local": { foo: "bar" } };

const DMAP_SERVICE = new ManualService(IDENTIFIER_1, Protocol.DMAP, PORT_1, {});
const MRP_SERVICE = new ManualService(IDENTIFIER_2, Protocol.MRP, PORT_2, TEST_PROPERTIES);
const AIRPLAY_SERVICE = new ManualService(IDENTIFIER_3, Protocol.AirPlay, PORT_1, {});
const COMPANION_SERVICE = new ManualService(null, Protocol.Companion, PORT_3, {});
const RAOP_SERVICE = new ManualService(IDENTIFIER_4, Protocol.RAOP, PORT_4, {});

let config: AppleTV;
beforeEach(() => {
  config = new AppleTV(ADDRESS_1, NAME, { deepSleep: true });
});

test("address and name", () => {
  expect(config.address).toBe(ADDRESS_1);
  expect(config.name).toBe(NAME);
});

test("equality", () => {
  expect(config.equals(config)).toBe(true);
  const atv2 = new AppleTV(ADDRESS_1, NAME);
  atv2.addService(new ManualService(IDENTIFIER_1, Protocol.AirPlay, PORT_1, {}));
  expect(config.equals(atv2)).toBe(false);
});

test("properties", () => {
  expect("_test._tcp.local" in MRP_SERVICE.properties).toBe(true);
  expect(MRP_SERVICE.properties["_test._tcp.local"]).toEqual({ foo: "bar" } as any);
});

test("add services and get", () => {
  for (const s of [DMAP_SERVICE, MRP_SERVICE, AIRPLAY_SERVICE, COMPANION_SERVICE, RAOP_SERVICE]) config.addService(s);
  const services = config.services;
  expect(services).toContain(DMAP_SERVICE);
  expect(services).toContain(MRP_SERVICE);
  expect(services).toContain(AIRPLAY_SERVICE);
  expect(services).toContain(COMPANION_SERVICE);
  expect(config.getService(Protocol.DMAP)).toBe(DMAP_SERVICE);
  expect(config.getService(Protocol.MRP)).toBe(MRP_SERVICE);
  expect(config.getService(Protocol.AirPlay)).toBe(AIRPLAY_SERVICE);
  expect(config.getService(Protocol.RAOP)).toBe(RAOP_SERVICE);
});

test("identifier order", () => {
  expect(config.identifier).toBeNull();
  config.addService(RAOP_SERVICE);
  expect(config.identifier).toBe(IDENTIFIER_4);
  config.addService(DMAP_SERVICE);
  expect(config.identifier).toBe(IDENTIFIER_1);
  config.addService(MRP_SERVICE);
  expect(config.identifier).toBe(IDENTIFIER_2);
  config.addService(AIRPLAY_SERVICE);
  expect(config.identifier).toBe(IDENTIFIER_2);
});

test("identifier missing for service", () => {
  config.addService(DMAP_SERVICE);
  config.addService(new ManualService(null, Protocol.MRP, 0, {}));
  expect(config.identifier).toBe(DMAP_SERVICE.identifier);
});

test("add airplay service", () => {
  config.addService(AIRPLAY_SERVICE);
  const airplay = config.getService(Protocol.AirPlay)!;
  expect(airplay.protocol).toBe(Protocol.AirPlay);
  expect(airplay.port).toBe(PORT_1);
});

test("main service no service", () => {
  expect(() => config.mainService()).toThrow(NoServiceError);
});

test("main service companion no service", () => {
  config.addService(COMPANION_SERVICE);
  expect(() => config.mainService()).toThrow(NoServiceError);
});

test("main service get service", () => {
  config.addService(RAOP_SERVICE);
  expect(config.mainService()).toBe(RAOP_SERVICE);
  config.addService(AIRPLAY_SERVICE);
  expect(config.mainService()).toBe(AIRPLAY_SERVICE);
  config.addService(DMAP_SERVICE);
  expect(config.mainService()).toBe(DMAP_SERVICE);
  config.addService(MRP_SERVICE);
  expect(config.mainService()).toBe(MRP_SERVICE);
});

test("main service override protocol", () => {
  config.addService(DMAP_SERVICE);
  config.addService(MRP_SERVICE);
  expect(config.mainService(DMAP_SERVICE.protocol)).toBe(DMAP_SERVICE);
});

test("set credentials for missing service", () => {
  expect(config.setCredentials(Protocol.DMAP, "dummy")).toBe(false);
});

test("set credentials", () => {
  config.addService(new ManualService(IDENTIFIER_1, Protocol.DMAP, PORT_1, {}));
  expect(config.getService(Protocol.DMAP)!.credentials).toBeNull();
  config.setCredentials(Protocol.DMAP, "dummy");
  expect(config.getService(Protocol.DMAP)!.credentials).toBe("dummy");
});

test.each([
  [DMAP_SERVICE, true],
  [MRP_SERVICE, true],
  [AIRPLAY_SERVICE, true],
  [COMPANION_SERVICE, false],
  [RAOP_SERVICE, true],
])("ready %#", (service, expected) => {
  expect(config.ready).toBe(false);
  config.addService(service);
  expect(config.ready).toBe(expected);
});

test("to str", () => {
  config.addService(new ManualService(IDENTIFIER_1, Protocol.DMAP, 3689, {}, { credentials: "LOGIN_ID" }));
  config.addService(new ManualService(IDENTIFIER_2, Protocol.MRP, PORT_2, {}));
  const output = String(config);
  expect(output).toContain(ADDRESS_1);
  expect(output).toContain(NAME);
  expect(output).toContain("LOGIN_ID");
  expect(output).toContain(String(PORT_2));
  expect(output).toContain("3689");
  expect(output).toContain("Deep Sleep: True");
});

test("str service disabled", () => {
  config.addService(new ManualService(IDENTIFIER_2, Protocol.MRP, PORT_2, {}, { enabled: false }));
  expect(String(config)).toContain("(Disabled)");
});

test("raop password in str", () => {
  config.addService(new ManualService(IDENTIFIER_1, Protocol.RAOP, 1234, {}, { password: PASSWORD_1 }));
  expect(String(config)).toContain(PASSWORD_1);
});

test.each([
  ["pass1", null, "pass1"],
  [null, "pass2", "pass2"],
  ["pass2", "pass1", "pass1"],
])("service merge password %#", (password1, password2, expected) => {
  const service1 = new ManualService("id1", Protocol.DMAP, 0, {});
  const service2 = new ManualService("id2", Protocol.DMAP, 0, {});
  service1.password = password1;
  service2.password = password2;
  service1.merge(service2);
  expect(service1.password).toBe(expected);
});

test.each([
  ["creds1", null, "creds1"],
  [null, "creds2", "creds2"],
  ["creds2", "creds1", "creds1"],
])("service merge credentials %#", (creds1, creds2, expected) => {
  const service1 = new ManualService("id1", Protocol.DMAP, 0, {});
  const service2 = new ManualService("id2", Protocol.DMAP, 0, {});
  service1.credentials = creds1;
  service2.credentials = creds2;
  service1.merge(service2);
  expect(service1.credentials).toBe(expected);
});

test.each([
  [{ foo: "bar" }, null, { foo: "bar" }],
  [null, { foo: "bar" }, { foo: "bar" }],
  [{ foo: "bar" }, { foo: "bar2", test: "dummy" }, { foo: "bar2", test: "dummy" }],
] as Array<[any, any, any]>)("service merge properties %#", (props1, props2, expected) => {
  const service1 = new ManualService("id1", Protocol.DMAP, 0, props1);
  const service2 = new ManualService("id2", Protocol.DMAP, 0, props2);
  service1.merge(service2);
  expect(service1.properties).toEqual(expected);
});

test("service get settings", () => {
  const service = new ManualService("id", Protocol.DMAP, 0, {});
  expect(service.settings()).toEqual({ credentials: null, password: null });
  service.credentials = "abc";
  expect(service.settings()).toEqual({ credentials: "abc", password: null });
  service.password = "def";
  expect(service.settings()).toEqual({ credentials: "abc", password: "def" });
});

test("service apply settings", () => {
  const service = new ManualService("id", Protocol.DMAP, 0, {});
  service.apply({ credentials: "creds", password: "password" });
  expect(service.credentials).toBe("creds");
  expect(service.password).toBe("password");
});

test("service do not apply empty settings", () => {
  const service = new ManualService("id", Protocol.DMAP, 0, {});
  service.credentials = "creds";
  service.password = "password";
  service.apply({ credentials: null, password: null });
  expect(service.credentials).toBe("creds");
  expect(service.password).toBe("password");
});

test("config apply settings", () => {
  for (const s of [DMAP_SERVICE, MRP_SERVICE, AIRPLAY_SERVICE, COMPANION_SERVICE, RAOP_SERVICE]) {
    config.addService(s.deepcopy());
  }
  const settings = new Settings();
  settings.protocols.airplay.credentials = "airplay";
  settings.protocols.companion.credentials = "companion";
  settings.protocols.dmap.credentials = "dmap";
  settings.protocols.mrp.credentials = "mrp";
  settings.protocols.raop.credentials = "raop";
  config.apply(settings);
  expect(config.getService(Protocol.AirPlay)!.credentials).toBe("airplay");
  expect(config.getService(Protocol.Companion)!.credentials).toBe("companion");
  expect(config.getService(Protocol.DMAP)!.credentials).toBe("dmap");
  expect(config.getService(Protocol.MRP)!.credentials).toBe("mrp");
  expect(config.getService(Protocol.RAOP)!.credentials).toBe("raop");
});
