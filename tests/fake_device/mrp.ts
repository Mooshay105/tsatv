/** Fake MRP Apple TV for tests. */

import { InputAction, Protocol, RepeatState, ShuffleState } from "../../src/const.ts";
import * as messages from "../../src/protocols/mrp/messages.ts";
import * as pb from "../../src/protocols/mrp/protobuf/index.ts";
import { MrpServerAuth } from "../../src/protocols/mrp/server_auth.ts";
import { InfoSettings } from "../../src/settings.ts";
import * as chacha20 from "../../src/support/chacha20.ts";
import { logProtobuf } from "../../src/support/index.ts";
import { getLogger } from "../../src/support/logging.ts";
import { createServer, type Server, type Transport } from "../../src/support/transport.ts";
import { writeVariant } from "../../src/support/variant.ts";
import { stubSleep } from "../utils.ts";
import { registerFake } from "./index.ts";
import type { WebApp } from "./web.ts";

const LOGGER = getLogger("tests.fake_device.mrp");

const KEY_LOOKUP: Record<string, string> = {
  // "use_page,usage": button
  "1,140": "up",
  "1,141": "down",
  "1,139": "left",
  "1,138": "right",
  "12,183": "stop",
  "12,181": "next",
  "12,182": "previous",
  "1,137": "select",
  "1,134": "menu",
  "12,96": "top_menu",
  "12,64": "home",
  "1,130": "suspend",
  "1,131": "wakeup",
  "12,233": "volumeup",
  "12,234": "volumedown",
};

const COMMAND_LOOKUP = new Map<number, string>([
  [pb.Command.Play, "play"],
  [pb.Command.TogglePlayPause, "playpause"],
  [pb.Command.Pause, "pause"],
  [pb.Command.Stop, "stop"],
  [pb.Command.NextTrack, "nextitem"],
  [pb.Command.PreviousTrack, "previtem"],
]);

const REPEAT_LOOKUP = new Map<RepeatState, number>([
  [RepeatState.Off, pb.RepeatMode.Off],
  [RepeatState.Track, pb.RepeatMode.One],
  [RepeatState.All, pb.RepeatMode.All],
]);

const SHUFFLE_LOOKUP = new Map<ShuffleState, number>([
  [ShuffleState.Off, pb.ShuffleMode.Off],
  [ShuffleState.Albums, pb.ShuffleMode.Albums],
  [ShuffleState.Songs, pb.ShuffleMode.Songs],
]);

const COCOA_BASE = -978307200;

export const APP_NAME = "Test app";
export const DEVICE_NAME = "Fake MRP ATV";
export const PLAYER_IDENTIFIER = "com.github.postlund.pyatv";

export const DEFAULT_PLAYER_ID = "MediaRemote-DefaultPlayer";
export const DEFAULT_PLAYER_NAME = "Default Player";

export const BUILD_NUMBER = "18M60";
export const OS_VERSION = "14.7"; // Must match BUILD_NUMBER (take from device_info.ts)
export const DEVICE_MODEL = "AppleTV6,2";

export const DEVICE_UID = "E510C430-B01D-45DF-B558-6EA6F8251069";

export const VOLUME_STEP = 0.05;

/** State of what is playing in a player. */
export class PlayingState {
  identifier?: string | null;
  playbackState?: number | null;
  title?: string | null;
  seriesName?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  totalTime?: number | null;
  position?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  repeat?: RepeatState | null;
  shuffle?: ShuffleState | null;
  mediaType?: number | null;
  playbackRate?: number | null;
  supportedCommands?: number[] | null;
  artwork?: Buffer | null;
  artworkIdentifier?: string | null;
  artworkMimetype?: string | null;
  artworkWidth?: number | null;
  artworkHeight?: number | null;
  artworkUrl?: string | null;
  skipTime?: number | null;
  appName?: string | null;
  contentIdentifier?: string | null;
  itunesStoreIdentifier?: number | null;

  constructor(init: Partial<PlayingState> = {}) {
    Object.assign(this, init);
  }
}

