/** Unit tests for pyatv.support.dns */

import { describe, expect, test } from "bun:test";
import { BytesReader } from "../../src/support/bytes.ts";
import * as dns from "../../src/support/dns.ts";
import { b } from "../utils.ts";

const u = (text: string) => Buffer.from(text, "utf-8");

describe("service instance names", () => {
  test.each([
    ["_http._tcp.local", [null, "_http._tcp", "local"]],
    ["foo._http._tcp.local", ["foo", "_http._tcp", "local"]],
    ["foo.bar._http._tcp.local", ["foo.bar", "_http._tcp", "local"]],
  ] as Array<[string, [string | null, string, string]]>)("happy %s", (name, expected) => {
    expect(dns.ServiceInstanceName.splitName(name).toTuple()).toEqual(expected);
  });

  test.each(["_http.local", "._tcp.local", "_http.foo._tcp.local", "_tcp._http.local"])("sad %s", (name) => {
    expect(() => dns.ServiceInstanceName.splitName(name)).toThrow(RangeError);
  });
});

const encodeDomainNames: Record<string, [string | string[], Buffer]> = {
  root: [".", b("\x00")],
  empty: ["", b("\x00")],
  "example.com": ["example.com", b("\x07example\x03com\x00")],
  "example.com_list": [["example", "com"], b("\x07example\x03com\x00")],
  unicode: ["Bücher.example", Buffer.concat([b("\x07B"), b("\xc3\xbc"), b("cher\x07example\x00")])],
  dotted_instance: [
    "Dot.Within._http._tcp.example.local",
    b("\x0aDot.Within\x05_http\x04_tcp\x07example\x05local\x00"),
  ],
  dotted_instance_list: [
    ["Dot.Within", "_http", "_tcp", "example", "local"],
    b("\x0aDot.Within\x05_http\x04_tcp\x07example\x05local\x00"),
  ],
  truncated_ascii: [
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" + ".test",
    b("\x3fabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk" + "\x04test" + "\x00"),
  ],
  truncated_unicode: [
    "aがあいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも".normalize("NFD") + ".test",
    Buffer.concat([
      b("\x3d"),
      u("a"),
      u("があいうえおかきくけこさしすせそたちつて"),
      b("\x04test"),
      b("\x00"),
    ]),
  ],
};

describe("qname encode", () => {
  test.each(Object.entries(encodeDomainNames))("%s", (_id, [name, expected]) => {
    expect(dns.qnameEncode(name)).toEqual(expected);
  });
});

// raw_name, offset, expected_name, expected_offset
const decodeDomainNames: Record<string, [Buffer, number, string, number | null]> = {
  simple: [b("\x03foo\x07example\x03com\x00"), 0, "foo.example.com", null],
  null: [b("\x00"), 0, "", null],
  compressed: [b("aaaa\x04test\x00\x05label\xc0\x04\xab\xcd"), 10, "label.test", -2],
  multi_compressed: [b("aaaa\x04test\x00\x05label\xc0\x04\x03foo\xc0\x0a\xab\xcd"), 18, "foo.label.test", -2],
  idna: [b("\x0dxn--bcher-kva\x07example\x00"), 0, "bücher.example", null],
  nbsp: [Buffer.concat([b("\x10Apple"), b("\xc2\xa0"), b("TV (4167)\x05local\x00")]), 0, "Apple\xa0TV (4167).local", null],
  unicode: [
    Buffer.concat([b("\x1d"), u("居間 Apple\xa0TV. En Español"), b("\x05local"), b("\x00")]),
    0,
    "居間 Apple\xa0TV. En Español.local",
    null,
  ],
};

describe("domain name parsing", () => {
  test.each(Object.entries(decodeDomainNames))("%s", (_id, [rawName, offset, expectedName, expectedOffset]) => {
    const buffer = new BytesReader(rawName);
    buffer.seek(offset);
    expect(dns.parseDomainName(buffer)).toBe(expectedName);
    if (expectedOffset === null) {
      expect(buffer.tell()).toBe(rawName.length);
    } else {
      expect(buffer.tell()).toBe((rawName.length + expectedOffset) % rawName.length);
    }
  });
});

