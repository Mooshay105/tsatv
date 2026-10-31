/** Unit tests for pyatv.protocols.raop.parsers. */

import { expect, test } from "bun:test";
import { ProtocolError } from "../../../src/exceptions.ts";
import {
  EncryptionType,
  getAudioProperties,
  getEncryptionTypes,
  getMetadataTypes,
  MetadataType,
} from "../../../src/protocols/raop/parsers.ts";

test.each([
  [{}, 44100, 2, 2],
  [{ sr: "22050" }, 22050, 2, 2],
  [{ ch: "4" }, 44100, 4, 2],
  [{ ss: "32" }, 44100, 2, 4],
] as Array<[Record<string, string>, number, number, number]>)("parse audio properties %p", (properties, sr, ch, ss) => {
  expect(getAudioProperties(properties)).toEqual([sr, ch, ss]);
});

test.each([{ sr: "abc" }, { ch: "cde" }, { ss: "fgh" }] as Array<Record<string, string>>)("parse invalid audio property raises %p", (properties) => {
  expect(() => getAudioProperties(properties)).toThrow(ProtocolError);
});

test.each([
  [{ et: "0" }, EncryptionType.Unencrypted],
  [{ et: "1" }, EncryptionType.RSA],
  [{ et: "3" }, EncryptionType.FairPlay],
  [{ et: "4" }, EncryptionType.MFiSAP],
  [{ et: "5" }, EncryptionType.FairPlaySAPv25],
  [{ et: "0,1" }, EncryptionType.Unencrypted | EncryptionType.RSA],
] as Array<[Record<string, string>, number]>)("parse encryption type %p", (properties, expected) => {
  expect(getEncryptionTypes(properties)).toBe(expected);
});

test.each([{}, { et: "" }, { et: "foobar" }])("parse encryption bad types %p", (properties) => {
  expect(getEncryptionTypes(properties as Record<string, string>)).toBe(EncryptionType.Unknown);
});

test("parse encryption include unknown type", () => {
  expect(getEncryptionTypes({ et: "0,1000" })).toBe(EncryptionType.Unknown | EncryptionType.Unencrypted);
});

test.each([
  [{}, MetadataType.NotSupported],
  [{ md: "0" }, MetadataType.Text],
  [{ md: "1" }, MetadataType.Artwork],
  [{ md: "0,1,2" }, MetadataType.Text | MetadataType.Artwork | MetadataType.Progress],
] as Array<[Record<string, string>, number]>)("parse metadata types %p", (properties, expected) => {
  expect(getMetadataTypes(properties)).toBe(expected);
});