function fillItem(item: pb.ContentItem, metadata: PlayingState): void {
  if (metadata.identifier) item.identifier = metadata.identifier;

  const md = item.metadata;
  md.elapsedTimeTimestamp = COCOA_BASE;
  if (metadata.artist) md.trackArtistName = metadata.artist;
  if (metadata.album) md.albumName = metadata.album;
  if (metadata.title) md.title = metadata.title;
  if (metadata.genre) md.genre = metadata.genre;
  if (metadata.totalTime !== null && metadata.totalTime !== undefined) md.duration = metadata.totalTime;
  if (metadata.position !== null && metadata.position !== undefined) md.elapsedTime = metadata.position;
  if (metadata.playbackRate !== null && metadata.playbackRate !== undefined) md.playbackRate = metadata.playbackRate;
  if (metadata.mediaType) md.mediaType = metadata.mediaType;
  if (metadata.artworkMimetype) {
    md.artworkAvailable = true;
    md.artworkMIMEType = metadata.artworkMimetype;
  }
  if (metadata.artworkUrl !== undefined && metadata.artworkUrl !== null) md.artworkURL = metadata.artworkUrl;
  if (metadata.artworkIdentifier) md.artworkIdentifier = metadata.artworkIdentifier;
  if (metadata.seriesName) md.seriesName = metadata.seriesName;
  if (metadata.seasonNumber) md.seasonNumber = metadata.seasonNumber;
  if (metadata.episodeNumber) md.episodeNumber = metadata.episodeNumber;
  if (metadata.contentIdentifier) md.contentIdentifier = metadata.contentIdentifier;
  if (metadata.itunesStoreIdentifier) md.iTunesStoreIdentifier = metadata.itunesStoreIdentifier;
}

function setStateMessage(metadata: PlayingState, identifier: string): pb.ProtocolMessage {
  // Most things are hardcoded here for simplicity.
  const setState = messages.create(pb.SET_STATE_MESSAGE);
  const inner = pb.extractInner(setState) as pb.SetStateMessage;
  if (metadata.playbackState !== null && metadata.playbackState !== undefined) {
    inner.playbackState = metadata.playbackState;
  }
  inner.displayName = "Fake Player";

  if (metadata.supportedCommands) {
    for (const command of metadata.supportedCommands) {
      const item = inner.supportedCommands.supportedCommands.add();
      item.command = command;
      item.enabled = true;
      if ([pb.Command.SkipForward, pb.Command.SkipBackward].includes(command as 18 | 19)) {
        if (metadata.skipTime !== null && metadata.skipTime !== undefined) {
          item.preferredIntervals.append(metadata.skipTime);
        }
      }
    }
  }

  if (metadata.repeat) {
    const cmd = inner.supportedCommands.supportedCommands.add();
    cmd.command = pb.Command.ChangeRepeatMode;
    cmd.repeatMode = REPEAT_LOOKUP.get(metadata.repeat)!;
  }

  if (metadata.shuffle) {
    const cmd = inner.supportedCommands.supportedCommands.add();
    cmd.command = pb.Command.ChangeShuffleMode;
    cmd.shuffleMode = SHUFFLE_LOOKUP.get(metadata.shuffle)!;
  }

  const queue = inner.playbackQueue;
  queue.location = 0;
  fillItem(queue.contentItems.add(), metadata);

  const client = inner.playerPath.client;
  client.processIdentifier = 123;
  client.bundleIdentifier = identifier;
  if (metadata.appName) client.displayName = metadata.appName;

  const player = inner.playerPath.player;
  player.identifier = DEFAULT_PLAYER_ID;
  player.displayName = DEFAULT_PLAYER_NAME;
  return setState;
}

