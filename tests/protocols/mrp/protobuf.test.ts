/** Tests for protobuf runtime and generated messages (not part of Python test suite). */

import { expect, test } from "bun:test";
import * as pb from "../../../src/protocols/mrp/protobuf/index.ts";
import { b } from "../../utils.ts";

test("encode and decode simple message", () => {
  const msg = new pb.ProtocolMessage();
  msg.type = pb.ProtocolMessage.SEND_COMMAND_MESSAGE;
  msg.identifier = "abc";
  // field 1 varint 1, field 2 length-delimited "abc"
  expect(msg.serializeToString()).toEqual(b("\x08\x01\x12\x03abc"));

  const decoded = pb.ProtocolMessage.decode(msg.serializeToString());
  expect(decoded.type).toBe(pb.SEND_COMMAND_MESSAGE);
  expect(decoded.identifier).toBe("abc");
});

test("default values and presence", () => {
  const msg = new pb.ProtocolMessage();
  expect(msg.identifier).toBe("");
  expect(msg.hasField("identifier")).toBe(false);
  msg.identifier = "";
  expect(msg.hasField("identifier")).toBe(true);
  expect(msg.type).toBe(pb.ProtocolMessage.UNKNOWN_MESSAGE);
});

test("auto vivify sub messages", () => {
  const msg = new pb.ProtocolMessage();
  msg.type = pb.SEND_COMMAND_MESSAGE;
  const inner = pb.extractInner(msg) as pb.SendCommandMessage;
  expect(msg.hasField("sendCommandMessage")).toBe(false);
  inner.command = pb.Command.Play;
  expect(msg.hasField("sendCommandMessage")).toBe(true);

  inner.playerPath.client.bundleIdentifier = "com.test";
  const decoded = pb.ProtocolMessage.decode(msg.serializeToString());
  const decodedInner = pb.extractInner(decoded) as pb.SendCommandMessage;
  expect(decodedInner.command).toBe(pb.Command.Play);
  expect(decodedInner.playerPath.client.bundleIdentifier).toBe("com.test");
});

test("repeated fields and add", () => {
  const queue = new pb.PlaybackQueue();
  const item = queue.contentItems.add();
  item.identifier = "id1";
  queue.contentItems.add({ identifier: "id2" });
  const decoded = pb.PlaybackQueue.decode(queue.serializeToString());
  expect(decoded.contentItems.map((i) => i.identifier)).toEqual(["id1", "id2"]);
});

test("unknown fields are preserved", () => {
  const data = b("\x08\x01\xf8\x07\x2a"); // type=1 and unknown field 127 = 42
  const msg = pb.ProtocolMessage.decode(data);
  expect(msg.type).toBe(1);
  expect(msg.serializeToString()).toEqual(data);
  expect(msg.toString()).toBe("type: SEND_COMMAND_MESSAGE\n127: 42\n");
});

test("negative int32 and floats", () => {
  const msg = new pb.ContentItemMetadata();
  msg.playbackRate = 1.5;
  msg.elapsedTime = 12.25;
  const decoded = pb.ContentItemMetadata.decode(msg.serializeToString());
  expect(decoded.playbackRate).toBe(1.5);
  expect(decoded.elapsedTime).toBe(12.25);
});

test("text format with extension", () => {
  const msg = new pb.ProtocolMessage({ type: pb.SEND_COMMAND_MESSAGE, identifier: "a" });
  (pb.extractInner(msg) as pb.SendCommandMessage).command = pb.Command.Pause;
  expect(msg.toString()).toBe(
    'type: SEND_COMMAND_MESSAGE\nidentifier: "a"\n[sendCommandMessage] {\n  command: Pause\n}\n',
  );
});

test("unknown field in constructor raises", () => {
  expect(() => new pb.ContentItemMetadata({ artist: "b" } as any)).toThrow(TypeError);
});

test("copy and merge", () => {
  const a = new pb.ContentItemMetadata({ title: "a", duration: 10 });
  const c = new pb.ContentItemMetadata({ trackArtistName: "b" });
  c.mergeFrom(a);
  expect(c.title).toBe("a");
  expect(c.trackArtistName).toBe("b");
  const d = c.clone();
  expect(d.equals(c)).toBe(true);
  d.title = "x";
  expect(c.title).toBe("a");
});