const decodeStrings: Record<string, [Buffer, Buffer, number | null]> = {
  null: [b("\x00"), b(""), null],
  len_63: [b("\x3f" + "0".repeat(63)), b("0".repeat(63)), null],
  len_64: [b("\x40" + "0".repeat(64)), b("0".repeat(64)), null],
  len_128: [b("\x80" + "0".repeat(128)), b("0".repeat(128)), null],
  len_192: [b("\xc0" + "0".repeat(192)), b("0".repeat(192)), null],
  len_255: [b("\xff" + "0".repeat(255)), b("0".repeat(255)), null],
  trailing: [b("\x0a" + "2".repeat(10) + "9".repeat(17)), b("2".repeat(10)), -17],
};

describe("string parsing", () => {
  test.each(Object.entries(decodeStrings))("%s", (_id, [encoded, expected, expectedOffset]) => {
    const buffer = new BytesReader(encoded);
    expect(dns.parseString(buffer)).toEqual(expected);
    if (expectedOffset === null) {
      expect(buffer.tell()).toBe(encoded.length);
    } else {
      expect(buffer.tell()).toBe((encoded.length + expectedOffset) % encoded.length);
    }
  });
});

function txt(data: Buffer, extra: Buffer) {
  const buffer = new BytesReader(Buffer.concat([data, extra]));
  const result = dns.parseTxtDict(buffer, data.length);
  expect(buffer.tell()).toBe(data.length);
  return result;
}

test("dns sd txt parse single", () => {
  const result = txt(b("\x07foo=bar"), b("\xde\xad\xbe\xef".repeat(3)));
  expect(result.toObject()).toEqual({ foo: b("bar") });
});

test("dns sd txt parse multiple", () => {
  const result = txt(b("\x07foo=bar\x09spam=eggs"), b("\xde\xad\xbe\xef".repeat(2)));
  expect(result.toObject()).toEqual({ foo: b("bar"), spam: b("eggs") });
});

test("dns sd txt parse binary", () => {
  const result = txt(b("\x06foo=\xfe\xed"), b("\xde\xad\xbe\xef".repeat(3)));
  expect(result.toObject()).toEqual({ foo: b("\xfe\xed") });
});

test("dns sd txt parse long", () => {
  const result = txt(b("\xccfoo=" + "\xca\xfe".repeat(100)), b("\xde\xad\xbe\xef".repeat(3)));
  expect(result.toObject()).toEqual({ foo: b("\xca\xfe".repeat(100)) });
});

test.each([
  [{ foo: b("bar") }, b("\x07foo=bar")],
  [new Map<string | Uint8Array, unknown>([[b("foo"), "bar"]]), b("\x07foo=bar")],
  [{ foo: "bar", spam: "eggs" }, b("\x07foo=bar\x09spam=eggs")],
] as Array<[any, Buffer]>)("dns sd txt format %#", (data, expected) => {
  expect(dns.formatTxtDict(data)).toEqual(expected);
});

describe("parse rdata", () => {
  test("A", () => {
    const buffer = new BytesReader(b("\x0a\x00\x00\x2a"));
    expect(dns.parseRdata(dns.QueryType.A, buffer, 4)).toBe("10.0.0.42");
    expect(buffer.tell()).toBe(4);
  });

  test("PTR", () => {
    const data = b("\x03foo\x07example\x03com\x00");
    const buffer = new BytesReader(data);
    expect(dns.parseRdata(dns.QueryType.PTR, buffer, data.length)).toBe("foo.example.com");
    expect(buffer.tell()).toBe(data.length);
  });

  test("TXT", () => {
    const data = b("\x07foo=bar");
    const buffer = new BytesReader(data);
    expect(dns.parseRdata(dns.QueryType.TXT, buffer, data.length).toObject()).toEqual({ foo: b("bar") });
    expect(buffer.tell()).toBe(data.length);
  });

  test("SRV", () => {
    const data = b("\x00\x0a\x00\x00\x00\x50\x03foo\x07example\x03com\x00");
    const buffer = new BytesReader(data);
    expect(dns.parseRdata(dns.QueryType.SRV, buffer, data.length)).toEqual({
      priority: 10,
      weight: 0,
      port: 80,
      target: "foo.example.com",
    });
    expect(buffer.tell()).toBe(data.length);
  });
});