export class FakeMrpState {
  clients: FakeMrpService[] = [];
  outstandingKeypresses = new Map<string, number>();
  lastButtonPressed: string | null = null;
  lastButtonAction: InputAction | null = null;
  connectionState: number | null = null;
  states = new Map<string, PlayingState>();
  activePlayer: string | null = null;
  poweredOn = true;
  hasAuthenticated = false;
  heartbeatCount = 0;
  volume = 0.5;
  clusterId: string | null = null;
  outputDevices: string[] = [DEVICE_UID];

  private _send(msg: pb.ProtocolMessage): void {
    for (const client of this.clients) client.sendToClient(msg);
  }

  private _sendDeviceInfo(): void {
    for (const client of this.clients) client.sendDeviceInfo(null, true);
  }

  // This is a hack for now (if anyone has paired, OK...)
  get hasPaired(): boolean {
    return this.clients.some((client) => client.hasPaired);
  }

  updateState(identifier: string): void {
    this._send(setStateMessage(this.states.get(identifier)!, identifier));
  }

  setPlayerState(identifier: string, state: PlayingState): void {
    this.states.set(identifier, state);
    this.updateState(identifier);
  }

  getPlayerState(identifier: string | null): PlayingState | undefined {
    return identifier === null ? undefined : this.states.get(identifier);
  }

  setActivePlayer(identifier: string | null): void {
    if (identifier !== null && !this.states.has(identifier)) {
      throw new Error(`invalid player: ${identifier}`);
    }
    this.activePlayer = identifier;
    const nowPlaying = messages.create(pb.SET_NOW_PLAYING_CLIENT_MESSAGE);
    const client = (pb.extractInner(nowPlaying) as pb.SetNowPlayingClientMessage).client;
    if (identifier) client.bundleIdentifier = identifier;
    this._send(nowPlaying);
  }

  itemUpdate(metadata: PlayingState, identifier: string): void {
    const msg = messages.create(pb.UPDATE_CONTENT_ITEM_MESSAGE);
    const inner = pb.extractInner(msg) as pb.UpdateContentItemMessage;

    fillItem(inner.contentItems.add(), metadata);

    const client = inner.playerPath.client;
    client.processIdentifier = 123;
    client.bundleIdentifier = identifier;

    const player = inner.playerPath.player;
    player.identifier = DEFAULT_PLAYER_ID;
    player.displayName = DEFAULT_PLAYER_NAME;

    const state = this.getPlayerState(identifier)!;
    for (const [key, value] of Object.entries(metadata)) {
      if (value) (state as any)[key] = value;
    }
    this._send(msg);
  }

  updateClient(displayName: string | null, identifier: string): void {
    const msg = messages.create(pb.UPDATE_CLIENT_MESSAGE);
    const client = (pb.extractInner(msg) as pb.UpdateClientMessage).client;
    client.bundleIdentifier = identifier;
    if (displayName !== null) client.displayName = displayName;
    this._send(msg);
  }

  setClusterId(clusterId: string | null): void {
    this.clusterId = clusterId;
    this._sendDeviceInfo();
  }

  volumeControl(available: boolean, supportAbsolute = true, supportRelative = true): void {
    let capabilities: number | null;
    if (supportAbsolute && supportRelative) capabilities = pb.VolumeCapabilities.Both;
    else if (supportAbsolute) capabilities = pb.VolumeCapabilities.Absolute;
    else if (supportRelative) capabilities = pb.VolumeCapabilities.Relative;
    else capabilities = null;

    let msg = messages.create(pb.VOLUME_CONTROL_AVAILABILITY_MESSAGE);
    const availability = pb.extractInner(msg) as pb.VolumeControlAvailabilityMessage;
    availability.volumeControlAvailable = available;
    if (capabilities !== null) availability.volumeCapabilities = capabilities;
    this._send(msg);

    msg = messages.create(pb.VOLUME_CONTROL_CAPABILITIES_DID_CHANGE_MESSAGE);
    const inner = pb.extractInner(msg) as pb.VolumeControlCapabilitiesDidChangeMessage;
    inner.capabilities.volumeControlAvailable = available;
    if (capabilities !== null) inner.capabilities.volumeCapabilities = capabilities;
    inner.outputDeviceUID = DEVICE_UID;
    this._send(msg);
  }

