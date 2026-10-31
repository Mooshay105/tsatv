/** Unit tests for AirPlay 2 URL playback. */

import { expect, test } from "bun:test";
import { PlaybackError, ProtocolError } from "../../../src/exceptions.ts";
import { EventChannel } from "../../../src/protocols/airplay/channels.ts";
import { AirPlayPlayer, EVENT_WAIT_RETRIES } from "../../../src/protocols/airplay/player.ts";
import { StreamContext, type StreamProtocol } from "../../../src/protocols/raop/protocols/index.ts";
import { AirPlayV2 } from "../../../src/protocols/raop/protocols/airplayv2.ts";
import { HttpRequest, HttpResponse } from "../../../src/support/http.ts";
import * as plistlib from "../../../src/support/plistlib.ts";
import { HTTP_PROTOCOL, type RtspSession } from "../../../src/support/rtsp.ts";

const STREAM = "https://example.com/video.mp4";
const START_POSITION = 2.5;

function response(code = 200, body: Buffer = Buffer.alloc(0)): HttpResponse {
  return new HttpResponse(HTTP_PROTOCOL, "1.1", code, "OK", {}, body);
}

type ExchangeCall = { method: string; options: Record<string, any> };

function fakeRtsp(setupBody: Buffer, exchangeResponse: HttpResponse = response()) {
  const calls: ExchangeCall[] = [];
  const rtsp = {
    info: async () => ({}),
    record: async () => response(),
    setup: async () => response(200, setupBody),
    exchange: async (method: string, options: Record<string, any> = {}) => {
      calls.push({ method, options });
      return exchangeResponse;
    },
  };
  return { rtsp: rtsp as unknown as RtspSession, calls };
}

function protocolWithVerifier(rtsp: RtspSession): AirPlayV2 {
  const protocol = new AirPlayV2(new StreamContext(), rtsp);
  (protocol as any)._verifier = {};
  return protocol;
}

test("url commands use stream specific headers", async () => {
  const { rtsp, calls } = fakeRtsp(plistlib.dumps({ streams: [{ streamID: 7 }] }, plistlib.FMT_BINARY));
  const result = await protocolWithVerifier(rtsp).playUrl(49152, STREAM, START_POSITION);

  expect(result.code).toBe(200);
  expect(calls.length).toBe(4);
  const commands = calls.map((call) => {
    expect(call.options.uri).toBe("/command");
    expect(call.options.protocol).toBe(HTTP_PROTOCOL);
    expect(call.options.headers["X-Apple-StreamID"]).toBe("7");
    return plistlib.loads(call.options.body.params.data);
  });

  expect(commands.map((c) => c.type)).toEqual(["insertPlayQueueItem", "setProperty", "setProperty", "setRate"]);
  expect(commands[0].item["Content-Location"]).toBe(STREAM);
  expect(Number(commands[0].item["Start-Position-Seconds"])).toBe(START_POSITION);
});

test("url command failure stops sequence", async () => {
  const { rtsp, calls } = fakeRtsp(
    plistlib.dumps({ streams: [{ streamID: 3 }] }, plistlib.FMT_BINARY),
    response(500),
  );
  const result = await protocolWithVerifier(rtsp).playUrl(49152, STREAM);

  expect(result.code).toBe(500);
  expect(calls.length).toBe(1);
});

test("missing url control stream is protocol error", async () => {
  const { rtsp } = fakeRtsp(plistlib.dumps({ streams: [] }, plistlib.FMT_BINARY));
  await expect(protocolWithVerifier(rtsp).playUrl(49152, STREAM)).rejects.toThrow(ProtocolError);
});

test("event channel decodes nested playback state", () => {
  const channel = new EventChannel(Buffer.alloc(32, "0"), Buffer.alloc(32, "1"));
  const events: Array<Record<string, any>> = [];
  channel.setEventListener((e) => events.push(e));
  const event = { type: "playbackState", params: { playbackState: "playing" } };
  const body = plistlib.dumps({ params: { data: plistlib.dumps(event, plistlib.FMT_BINARY) } }, plistlib.FMT_BINARY);

  channel.processEvent(new HttpRequest("POST", "/event", "HTTP", "1.1", {}, body));

  expect(events).toEqual([event]);
});

test("airplay v2 tracks named playback state", () => {
  const protocol = new AirPlayV2(new StreamContext(), {} as RtspSession);
  (protocol as any)._handleEvent({ type: "playbackState", name: "playing" });
  expect(protocol.playbackState).toBe("playing");
});

test("airplay v2 tracks parameterized playback state", () => {
  const protocol = new AirPlayV2(new StreamContext(), {} as RtspSession);
  (protocol as any)._handleEvent({ type: "playbackState", name: "playing", params: { playbackState: "stopped" } });
  expect(protocol.playbackState).toBe("stopped");
});

test("airplay v2 ignores duplicate playback state", () => {
  const protocol = new AirPlayV2(new StreamContext(), {} as RtspSession);
  const event = { type: "playbackState", name: "loading" };
  (protocol as any)._handleEvent(event);
  (protocol as any)._playbackStateChanged.clear();

  (protocol as any)._handleEvent(event);

  expect((protocol as any)._playbackStateChanged.isSet()).toBe(false);
});

function fakeStream(states: Array<string | null> | null): { stream: StreamProtocol; count: () => number } {
  let calls = 0;
  const stream = {
    supportsPlaybackState: true,
    playbackState: null,
    waitForPlaybackStateChange: async () => {
      calls += 1;
      return states === null ? null : (states[calls - 1] ?? null);
    },
  };
  return { stream: stream as unknown as StreamProtocol, count: () => calls };
}

test("player waits for event state until stopped", async () => {
  const { stream, count } = fakeStream(["playing", "stopped"]);
  await new AirPlayPlayer({} as RtspSession, stream)._waitForMediaToEndFromEvents();
  expect(count()).toBe(2);
});

test("player fails when event state never starts", async () => {
  const { stream, count } = fakeStream(null);
  await expect(new AirPlayPlayer({} as RtspSession, stream)._waitForMediaToEndFromEvents()).rejects.toThrow(
    PlaybackError,
  );
  expect(count()).toBe(EVENT_WAIT_RETRIES);
});

const UNHANDLED_URL_EVENT = {
  kind: "request",
  type: "unhandledURL",
  request: { FCUP_Response_URL: "http://example.com/video.mp4", FCUP_Response_RequestID: 1 },
  messageID: "1",
};

test("airplay v2 reports unhandled url request as playback error", () => {
  const protocol = new AirPlayV2(new StreamContext(), {} as RtspSession);
  expect(protocol.playbackError).toBeNull();
  (protocol as any)._handleEvent(UNHANDLED_URL_EVENT);
  expect(protocol.playbackError).toContain("http://example.com/video.mp4");
  expect((protocol as any)._playbackStateChanged.isSet()).toBe(true);
});

test("player fails fast when device cannot load url", async () => {
  const protocol = new AirPlayV2(new StreamContext(), {} as RtspSession);
  (protocol as any)._handleEvent({ type: "playbackState", name: "loading" });
  (protocol as any)._handleEvent(UNHANDLED_URL_EVENT);

  await expect(new AirPlayPlayer({} as RtspSession, protocol)._waitForMediaToEndFromEvents()).rejects.toThrow(
    /could not load http:\/\/example.com\/video.mp4/,
  );
});
