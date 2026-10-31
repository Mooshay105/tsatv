/** Unit tests for pyatv.auth.hap_tlv8. */

import { describe, expect, test } from "bun:test";
import {
  checkTlvError,
  describeTlvError,
  ErrorCode,
  readTlv,
  requireTlv,
  stringify,
  TlvValue,
  writeTlv,
} from "../../src/auth/hap_tlv8.ts";
import { AuthenticationError } from "../../src/exceptions.ts";
import { b } from "../utils.ts";

const SINGLE_KEY_IN = new Map([[10, b("123")]]);
const SINGLE_KEY_OUT = b("\x0a\x03\x31\x32\x33");

const DOUBLE_KEY_IN = new Map([
  [1, b("111")],
  [4, b("222")],
]);
const DOUBLE_KEY_OUT = b("\x01\x03\x31\x31\x31\x04\x03\x32\x32\x32");

const LARGE_KEY_IN = new Map([[2, b("\x31".repeat(256))]]);
const LARGE_KEY_OUT = b("\x02\xff" + "\x31".repeat(255) + "\x02\x01\x31");

test("write single key", () => expect(writeTlv(SINGLE_KEY_IN)).toEqual(SINGLE_KEY_OUT));
test("write two keys", () => expect(writeTlv(DOUBLE_KEY_IN)).toEqual(DOUBLE_KEY_OUT));
test("write key larger than 255 bytes", () => expect(writeTlv(LARGE_KEY_IN)).toEqual(LARGE_KEY_OUT));
test("read single key", () => expect(readTlv(SINGLE_KEY_OUT)).toEqual(SINGLE_KEY_IN));
test("read two keys", () => expect(readTlv(DOUBLE_KEY_OUT)).toEqual(DOUBLE_KEY_IN));
test("read key larger than 255 bytes", () => expect(readTlv(LARGE_KEY_OUT)).toEqual(LARGE_KEY_IN));

const single = (key: number, value: Buffer) => new Map([[key, value]]);

test("stringify method", () => {
  expect(stringify(single(TlvValue.Method, b("\x00")))).toBe("Method=PairSetup");
  expect(stringify(single(TlvValue.Method, b("\x02")))).toBe("Method=PairVerify");
});

test("stringify seqno", () => {
  for (let i = 1; i <= 6; i++) {
    expect(stringify(single(TlvValue.SeqNo, Buffer.from([i])))).toBe(`SeqNo=M${i}`);
  }
});

test("stringify error", () => {
  expect(stringify(single(TlvValue.Error, b("\x02")))).toBe("Error=Authentication");
  expect(stringify(single(TlvValue.Error, b("\x05")))).toBe("Error=MaxTries");
});

test("stringify backoff", () => {
  expect(stringify(single(TlvValue.BackOff, b("\x02\x00")))).toBe("BackOff=2s");
});

test("stringify remaining short", () => {
  const values = [
    TlvValue.Identifier,
    TlvValue.Salt,
    TlvValue.PublicKey,
    TlvValue.Proof,
    TlvValue.EncryptedData,
    TlvValue.Certificate,
    TlvValue.Signature,
    TlvValue.Permissions,
    TlvValue.FragmentData,
    TlvValue.FragmentLast,
  ];
  for (const value of values) {
    expect(stringify(single(value, b("\x00\x01\x02\x03")))).toBe(`${TlvValue[value]}=4bytes`);
  }
});

test("stringify multiple", () => {
  expect(
    stringify(
      new Map([
        [TlvValue.Method, b("\x00")],
        [TlvValue.SeqNo, b("\x01")],
        [TlvValue.Error, b("\x03")],
        [TlvValue.BackOff, b("\x01\x00")],
      ]),
    ),
  ).toBe("Method=PairSetup, SeqNo=M1, Error=BackOff, BackOff=1s");
});

test("stringify unknown values", () => {
  expect(
    stringify(
      new Map([
        [TlvValue.Method, b("\xaa")],
        [TlvValue.SeqNo, b("\xab")],
        [TlvValue.Error, b("\xac")],
        [0xad, b("\x01\x02\x03")],
      ]),
    ),
  ).toBe("Method=0xaa, SeqNo=0xab, Error=0xac, 0xad=3bytes");
});

describe("pairing errors", () => {
  const tlv = (entries: Array<[number, number[]]>) => new Map(entries.map(([k, v]) => [k, Buffer.from(v)]));

  test("no error", () => {
    const data = tlv([[TlvValue.Salt, [1, 2]]]);
    expect(describeTlvError(data)).toBeNull();
    expect(checkTlvError(data)).toBe(data);
  });

  test("back off with delay", () => {
    const data = tlv([
      [TlvValue.SeqNo, [2]],
      [TlvValue.Error, [ErrorCode.BackOff]],
      [TlvValue.BackOff, [30]],
    ]);
    expect(describeTlvError(data)).toStartWith("too many failed attempts, try again in 30 seconds");
    expect(() => checkTlvError(data)).toThrow(AuthenticationError);
  });

  test("max tries", () => {
    const data = tlv([[TlvValue.Error, [ErrorCode.MaxTries]]]);
    expect(() => checkTlvError(data)).toThrow("too many failed attempts");
  });

  test("unknown error code", () => {
    expect(describeTlvError(tlv([[TlvValue.Error, [0x42]]]))).toStartWith("device reported pairing error 66");
  });

  test("missing value", () => {
    const data = tlv([[TlvValue.SeqNo, [2]]]);
    expect(() => requireTlv(data, TlvValue.Salt)).toThrow("Salt missing in pairing response");
    expect(requireTlv(tlv([[TlvValue.Salt, [7]]]), TlvValue.Salt)).toEqual(Buffer.from([7]));
  });
});