  defaultSupportedCommands(commands: number[]): void {
    const msg = messages.create(pb.SET_DEFAULT_SUPPORTED_COMMANDS_MESSAGE);
    const inner = pb.extractInner(msg) as pb.SetDefaultSupportedCommandsMessage;
    for (const command of commands) {
      const item = inner.supportedCommands.supportedCommands.add();
      item.command = command;
      item.enabled = true;
    }
    inner.playerPath.client.bundleIdentifier = PLAYER_IDENTIFIER;
    this._send(msg);
  }

  setVolume(volume: number, deviceUid: string): void {
    if (volume >= 0 && volume <= 1) {
      this.volume = volume;
      const msg = messages.create(pb.VOLUME_DID_CHANGE_MESSAGE);
      const inner = pb.extractInner(msg) as pb.VolumeDidChangeMessage;
      inner.outputDeviceUID = deviceUid;
      inner.volume = volume;
      this._send(msg);
    } else {
      LOGGER.debug("Value %f out of range", volume);
    }
  }

  addOutputDevices(devices: string[]): void {
    for (const device of devices) if (!this.outputDevices.includes(device)) this.outputDevices.push(device);
    this._sendDeviceInfo();
  }

  removeOutputDevices(devices: string[]): void {
    for (const device of devices) {
      const idx = this.outputDevices.indexOf(device);
      if (idx >= 0) this.outputDevices.splice(idx, 1);
    }
    this._sendDeviceInfo();
  }

  setOutputDevices(devices: string[]): void {
    this.outputDevices.splice(0, this.outputDevices.length, ...devices);
    this._sendDeviceInfo();
  }
}

export class FakeMrpServiceFactory {
  server: Server | null = null;

  constructor(
    readonly state: FakeMrpState,
    readonly app: WebApp,
  ) {}

  async start(_startWebServer: boolean): Promise<void> {
    this.server = await createServer(() => new FakeMrpService(this.state), "0.0.0.0", 0);
    LOGGER.info("Started MRP server at port %d", this.port);
  }

  async cleanup(): Promise<void> {
    this.server?.close();
  }

  get port(): number {
    return this.server!.port;
  }
}

