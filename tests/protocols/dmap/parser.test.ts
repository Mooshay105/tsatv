/** Unit tests for pyatv.protocols.dmap.parser. */

import { expect, test } from "bun:test";
import { InvalidDmapDataError } from "../../../src/exceptions.ts";
import * as parser from "../../../src/protocols/dmap/parser.ts";
import * as tags from "../../../src/protocols/dmap/tags.ts";
import * as plistlib from "../../../src/support/plistlib.ts";
import { b } from "../../utils.ts";

const TEST_TAGS: Record<string, parser.DmapTag> = {
  uuu8: new parser.DmapTag(tags.readUint, "uint8"),
  uu16: new parser.DmapTag(tags.readUint, "uint16"),
  uu32: new parser.DmapTag(tags.readUint, "uint32"),
  uu64: new parser.DmapTag(tags.readUint, "uint64"),
  bola: new parser.DmapTag(tags.readBool, "bool"),
  bolb: new parser.DmapTag(tags.readBool, "bool"),
  stra: new parser.DmapTag(tags.readStr, "string"),
  strb: new parser.DmapTag(tags.readStr, "string"),
  cona: new parser.DmapTag("container", "container"),
  conb: new parser.DmapTag("container", "container 2"),
  igno: new parser.DmapTag(tags.readIgnore, "ignore"),
  plst: new parser.DmapTag(tags.readBplist, "bplist"),
  byte: new parser.DmapTag(tags.readBytes, "bytes"),
};

const lookupTag = (name: string) => TEST_TAGS[name]!;

test("empty data", () => expect(parser.parse(b(""), lookupTag)).toEqual([]));

test("parse uint of various lengths", () => {
  const inData = Buffer.concat([
    tags.uint8Tag("uuu8", 12),
    tags.uint16Tag("uu16", 37888),
    tags.uint32Tag("uu32", 305419896),
    tags.uint64Tag("uu64", 8982983289232),
  ]);
  const parsed = parser.parse(inData, lookupTag);
  expect(parsed.length).toBe(4);
  expect(parser.first(parsed, "uuu8")).toBe(12);
  expect(parser.first(parsed, "uu16")).toBe(37888);
  expect(parser.first(parsed, "uu32")).toBe(305419896);
  expect(parser.first(parsed, "uu64")).toBe(8982983289232);
});

test("parse bool", () => {
  const parsed = parser.parse(Buffer.concat([tags.boolTag("bola", true), tags.boolTag("bolb", false)]), lookupTag);
  expect(parsed.length).toBe(2);
  expect(parser.first(parsed, "bola")).toBe(true);
  expect(parser.first(parsed, "bolb")).toBe(false);
});

test("parse strings", () => {
  const parsed = parser.parse(Buffer.concat([tags.stringTag("stra", ""), tags.stringTag("strb", "test string")]), lookupTag);
  expect(parsed.length).toBe(2);
  expect(parser.first(parsed, "stra")).toBe("");
  expect(parser.first(parsed, "strb")).toBe("test string");
});

test("parse binary plist", () => {
  const data = { key: "value" };
  const parsed = parser.parse(tags.rawTag("plst", plistlib.dumps(data, plistlib.FMT_BINARY)), lookupTag);
  expect(parsed.length).toBe(1);
  expect(parser.first(parsed, "plst")).toEqual(data);
});

test("parse bytes", () => {
  const parsed = parser.parse(tags.rawTag("byte", b("\x01\xaa\xff\x45")), lookupTag);
  expect(parsed.length).toBe(1);
  expect(parser.first(parsed, "byte")).toBe("0x01aaff45");
});

test("parse value in container", () => {
  const inData = tags.containerTag("cona", Buffer.concat([tags.uint8Tag("uuu8", 36), tags.uint16Tag("uu16", 13000)]));
  const parsed = parser.parse(inData, lookupTag);
  expect(parsed.length).toBe(1);
  const inner = parser.first(parsed, "cona");
  expect(inner.length).toBe(2);
  expect(parser.first(inner, "uuu8")).toBe(36);
  expect(parser.first(inner, "uu16")).toBe(13000);
});

test("extract simplified container", () => {
  const inData = tags.containerTag("cona", tags.containerTag("conb", tags.uint8Tag("uuu8", 12)));
  expect(parser.first(parser.parse(inData, lookupTag), "cona", "conb", "uuu8")).toBe(12);
});

test("ignore value", () => {
  const parsed = parser.parse(tags.uint8Tag("igno", 44), lookupTag);
  expect(parser.first(parsed, "igno")).toBeUndefined();
});

test("simple pprint", () => {
  const inData = tags.containerTag("cona", tags.containerTag("conb", tags.uint8Tag("uuu8", 12)));
  const parsed = parser.parse(inData, lookupTag);
  expect(parser.pprint(parsed, lookupTag)).toBe(
    "cona: [container, container]\n" + "  conb: [container, container 2]\n" + "    uuu8: 12 [uint, uint8]\n",
  );
});

test("print invalid input raises exception", () => {
  expect(() => parser.pprint("bad data", lookupTag)).toThrow(InvalidDmapDataError);
});
