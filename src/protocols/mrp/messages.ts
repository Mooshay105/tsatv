/** Helper code for dealing with protobuf messages. */

import { writeTlv } from "../../auth/hap_tlv8.ts";
import { RepeatState, ShuffleState } from "../../const.ts";
import type { InfoSettings } from "../../settings.ts";
import { uuid4 } from "../../support/uuid.ts";
import * as pb from "./protobuf/index.ts";

/** Create a ProtocolMessage. */
export function create(messageType: number, errorCode = 0, identifier: string | null = null): pb.ProtocolMessage {
  const message = new pb.ProtocolMessage();
  message.type = messageType;
  message.errorCode = errorCode;
  message.uniqueIdentifier = uuid4().toUpperCase();
  if (identifier) message.identifier = identifier;
  return message;
}

/** Create a new DEVICE_INFO_MESSAGE. */
export function deviceInformation(infoSettings: InfoSettings, identifier: string, update = false): pb.ProtocolMessage {
  const message = create(update ? pb.DEVICE_INFO_UPDATE_MESSAGE : pb.DEVICE_INFO_MESSAGE);
  const info = pb.extractInner(message) as pb.DeviceInfoMessage;
  info.allowsPairing = true;
  info.applicationBundleIdentifier = "com.apple.TVRemote";
  info.applicationBundleVersion = "344.28";
  info.lastSupportedMessageType = 108;
  info.localizedModelName = "iPhone";
  info.name = infoSettings.name;
  info.protocolVersion = 1;
  info.sharedQueueVersion = 2;
  info.supportsACL = true;
  info.supportsExtendedMotion = true;
  info.supportsSharedQueue = true;
  info.supportsSystemPairing = true;
  info.systemBuildVersion = infoSettings.os_build;
  info.systemMediaApplication = "com.apple.TVMusic";
  info.uniqueIdentifier = identifier;
  info.deviceClass = pb.DeviceClass.iPhone;
  info.logicalDeviceCount = 1;
  return message;
}

/** Create a new WAKE_DEVICE_MESSAGE. */
export function wakeDevice(): pb.ProtocolMessage {
  return create(pb.ProtocolMessage.WAKE_DEVICE_MESSAGE);
}

/** Create a new SET_CONNECTION_STATE. */
export function setConnectionState(): pb.ProtocolMessage {
  const message = create(pb.ProtocolMessage.SET_CONNECTION_STATE_MESSAGE);
  (pb.extractInner(message) as pb.SetConnectionStateMessage).state = pb.SetConnectionStateMessage.Connected;
  return message;
}

/** Create a new GET_KEYBOARD_SESSION_MESSAGE. */
export function getKeyboardSession(): pb.ProtocolMessage {
  return create(pb.ProtocolMessage.GET_KEYBOARD_SESSION_MESSAGE);
}

/** Create a new CRYPTO_PAIRING_MESSAGE. */
export function cryptoPairing(pairingData: Map<number, Uint8Array>, isPairing = false): pb.ProtocolMessage {
  const message = create(pb.CRYPTO_PAIRING_MESSAGE);
  const crypto = pb.extractInner(message) as pb.CryptoPairingMessage;
  crypto.status = 0;
  crypto.pairingData = writeTlv(pairingData);

  // Hardcoded values for now, might have to be changed
  crypto.isRetrying = false;
  crypto.isUsingSystemPairing = false;
  crypto.state = isPairing ? 2 : 0;
  return message;
}

/** Create a new CLIENT_UPDATES_CONFIG_MESSAGE. */
export function clientUpdatesConfig(
  options: { artwork?: boolean; nowPlaying?: boolean; volume?: boolean; keyboard?: boolean; outputDeviceUpdates?: boolean } = {},
): pb.ProtocolMessage {
  const message = create(pb.CLIENT_UPDATES_CONFIG_MESSAGE);
  const config = pb.extractInner(message) as pb.ClientUpdatesConfigMessage;
  config.artworkUpdates = options.artwork ?? true;
  config.nowPlayingUpdates = options.nowPlaying ?? false;
  config.volumeUpdates = options.volume ?? true;
  config.keyboardUpdates = options.keyboard ?? true;
  config.outputDeviceUpdates = options.outputDeviceUpdates ?? true;
  return message;
}

/** Create a new PLAYBACK_QUEUE_REQUEST. */
export function playbackQueueRequest(location: number, width = -1, height = 400): pb.ProtocolMessage {
  const message = create(pb.PLAYBACK_QUEUE_REQUEST_MESSAGE);
  const request = pb.extractInner(message) as pb.PlaybackQueueRequestMessage;
  request.location = location;
  request.length = 1;
  request.artworkWidth = width;
  request.artworkHeight = height;
  request.returnContentItemAssetsInUserCompletion = true;
  return message;
}