/** Convert a message type to a handler name, e.g. SEND_HID_EVENT_MESSAGE -> handleSendHidEvent. */
function handlerName(type: number): string | null {
  const name = pb.enumName(pb.ProtocolMessage.Type, type);
  if (!name) return null;
  const parts = name.toLowerCase().replace(/_message$/, "").split("_");
  return "handle" + parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

/** Implementation of a fake MRP Apple TV. */
export class FakeMrpService extends MrpServerAuth {
  private buffer: Buffer = Buffer.alloc(0);
  private chacha: chacha20.Chacha20Cipher8byteNonce | null = null;
  transport: Transport | null = null;

  constructor(readonly state: FakeMrpState) {
    super(DEVICE_NAME);
    this.state.clients.push(this);
  }

  connectionMade(transport: Transport): void {
    LOGGER.debug("Client connected");
    this.transport = transport;
  }

  connectionLost(_exc: Error | null): void {
    LOGGER.debug("Client disconnected");
    this.transport = null;
    const idx = this.state.clients.indexOf(this);
    if (idx >= 0) this.state.clients.splice(idx, 1);
  }

  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this.chacha = new chacha20.Chacha20Cipher8byteNonce(outputKey, inputKey);
    this.state.hasAuthenticated = true;
  }

  sendToClient(message: pb.ProtocolMessage): void {
    if (!this.transport) return;
    let data = message.serializeToString();
    if (this.chacha) data = this.chacha.encrypt(data);
    this.transport.write(Buffer.concat([writeVariant(data.length), data]));
    logProtobuf(LOGGER, ">> Send: Protobuf", message);
  }

  sendDeviceInfo(identifier: string | null = null, update = false): void {
    const info = new InfoSettings();
    info.name = DEVICE_NAME;
    info.os_build = BUILD_NUMBER;
    const resp = messages.deviceInformation(info, DEVICE_UID, update);
    if (identifier) resp.identifier = identifier;
    const inner = pb.extractInner(resp) as pb.DeviceInfoMessage;
    inner.logicalDeviceCount = this.state.poweredOn ? 1 : 0;
    inner.deviceUID = DEVICE_UID;
    inner.modelID = DEVICE_MODEL;
    if (this.state.clusterId) inner.clusterID = this.state.clusterId;
    inner.isGroupLeader = this.state.outputDevices.length > 0;
    inner.isProxyGroupPlayer = this.state.outputDevices.length > 0 && !this.state.outputDevices.includes(DEVICE_UID);
    for (const device of this.state.outputDevices) {
      if (device === DEVICE_UID) continue;
      inner.groupedDevices.append(new pb.DeviceInfoMessage({ name: `Device ${device.slice(0, 2)}`, deviceUID: device }));
    }
    this.sendToClient(resp);
  }

  dataReceived(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length > 0) {
      let length = 0;
      let headerLength = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        length += (this.buffer[i]! & 0x7f) * 2 ** (7 * i);
        if (!(this.buffer[i]! & 0x80)) {
          headerLength = i + 1;
          break;
        }
      }
      if (headerLength === 0 || this.buffer.length - headerLength < length) return;

      let message: Buffer = Buffer.from(this.buffer.subarray(headerLength, headerLength + length));
      this.buffer = this.buffer.subarray(headerLength + length);
      if (this.chacha) message = this.chacha.decrypt(message);

      const parsed = pb.ProtocolMessage.decode(message);
      logProtobuf(LOGGER, "<< Receive: Protobuf", parsed);

      const name = handlerName(parsed.type);
      const handler = name ? (this as any)[name] : undefined;
      if (typeof handler !== "function") {
        LOGGER.error("No message handler for %s", parsed);
        continue;
      }
      try {
        LOGGER.debug("Received %s message", name);
        handler.call(this, parsed, pb.extractInner(parsed));
      } catch (ex) {
        LOGGER.error("Error while dispatching message: %s", ex);
      }
    }
  }

  override handleDeviceInfo(message: pb.ProtocolMessage, _inner: unknown): void {
    this.sendDeviceInfo(message.identifier, false);
  }

  handleSetConnectionState(_message: pb.ProtocolMessage, inner: pb.SetConnectionStateMessage): void {
    LOGGER.debug("Changed connection state to %d", inner.state);
    this.state.connectionState = inner.state;
  }

  handleClientUpdatesConfig(message: pb.ProtocolMessage, _inner: unknown): void {
    for (const [identifier, metadata] of this.state.states) {
      this.sendToClient(setStateMessage(metadata, identifier));
    }

    // Trigger sending of SetNowPlayingClientMessage
    if (this.state.activePlayer) this.state.setActivePlayer(this.state.activePlayer);

    this.sendToClient(messages.create(0, 0, message.identifier));
  }

  handleGetKeyboardSession(message: pb.ProtocolMessage, _inner: unknown): void {
    // This message has a lot more fields, but pyatv currently not use them
    this.sendToClient(messages.create(pb.KEYBOARD_MESSAGE, 0, message.identifier));
  }

  handleSendHidEvent(message: pb.ProtocolMessage, inner: pb.SendHIDEventMessage): void {
    const outstanding = this.state.outstandingKeypresses;

    // These corresponds to the bytes mapping to pressed key (see sendHidEvent in
    // src/protocols/mrp/messages.ts)
    const start = inner.hidEventData.subarray(43, 49);
    const usePage = start.readUInt16BE(0);
    const usage = start.readUInt16BE(2);
    const downPress = start.readUInt16BE(4);
    const key = `${usePage},${usage}`;

    if (downPress === 1) {
      outstanding.set(key, stubSleep());
      this.sendToClient(messages.create(0, 0, message.identifier));
    } else if (downPress === 0) {
      if (outstanding.has(key)) {
        const pressedKey = KEY_LOOKUP[key];
        if (!pressedKey) throw new Error(`unsupported key: use_page=${usePage}, usage=${usage}`);
        if (pressedKey === "select" && this.state.lastButtonPressed === "home") {
          this.state.poweredOn = false;
          this.sendDeviceInfo(null, true);
        }

        const timeDiff = stubSleep() - outstanding.get(key)!;
        if (timeDiff > 0.5) {
          this.state.lastButtonAction = InputAction.Hold;
        } else if (this.state.lastButtonPressed === pressedKey) {
          // NB: Will report double tap for >= 3 clicks (fix when needed)
          this.state.lastButtonAction = InputAction.DoubleTap;
        } else {
          this.state.lastButtonAction = InputAction.SingleTap;
        }

        this.state.lastButtonPressed = pressedKey;
        outstanding.delete(key);
        LOGGER.debug("Pressed button: %s", this.state.lastButtonPressed);
        this.sendToClient(messages.create(0, 0, message.identifier));

        // Special cases for some buttons
        if (pressedKey === "volumeup" && this.state.volume !== 100.0) {
          this.state.setVolume(Math.min(this.state.volume + VOLUME_STEP, 100.0), DEVICE_UID);
        } else if (pressedKey === "volumedown" && this.state.volume !== 0.0) {
          this.state.setVolume(Math.max(this.state.volume - VOLUME_STEP, 0.0), DEVICE_UID);
        }
      } else {
        LOGGER.error("Missing key down for %d,%d", usePage, usage);
      }
    } else {
      LOGGER.error("Invalid key press state: %d", downPress);
    }
  }

  handleSendCommand(message: pb.ProtocolMessage, inner: pb.SendCommandMessage): void {
    const state = this.state.getPlayerState(this.state.activePlayer)!;
    const button = COMMAND_LOOKUP.get(inner.command);
    if (button) {
      this.state.lastButtonPressed = button;
      LOGGER.debug("Pressed button: %s", this.state.lastButtonPressed);
    } else if (inner.command === pb.Command.ChangeRepeatMode) {
      state.repeat =
        new Map<number, RepeatState>([
          [pb.RepeatMode.Off, RepeatState.Off],
          [pb.RepeatMode.One, RepeatState.Track],
          [pb.RepeatMode.All, RepeatState.All],
        ]).get(inner.options.repeatMode) ?? RepeatState.Off;
      this.state.updateState(this.state.activePlayer!);
      LOGGER.debug("Change repeat state to %s", state.repeat);
    } else if (inner.command === pb.Command.ChangeShuffleMode) {
      state.shuffle =
        new Map<number, ShuffleState>([
          [pb.ShuffleMode.Off, ShuffleState.Off],
          [pb.ShuffleMode.Albums, ShuffleState.Albums],
          [pb.ShuffleMode.Songs, ShuffleState.Songs],
        ]).get(inner.options.shuffleMode) ?? ShuffleState.Off;
      this.state.updateState(this.state.activePlayer!);
      LOGGER.debug("Change shuffle state to %s", state.shuffle);
    } else if (inner.command === pb.Command.SeekToPlaybackPosition) {
      state.position = inner.options.playbackPosition;
      this.state.updateState(this.state.activePlayer!);
      LOGGER.debug("Seek to position: %d", state.position);
    } else if (inner.command === pb.Command.SkipForward) {
      state.position = (state.position ?? 0) + Math.trunc(inner.options.skipInterval);
      this.state.updateState(this.state.activePlayer!);
      LOGGER.debug("Skip forward %ds", inner.options.skipInterval);
    } else if (inner.command === pb.Command.SkipBackward) {
      state.position = (state.position ?? 0) - Math.trunc(inner.options.skipInterval);
      this.state.updateState(this.state.activePlayer!);
      LOGGER.debug("Skip backwards %d", inner.options.skipInterval);
    } else {
      LOGGER.warning("Unhandled button press: %s", inner.command);
      this.sendToClient(messages.commandResult(message.identifier, pb.SendError.NoCommandHandlers));
      return;
    }

    this.state.lastButtonAction = null;
    this.sendToClient(messages.commandResult(message.identifier));
  }

  handlePlaybackQueueRequest(message: pb.ProtocolMessage, _inner: unknown): void {
    const state = this.state.getPlayerState(this.state.activePlayer)!;
    const setstate = messages.create(pb.SET_STATE_MESSAGE, 0, message.identifier);

    const artworkData = state.artwork;
    if (artworkData) {
      const queue = (pb.extractInner(setstate) as pb.SetStateMessage).playbackQueue;
      queue.location = 0;
      const item = queue.contentItems.add();
      item.artworkData = artworkData;
      item.artworkDataWidth = state.artworkWidth || 456;
      item.artworkDataHeight = state.artworkHeight || 789;
    }
    this.sendToClient(setstate);
  }

  handleWakeDevice(message: pb.ProtocolMessage, _inner: unknown): void {
    this.sendToClient(messages.commandResult(message.identifier));
    this.state.poweredOn = true;
    this.sendDeviceInfo(null, true);
  }

  handleGeneric(message: pb.ProtocolMessage, _inner: unknown): void {
    // Generic message is used by pyatv for heartbeats
    this.state.heartbeatCount += 1;
    LOGGER.debug("Received heartbeat (total count: %d)", this.state.heartbeatCount);
    this.sendToClient(messages.create(pb.ProtocolMessage.UNKNOWN_MESSAGE, 0, message.identifier));
  }

  handleSetVolume(message: pb.ProtocolMessage, inner: pb.SetVolumeMessage): void {
    LOGGER.debug("Setting volume to %f", inner.volume);
    this.state.setVolume(inner.volume, inner.outputDeviceUID);
    this.sendToClient(messages.create(pb.ProtocolMessage.UNKNOWN_MESSAGE, 0, message.identifier));
  }

  handleModifyOutputContextRequest(_message: pb.ProtocolMessage, inner: pb.ModifyOutputContextRequestMessage): void {
    if (inner.addingDevices.length > 0) this.state.addOutputDevices([...inner.addingDevices]);
    if (inner.removingDevices.length > 0) this.state.removeOutputDevices([...inner.removingDevices]);
    if (inner.settingDevices.length > 0) this.state.setOutputDevices([...inner.settingDevices]);
  }
}

