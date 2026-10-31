/** Test suit for pairing process with Apple TV. */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import { createCore } from "../../../src/core/index.ts";
import { DmapPairingHandler, pairingHooks } from "../../../src/protocols/dmap/pairing.ts";
import * as parser from "../../../src/protocols/dmap/parser.ts";
import { lookupTag } from "../../../src/protocols/dmap/tag_definitions.ts";
import { MemoryStorage } from "../../../src/storage/memory_storage.ts";
import * as utils from "../../utils.ts";
import { ZeroconfStub } from "../../zeroconf_stub.ts";

const REMOTE_NAME = "pyatv remote";

// This is a valid config for default pairing guid
const PIN_CODE = 1234;
const PAIRING_GUID = "0x0000000000000001";
const PAIRING_CODE = "690E6FF61E0D7C747654A42AED17047D";

// This is valid for a some other (non-default) config
const PIN_CODE2 = 5555;
const PAIRING_GUID2 = "0x1234ABCDE56789FF";
const PAIRING_CODE2 = "58AD1D195B6DAA58AA2EA29DC25B81C3";

// Code is padded with zeros
const PIN_CODE3 = 1;
const PAIRING_GUID3 = "0x7D1324235F535AE7";
const PAIRING_CODE3 = "A34C3361C7D57D61CA41F62A8042F069";

// Pairing guid is 8 bytes, which is 64 bits
const RANDOM_128_BITS = 6558272190156386627n;
const RANDOM_PAIRING_GUID = "0x5B03A9CF4A983143";
const RANDOM_PAIRING_CODE = "7AF2D0B8629DE3C704D40A14C9E8CB93";

let storage: MemoryStorage;
let handler: DmapPairingHandler | null;

function pairingUrl(zeroconf: ZeroconfStub, pairingCode: string): string {
  const service = zeroconf.registeredServices[0]!;
  return `http://127.0.0.1:${service.port}/pair?pairingcode=${pairingCode}&servicename=test`;
}

beforeEach(() => {
  storage = new MemoryStorage();
  handler = null;
});

afterEach(async () => {
  if (handler) {
    await handler.finish();
    await handler.close();
  }
});

async function mockPairing(
  options: { pinCode?: number | null; pairingGuid?: string | null; name?: string; addresses?: string[] } = {},
): Promise<[DmapPairingHandler, ZeroconfStub, ManualService]> {
  const service = new ManualService("id", Protocol.DMAP, 0, {});
  const config = new AppleTV("Apple TV", "127.0.0.1");
  config.addService(service);
  const zeroconf = new ZeroconfStub();

  const pairingGuid = "pairingGuid" in options ? options.pairingGuid : PAIRING_GUID;
  const pinCode = "pinCode" in options ? options.pinCode : PIN_CODE;

  const settings = await storage.getSettings(config);
  const core = await createCore(config, service, { settings });

  handler = new DmapPairingHandler(core, {
    zeroconf,
    pairingGuid: pairingGuid ?? null,
    name: options.name ?? REMOTE_NAME,
    addresses: options.addresses,
  });
  await handler.begin();
  if (pinCode !== null && pinCode !== undefined) handler.pin(pinCode);
  return [handler, zeroconf, service];
}

test("zeroconf service published", async () => {
  const [, zeroconf] = await mockPairing();
  expect(zeroconf.registeredServices.length).toBe(1);
  const service = zeroconf.registeredServices[0]!;
  expect(service.properties.DvNm).toBe(REMOTE_NAME);
  expect(service.addresses).toEqual(["10.0.10.1"]);
});

test("zeroconf custom addresses", async () => {
  const addresses = ["1.2.3.4"];
  const [, zeroconf] = await mockPairing({ addresses });
  expect(zeroconf.registeredServices.length).toBe(addresses.length);
  const service = zeroconf.registeredServices[0]!;
  for (const address of addresses) expect(service.addresses).toContain(address);
});

test("succesful pairing", async () => {
  const [pairing, zeroconf, service] = await mockPairing();
  const [data] = await utils.simpleGet(pairingUrl(zeroconf, PAIRING_CODE));
  await pairing.finish();

  const parsed = parser.parse(data!, lookupTag);
  expect(parser.first(parsed, "cmpa", "cmpg")).toBe(1);
  expect(parser.first(parsed, "cmpa", "cmnm")).toBe(REMOTE_NAME);
  expect(parser.first(parsed, "cmpa", "cmty")).toBe("iPhone");

  expect(service.credentials).toBe(PAIRING_GUID);
  expect(storage.settings[0]!.protocols.dmap.credentials).toBe(PAIRING_GUID);
});

test("successful pairing random pairing guid generated", async () => {
  const spy = spyOn(pairingHooks, "getrandbits").mockImplementation(() => RANDOM_128_BITS);
  const [pairing, zeroconf, service] = await mockPairing({ pairingGuid: null });
  spy.mockRestore();
  await utils.simpleGet(pairingUrl(zeroconf, RANDOM_PAIRING_CODE));
  await pairing.finish();
  expect(service.credentials).toBe(RANDOM_PAIRING_GUID);
  expect(storage.settings[0]!.protocols.dmap.credentials).toBe(RANDOM_PAIRING_GUID);
});

test("succesful pairing with any pin", async () => {
  const [, zeroconf] = await mockPairing({ pinCode: null });
  const [, status] = await utils.simpleGet(pairingUrl(zeroconf, "invalid_pairing_code"));
  expect(status).toBe(200);
});

test("succesful pairing with pin leading zeros", async () => {
  const [, zeroconf] = await mockPairing({ pinCode: PIN_CODE3, pairingGuid: PAIRING_GUID3 });
  const [, status] = await utils.simpleGet(pairingUrl(zeroconf, PAIRING_CODE3));
  expect(status).toBe(200);
});

test("pair custom pairing guid", async () => {
  const [pairing, zeroconf, service] = await mockPairing({ pinCode: PIN_CODE2, pairingGuid: PAIRING_GUID2 });
  const [data] = await utils.simpleGet(pairingUrl(zeroconf, PAIRING_CODE2));
  await pairing.finish();
  const parsed = parser.parse(data!, lookupTag);
  expect(parser.first(parsed, "cmpa", "cmpg")).toBe(BigInt(PAIRING_GUID2));
  expect(service.credentials).toBe(PAIRING_GUID2);
  expect(storage.settings[0]!.protocols.dmap.credentials).toBe(PAIRING_GUID2);
});

test("failed pairing", async () => {
  const [, zeroconf] = await mockPairing();
  const [, status] = await utils.simpleGet(pairingUrl(zeroconf, "wrong"));
  expect(status).toBe(500);
});