/** Create a new SEND_HID_EVENT_MESSAGE. */
export function sendHidEvent(usePage: number, usage: number, down: boolean): pb.ProtocolMessage {
  const message = create(pb.SEND_HID_EVENT_MESSAGE);
  const event = pb.extractInner(message) as pb.SendHIDEventMessage;

  // TODO: This should be generated somehow. I guess it's mach AbsoluteTime which is
  // tricky to generate. The device does not seem to care much about the value though,
  // so hardcode something here.
  const abstime = Buffer.from("438922cf08020000", "hex");

  const data = Buffer.alloc(6);
  data.writeUInt16BE(usePage, 0);
  data.writeUInt16BE(usage, 2);
  data.writeUInt16BE(down ? 1 : 0, 4);

  // This is the format that the device expects.
  event.hidEventData = Buffer.concat([
    abstime,
    Buffer.from("00000000000000000100000000000000020" + "00000200000000300000001000000000000", "hex"),
    data,
    Buffer.from("0000000000000001000000", "hex"),
  ]);
  return message;
}

/** Create a new SEND_BUTTON_EVENT_MESSAGE. */
export function sendButton(usagePage: number, usage: number, buttonDown: boolean): pb.ProtocolMessage {
  const message = create(pb.SEND_BUTTON_EVENT_MESSAGE);
  const inner = pb.extractInner(message) as pb.SendButtonEventMessage;
  inner.usagePage = usagePage;
  inner.usage = usage;
  inner.buttonDown = buttonDown;
  return message;
}

/** Playback command request. */
export function command(cmd: number, options: Record<string, unknown> = {}): pb.ProtocolMessage {
  const message = create(pb.SEND_COMMAND_MESSAGE);
  const sendCommand = pb.extractInner(message) as pb.SendCommandMessage;
  sendCommand.command = cmd;
  for (const [key, value] of Object.entries(options)) {
    (sendCommand.options as any)[key] = value;
  }
  return message;
}

/** Playback command result. */
export function commandResult(identifier: string, sendError: number = pb.SendError.NoError): pb.ProtocolMessage {
  const message = create(pb.SEND_COMMAND_RESULT_MESSAGE, 0, identifier);
  const inner = pb.extractInner(message) as pb.SendCommandResultMessage;
  inner.sendError = sendError;
  inner.handlerReturnStatus = pb.HandlerReturnStatus.Success;
  return message;
}

/** Change repeat mode of current player. */
export function repeat(mode: RepeatState): pb.ProtocolMessage {
  const message = command(pb.Command.ChangeRepeatMode);
  const options = (pb.extractInner(message) as pb.SendCommandMessage).options;
  options.sendOptions = 0;
  if (mode === RepeatState.Off) options.repeatMode = pb.RepeatMode.Off;
  else if (mode === RepeatState.Track) options.repeatMode = pb.RepeatMode.One;
  else options.repeatMode = pb.RepeatMode.All;
  return message;
}

/** Change shuffle mode of current player. */
export function shuffle(state: ShuffleState): pb.ProtocolMessage {
  const message = command(pb.Command.ChangeShuffleMode);
  const options = (pb.extractInner(message) as pb.SendCommandMessage).options;
  options.sendOptions = 0;
  if (state === ShuffleState.Off) options.shuffleMode = pb.ShuffleMode.Off;
  else if (state === ShuffleState.Albums) options.shuffleMode = pb.ShuffleMode.Albums;
  else options.shuffleMode = pb.ShuffleMode.Songs;
  return message;
}

/** Seek to an absolute position in stream. */
export function seekToPosition(position: number): pb.ProtocolMessage {
  const message = command(pb.Command.SeekToPlaybackPosition);
  (pb.extractInner(message) as pb.SendCommandMessage).options.playbackPosition = position;
  return message;
}

/** Change volume on a device. */
export function setVolume(deviceUid: string, volume: number): pb.ProtocolMessage {
  const message = create(pb.SET_VOLUME_MESSAGE);
  const inner = pb.extractInner(message) as pb.SetVolumeMessage;
  inner.outputDeviceUID = deviceUid;
  inner.volume = volume;
  return message;
}

function modifyOutputContext(field: "adding" | "removing" | "setting", deviceUids: string[]): pb.ProtocolMessage {
  const message = create(pb.MODIFY_OUTPUT_CONTEXT_REQUEST_MESSAGE);
  const inner = pb.extractInner(message) as pb.ModifyOutputContextRequestMessage;
  inner.type = pb.ModifyOutputContextRequestType.SharedAudioPresentation;
  const cap = field.charAt(0).toUpperCase() + field.slice(1);
  for (const uid of deviceUids) {
    (inner as any)[`${field}Devices`].append(uid);
    (inner as any)[`clusterAware${cap}Devices`].append(uid);
  }
  return message;
}

/** Add AirPlay devices to the speaker group. */
export function addOutputDevices(...deviceUids: string[]): pb.ProtocolMessage {
  return modifyOutputContext("adding", deviceUids);
}

/** Remove AirPlay devices from the speaker group. */
export function removeOutputDevices(...deviceUids: string[]): pb.ProtocolMessage {
  return modifyOutputContext("removing", deviceUids);
}

/** Set AirPlay devices as the speaker group. */
export function setOutputDevices(...deviceUids: string[]): pb.ProtocolMessage {
  return modifyOutputContext("setting", deviceUids);
}