/** Wrapper for altering behavior of a FakeMrpAppleTV instance. */
export class FakeMrpUseCases {
  constructor(readonly state: FakeMrpState) {}

  setClusterId(clusterId: string | null): void {
    this.state.setClusterId(clusterId);
  }

  /** Change volume control availability. */
  changeVolumeControl(available: boolean, supportAbsolute = true, supportRelative = true): void {
    this.state.volumeControl(available, supportAbsolute, supportRelative);
    // Device always sends current volume if controls are available
    if (available) this.state.setVolume(this.state.volume, DEVICE_UID);
  }

  /** Change artwork response. */
  changeArtwork(
    artwork: Buffer | null,
    mimetype: string | null,
    identifier: string | null = "artwork",
    width: number | null = null,
    height: number | null = null,
    url: string | null = null,
  ): void {
    const metadata = this.state.getPlayerState(PLAYER_IDENTIFIER)!;
    metadata.artwork = artwork;
    metadata.artworkMimetype = mimetype;
    metadata.artworkIdentifier = identifier;
    metadata.artworkWidth = width;
    metadata.artworkHeight = height;
    if (url !== null) metadata.artworkUrl = url;
    this.state.updateState(PLAYER_IDENTIFIER);
  }

  /** Change metadata for item via ContentItemUpdate. */
  changeMetadata(fields: Partial<PlayingState>): void {
    const metadata = this.state.getPlayerState(PLAYER_IDENTIFIER)!;
    Object.assign(metadata, fields);
    this.state.itemUpdate(new PlayingState(fields), PLAYER_IDENTIFIER);
  }

