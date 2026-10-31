/** Unit tests for interface implementations in pyatv.protocols.mrp. */

import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Protocol } from "../../../src/const.ts";
import { CoreStateDispatcher, ProtocolStateDispatcher, type StateMessage, UpdatedState } from "../../../src/core/index.ts";
import { ProtocolError } from "../../../src/exceptions.ts";
import { OutputDevice } from "../../../src/interface.ts";
import { MrpAudio, MrpMetadata, mrpHooks } from "../../../src/protocols/mrp/index.ts";
import * as messages from "../../../src/protocols/mrp/messages.ts";
import * as pb from "../../../src/protocols/mrp/protobuf/index.ts";
import { InfoSettings } from "../../../src/settings.ts";
import { ClientSession } from "../../../src/support/http.ts";
import { MrpProtocolMock } from "./protocol_mock.ts";

const DEVICE_NAME = "Apple TV";
const DEVICE_UID = "F2204E63-BCAB-4941-80A0-06C46CB71391";
const HOMEPOD = () => new OutputDevice("FFFFFFFF-GGGG-HHHH-IIII-JJJJJJJJJJJJ", "HomePod");
const ATV = () => new OutputDevice(DEVICE_UID, DEVICE_NAME);
const UIDS = ["AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "FF:GG:HH:II:JJ:KK"];

let protocolMock: MrpProtocolMock;
let dispatcher: ProtocolStateDispatcher;
let audio: MrpAudio;

beforeEach(() => {
  protocolMock = new MrpProtocolMock();
  dispatcher = new ProtocolStateDispatcher(Protocol.MRP, new CoreStateDispatcher());
  const info = new InfoSettings();
  info.name = "test";
  const deviceInfo = messages.deviceInformation(info, "id");
  (pb.extractInner(deviceInfo) as pb.DeviceInfoMessage).deviceUID = DEVICE_UID;
  protocolMock.deviceInfo = deviceInfo;
  audio = new MrpAudio(protocolMock as any, dispatcher);
});

async function volumeControlsChanged(deviceUid: string, available: boolean) {
  const message = messages.create(pb.VOLUME_CONTROL_CAPABILITIES_DID_CHANGE_MESSAGE);
  const inner = pb.extractInner(message) as pb.VolumeControlCapabilitiesDidChangeMessage;
  inner.outputDeviceUID = deviceUid;
  inner.capabilities.volumeControlAvailable = available;
  await protocolMock.inject(message);
}

async function groupedDevicesChanged(isLeader: boolean, isProxy: boolean, devices: OutputDevice[]) {
  const message = messages.create(pb.DEVICE_INFO_UPDATE_MESSAGE);
  const inner = pb.extractInner(message) as pb.DeviceInfoMessage;
  inner.name = DEVICE_NAME;
  inner.uniqueIdentifier = DEVICE_UID;
  inner.isGroupLeader = isLeader;
  inner.isProxyGroupPlayer = isProxy;
  for (const device of devices) {
    inner.groupedDevices.append(new pb.DeviceInfoMessage({ name: device.name!, deviceUID: device.identifier }));
  }
  await protocolMock.inject(message);
}

test("audio volume control availability", async () => {
  expect(audio.isAvailable).toBe(false);
  await volumeControlsChanged(DEVICE_UID, true);
  expect(audio.isAvailable).toBe(true);
  await volumeControlsChanged(DEVICE_UID, false);
  expect(audio.isAvailable).toBe(false);
});

test.each([
  ["foo", true, false],
  [DEVICE_UID, true, true],
])("audio volume control capabilities changed %s", async (uid, available, expected) => {
  expect(audio.isAvailable).toBe(false);
  await volumeControlsChanged(uid, available);
  expect(audio.isAvailable).toBe(expected);
});

async function volumeDidChange(uid: string, volume: number) {
  const message = messages.create(pb.VOLUME_DID_CHANGE_MESSAGE);
  const inner = pb.extractInner(message) as pb.VolumeDidChangeMessage;
  inner.outputDeviceUID = uid;
  inner.volume = volume;
  await protocolMock.inject(message);
}

test.each([
  ["foo", 0.2, 0.0],
  [DEVICE_UID, 0.2, 20.0],
])("audio volume did change %s", async (uid, volume, expected) => {
  await volumeControlsChanged(DEVICE_UID, true);
  expect(audio.volume).toBeCloseTo(0.0);
  await volumeDidChange(uid, volume);
  expect(audio.volume).toBeCloseTo(expected);
});

test.each([
  ["foo", 0.2, false, null],
  [DEVICE_UID, 0.2, true, 20.0],
])("audio volume did change dispatches %s", async (uid, volume, expectCalled, expectedVolume) => {
  await volumeControlsChanged(DEVICE_UID, true);
  const callback = mock((_m: StateMessage) => undefined);
  dispatcher.listenTo(UpdatedState.Volume, callback);
  await volumeDidChange(uid, volume);
  await new Promise((r) => setImmediate(r));
  expect(callback.mock.calls.length > 0).toBe(expectCalled);
  if (expectedVolume !== null) expect(callback.mock.calls[0]![0].value).toBeCloseTo(expectedVolume);
});

test("audio set volume", async () => {
  await volumeControlsChanged(DEVICE_UID, true);
  await audio.setVolume(0.0);
  expect(protocolMock.sentMessages.length).toBe(1);
  const message = protocolMock.sentMessages.pop()!;
  expect(message.type).toBe(pb.SET_VOLUME_MESSAGE);
  const inner = pb.extractInner(message) as pb.SetVolumeMessage;
  expect(inner.outputDeviceUID).toBe(DEVICE_UID);
  expect(inner.volume).toBeCloseTo(0.0);
});

test("audio set volume no output device", async () => {
  protocolMock.deviceInfo = null;
  await expect(audio.setVolume(10)).rejects.toBeInstanceOf(ProtocolError);
});

const OUTPUT_CASES: Array<[boolean, boolean, () => OutputDevice[], () => OutputDevice[]]> = [
  [true, false, () => [], () => [ATV()]],
  [true, false, () => [HOMEPOD()], () => [ATV(), HOMEPOD()]],
  [true, true, () => [HOMEPOD()], () => [HOMEPOD()]],
  [false, false, () => [], () => []],
];

test.each(OUTPUT_CASES)("audio update output devices %p %p", async (leader, proxy, grouped, expected) => {
  await groupedDevicesChanged(leader, proxy, grouped());
  expect(audio.outputDevices).toEqual(expected());
});

test.each(OUTPUT_CASES)("audio update output devices dispatches %p %p", async (leader, proxy, grouped, expected) => {
  const callback = mock((_m: StateMessage) => undefined);
  dispatcher.listenTo(UpdatedState.OutputDevices, callback);
  await groupedDevicesChanged(leader, proxy, grouped());
  await new Promise((r) => setImmediate(r));
  expect(callback).toHaveBeenCalled();
  expect(callback.mock.calls[0]![0].value).toEqual(expected());
});

test.each([
  ["addOutputDevices", "adding"],
  ["removeOutputDevices", "removing"],
  ["setOutputDevices", "setting"],
] as const)("audio %s", async (method, field) => {
  (audio as any)._outputDevicesEvent.set();
  await audio[method](...UIDS);
  expect(protocolMock.sentMessages.length).toBe(1);
  const message = protocolMock.sentMessages.pop()!;
  expect(message.type).toBe(pb.MODIFY_OUTPUT_CONTEXT_REQUEST_MESSAGE);
  const inner = pb.extractInner(message) as any;
  for (const f of ["adding", "removing", "setting"]) {
    const cap = f[0]!.toUpperCase() + f.slice(1);
    const expected = f === field ? UIDS : [];
    expect([...inner[`${f}Devices`]]).toEqual(expected);
    expect([...inner[`clusterAware${cap}Devices`]]).toEqual(expected);
  }
});

// MrpMetadata

const ELAPSED_TIME = 2;
const ELAPSED_TIME_TIMESTAMP = 1;
const NOW_TIME = 10;

test("metadata position calculation", async () => {
  const playingMetadata: Record<string, number> = {
    elapsedTimeTimestamp: ELAPSED_TIME_TIMESTAMP - 978307200,
    elapsedTime: ELAPSED_TIME,
    playbackRate: 0.0,
  };
  const playerState: any = {
    playbackState: pb.PlaybackState.Paused,
    metadata: null,
    itemIdentifier: null,
    metadataField: (field: string) => playingMetadata[field] ?? null,
    commandInfo: () => null,
  };
  const psm: any = { playing: playerState };
  const metadata = new MrpMetadata(protocolMock as any, psm, "test", new ClientSession());
  const spy = spyOn(mrpHooks, "now").mockImplementation(() => NOW_TIME);
  try {
    // Paused state => ELAPSED_TIME
    expect((await metadata.playing()).position).toBe(ELAPSED_TIME);

    // Playing state => ELAPSED_TIME + time diff since "elapsedTimeTimestamp"
    playerState.playbackState = pb.PlaybackState.Playing;
    playingMetadata.playbackRate = 1.0;
    expect((await metadata.playing()).position).toBe(ELAPSED_TIME + (NOW_TIME - ELAPSED_TIME_TIMESTAMP));

    // Playing state but 0.0 playback rate => same as paused
    playingMetadata.playbackRate = 0.0;
    expect((await metadata.playing()).position).toBe(ELAPSED_TIME);
  } finally {
    spy.mockRestore();
  }
});