  /** Update playing state and send SetStateMessage. */
  changeState(fields: Partial<PlayingState>, player = PLAYER_IDENTIFIER): void {
    const metadata = this.state.getPlayerState(player)!;
    Object.assign(metadata, fields);
    this.state.updateState(PLAYER_IDENTIFIER);
  }

  /** Update playing client with new information. */
  updateClient(displayName: string | null, player = PLAYER_IDENTIFIER): void {
    this.state.updateClient(displayName, player);
  }

  /** Put device in idle state. */
  nothingPlaying(): void {
    this.state.setActivePlayer(null);
  }

  /** Play some example video. */
  exampleVideo(options: Record<string, any> = {}): void {
    this.videoPlaying({ paused: true, title: "dummy", position: 3, totalTime: 123, ...options });
  }

  /** Change what is currently playing to video. */
  videoPlaying(options: Record<string, any>): void {
    const { paused, player = PLAYER_IDENTIFIER, appName = APP_NAME, ...rest } = options;
    const fields = new PlayingState({
      playbackState: paused ? pb.PlaybackState.Paused : pb.PlaybackState.Playing,
      playbackRate: paused ? 0.0 : 1.0,
      mediaType: pb.ContentItemMetadata.Video,
      appName,
      ...rest,
    });
    this.state.setPlayerState(player, fields);
    this.state.setActivePlayer(player);
  }

  /** Play some example music. */
  exampleMusic(options: Record<string, any> = {}): void {
    this.musicPlaying({
      paused: true,
      title: "music",
      artist: "artist",
      album: "album",
      totalTime: 49,
      position: 22,
      genre: "genre",
      ...options,
    });
  }

  /** Change what is currently playing to music. */
  musicPlaying(options: Record<string, any>): void {
    const { paused, ...rest } = options;
    const fields = new PlayingState({
      playbackState: paused ? pb.PlaybackState.Paused : pb.PlaybackState.Playing,
      playbackRate: paused ? 0.0 : 1.0,
      mediaType: pb.ContentItemMetadata.Music,
      ...rest,
    });
    this.state.setPlayerState(PLAYER_IDENTIFIER, fields);
    this.state.setActivePlayer(PLAYER_IDENTIFIER);
  }

  exampleTv(options: Record<string, any> = {}): void {
    this.tvPlaying({
      paused: false,
      seriesName: "tvshow",
      totalTime: 123,
      position: 5,
      seasonNumber: 12,
      episodeNumber: 3,
      ...options,
    });
  }

  /** Change what is currently playing to TV. */
  tvPlaying(options: Record<string, any>): void {
    const { paused, ...rest } = options;
    const fields = new PlayingState({
      playbackState: paused ? pb.PlaybackState.Paused : pb.PlaybackState.Playing,
      playbackRate: paused ? 0.0 : 1.0,
      mediaType: pb.ContentItemMetadata.Video,
      ...rest,
    });
    this.state.setPlayerState(PLAYER_IDENTIFIER, fields);
    this.state.setActivePlayer(PLAYER_IDENTIFIER);
  }

  /** Put device in a loading state. */
  mediaIsLoading(): void {
    this.state.setPlayerState(PLAYER_IDENTIFIER, new PlayingState({ playbackState: pb.PlaybackState.Interrupted }));
    this.state.setActivePlayer(PLAYER_IDENTIFIER);
  }

  /** Set default supported commands. */
  defaultSupportedCommands(commands: number[]): void {
    this.state.defaultSupportedCommands(commands);
  }

  /** Change current volume. */
  setVolume(volume: number, deviceUid: string): void {
    this.state.setVolume(volume, deviceUid);
  }
}

registerFake(
  Protocol.MRP,
  (state, app) => new FakeMrpServiceFactory(state, app),
  () => new FakeMrpState(),
  (state) => new FakeMrpUseCases(state),
);
