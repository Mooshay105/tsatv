/** Implementation of the MediaRemoteTV Protocol used by ATV4 and later. */

import { SRPAuthHandler } from "../../auth/hap_srp.ts";
import {
  DeviceState,
  FeatureName,
  FeatureState,
  InputAction,
  MediaType,
  OperatingSystem,
  PairingRequirement,
  PowerState,
  Protocol,
  RepeatState,
  ShuffleState,
} from "../../const.ts";
import {
  AbstractPushUpdater,
  type Core,
  MutableService,
  OutputDeviceState,
  type ProtocolStateDispatcher,
  type SetupData,
  UpdatedState,
} from "../../core/index.ts";
import * as mdns from "../../core/mdns.ts";
import { deviceInfoNameFromUniqueShortName, type ScanHandlerDeviceInfoName, type ScanHandlerReturn } from "../../core/scan.ts";
import { CommandError, NoAsyncListenerError, NotSupportedError, ProtocolError } from "../../exceptions.ts";
import { getUniqueId } from "../../helpers.ts";
import {
  App,
  ArtworkInfo,
  Audio,
  type BaseConfig,
  type BaseService,
  DeviceInfo,
  FeatureInfo,
  Features,
  Metadata,
  OutputDevice,
  type PairingHandler,
  Playing,
  Power,
  PushUpdater,
  RemoteControl,
} from "../../interface.ts";
import { Event, sleep, TimeoutError, waitFor } from "../../support/asyncio.ts";
import { Cache } from "../../support/cache.ts";
import { lookupModel, lookupVersion } from "../../support/device_info.ts";
import type { ClientSession } from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import { isUrl } from "../../support/url.ts";
import { registerProtocol } from "../index.ts";
import { type AbstractMrpConnection, MrpConnection } from "./connection.ts";
import * as messages from "./messages.ts";
import { MrpPairingHandler } from "./pairing.ts";
import { type PlayerState, PlayerStateManager } from "./player_state.ts";
import * as pb from "./protobuf/index.ts";
import { MrpProtocol } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.mrp");

const DEFAULT_SKIP_TIME = 15;

// Source: https://github.com/Daij-Djan/DDHidLib/blob/master/usb_hid_usages.txt
const KEY_LOOKUP: Record<string, [number, number]> = {
  // name: [usage_page, usage]
  up: [1, 0x8c],
  down: [1, 0x8d],
  left: [1, 0x8b],
  right: [1, 0x8a],
  stop: [12, 0xb7],
  next: [12, 0xb5],
  previous: [12, 0xb6],
  select: [1, 0x89],
  menu: [1, 0x86],
  topmenu: [12, 0x60],
  home: [12, 0x40],
  suspend: [1, 0x82],
  wakeup: [1, 0x83],
  volume_up: [12, 0xe9],
  volume_down: [12, 0xea],
};

const FEATURES_SUPPORTED: FeatureName[] = [
  FeatureName.Down,
  FeatureName.Home,
  FeatureName.HomeHold,
  FeatureName.Left,
  FeatureName.Menu,
  FeatureName.Right,
  FeatureName.Select,
  FeatureName.TopMenu,
  FeatureName.Up,
  FeatureName.TurnOn,
  FeatureName.TurnOff,
  FeatureName.PowerState,
  FeatureName.OutputDevices,
  FeatureName.AddOutputDevices,
  FeatureName.RemoveOutputDevices,
  FeatureName.SetOutputDevices,
];

const FEATURE_COMMAND_MAP = new Map<FeatureName, number>([
  [FeatureName.Next, pb.Command.NextTrack],
  [FeatureName.Pause, pb.Command.Pause],
  [FeatureName.Play, pb.Command.Play],
  [FeatureName.PlayPause, pb.Command.TogglePlayPause],
  [FeatureName.Previous, pb.Command.PreviousTrack],
  [FeatureName.Stop, pb.Command.Stop],
  [FeatureName.SetPosition, pb.Command.SeekToPlaybackPosition],
  [FeatureName.SetRepeat, pb.Command.ChangeRepeatMode],
  [FeatureName.SetShuffle, pb.Command.ChangeShuffleMode],
  [FeatureName.Shuffle, pb.Command.ChangeShuffleMode],
  [FeatureName.Repeat, pb.Command.ChangeRepeatMode],
  [FeatureName.SkipForward, pb.Command.SkipForward],
  [FeatureName.SkipBackward, pb.Command.SkipBackward],
]);

// Features that are considered available if corresponding field is present
const FIELD_FEATURES = new Map<FeatureName, string>([
  [FeatureName.Title, "title"],
  [FeatureName.Artist, "trackArtistName"],
  [FeatureName.Album, "albumName"],
  [FeatureName.Genre, "genre"],
  [FeatureName.TotalTime, "duration"],
  [FeatureName.SeriesName, "seriesName"],
  [FeatureName.Position, "elapsedTimeTimestamp"],
  [FeatureName.SeasonNumber, "seasonNumber"],
  [FeatureName.EpisodeNumber, "episodeNumber"],
  [FeatureName.ContentIdentifier, "contentIdentifier"],
  [FeatureName.iTunesStoreIdentifier, "iTunesStoreIdentifier"],
]);

export const DELAY_BETWEEN_COMMANDS = 0.1;

// Seconds between 1970-01-01 and 2001-01-01 (cocoa reference date)
const COCOA_EPOCH_OFFSET = 978307200;

/** Hooks replaceable in tests. */
export const mrpHooks = {
  /** Current time in seconds since epoch. */
  now: (): number => Date.now() / 1000,
};

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/** Build a Playing instance from play state. */
export function buildPlayingInstance(state: PlayerState): Playing {
  const mediaType = (): MediaType => {
    const metadata = state.metadata;
    if (metadata) {
      if (metadata.mediaType === pb.ContentItemMetadata.Audio) return MediaType.Music;
      if (metadata.mediaType === pb.ContentItemMetadata.Video) return MediaType.Video;
    }
    return MediaType.Unknown;
  };

  const deviceState = (): DeviceState => {
    const playbackState = state.playbackState;
    if (playbackState === null) return DeviceState.Idle;
    const mapping = new Map<number, DeviceState>([
      [pb.PlaybackState.Playing, DeviceState.Playing],
      [pb.PlaybackState.Paused, DeviceState.Paused],
      [pb.PlaybackState.Stopped, DeviceState.Stopped],
      [pb.PlaybackState.Interrupted, DeviceState.Loading],
      [pb.PlaybackState.Seeking, DeviceState.Seeking],
    ]);
    return mapping.get(playbackState) ?? DeviceState.Paused;
  };

  const totalTime = (): number | null => {
    const duration = state.metadataField("duration");
    if (duration === null || Number.isNaN(duration)) return null;
    return Math.trunc(duration);
  };

  const position = (): number | null => {
    const elapsedTimestamp = state.metadataField("elapsedTimeTimestamp");

    // If we don't have reference time, we can't do anything
    if (!elapsedTimestamp) return null;

    const elapsedTime: number = state.metadataField("elapsedTime") || 0;
    const diff = mrpHooks.now() - (elapsedTimestamp + COCOA_EPOCH_OFFSET);

    const playbackRate = state.metadataField("playbackRate") || 0.0;
    if (deviceState() === DeviceState.Playing && !isClose(playbackRate, 0.0)) {
      return Math.trunc(elapsedTime + diff);
    }
    return Math.trunc(elapsedTime);
  };

  const shuffle = (): ShuffleState => {
    const info = state.commandInfo(pb.Command.ChangeShuffleMode);
    if (info === null) return ShuffleState.Off;
    if (info.shuffleMode === pb.ShuffleMode.Off) return ShuffleState.Off;
    if (info.shuffleMode === pb.ShuffleMode.Albums) return ShuffleState.Albums;
    return ShuffleState.Songs;
  };

  const repeat = (): RepeatState => {
    const info = state.commandInfo(pb.Command.ChangeRepeatMode);
    if (info === null) return RepeatState.Off;
    if (info.repeatMode === pb.RepeatMode.One) return RepeatState.Track;
    if (info.repeatMode === pb.RepeatMode.All) return RepeatState.All;
    return RepeatState.Off;
  };

  return new Playing({
    mediaType: mediaType(),
    deviceState: deviceState(),
    title: state.metadataField("title"),
    artist: state.metadataField("trackArtistName"),
    album: state.metadataField("albumName"),
    genre: state.metadataField("genre"),
    totalTime: totalTime(),
    position: position(),
    shuffle: shuffle(),
    repeat: repeat(),
    hash: state.itemIdentifier,
    seriesName: state.metadataField("seriesName"),
    seasonNumber: state.metadataField("seasonNumber"),
    episodeNumber: state.metadataField("episodeNumber"),
    contentIdentifier: state.metadataField("contentIdentifier"),
    itunesStoreIdentifier: state.metadataField("iTunesStoreIdentifier"),
  });
}

async function sendHidKey(protocol: MrpProtocol, key: string, action: InputAction, flush = true): Promise<void> {
  const doPress = async (keycode: [number, number], hold: boolean) => {
    await protocol.send(messages.sendHidEvent(keycode[0], keycode[1], true));

    // Hardcoded hold time for one second
    if (hold) await sleep(1);

    await protocol.send(messages.sendHidEvent(keycode[0], keycode[1], false));

    // Send and receive a generic message as some kind of "flush" mechanism
    if (flush) await protocol.sendAndReceive(messages.create(pb.GENERIC_MESSAGE));
  };

  const keycode = KEY_LOOKUP[key];
  if (!keycode) throw new NotSupportedError(`unsupported key: ${key}`);

  if (action === InputAction.SingleTap) {
    await doPress(keycode, false);
  } else if (action === InputAction.DoubleTap) {
    await doPress(keycode, false);
    await doPress(keycode, false);
  } else if (action === InputAction.Hold) {
    await doPress(keycode, true);
  } else {
    throw new NotSupportedError(`unsupported input action: ${action}`);
  }
}

/** Implementation of API for controlling an Apple TV. */
export class MrpRemoteControl extends RemoteControl {
  constructor(
    readonly psm: PlayerStateManager,
    readonly protocol: MrpProtocol,
  ) {
    super();
  }

  private async _sendCommand(command: number, options: Record<string, unknown> = {}): Promise<void> {
    const resp = await this.protocol.sendAndReceive(messages.command(command, options));
    const inner = pb.extractInner(resp) as pb.SendCommandResultMessage;

    if (inner.sendError === pb.SendError.NoError) return;

    throw new CommandError(
      `${pb.enumName(pb.Command, command)} failed: ` +
        `SendError=${pb.enumName(pb.SendError.Enum, inner.sendError)}, ` +
        `HandlerReturnStatus=${pb.enumName(pb.HandlerReturnStatus.Enum, inner.handlerReturnStatus)}`,
    );
  }

  override async up(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "up", action);
  }

  override async down(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "down", action);
  }

  override async left(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "left", action);
  }

  override async right(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "right", action);
  }

  override async play(): Promise<void> {
    await this._sendCommand(pb.Command.Play);
  }

  override async playPause(): Promise<void> {
    // Cannot use the feature interface here since it emulates the feature state
    const cmd = this.psm.playing.commandInfo(pb.Command.TogglePlayPause);
    if (cmd && cmd.enabled) {
      await this._sendCommand(pb.Command.TogglePlayPause);
    } else {
      const state = this.psm.playing.playbackState;
      if (state === pb.PlaybackState.Playing) await this.pause();
      else if (state === pb.PlaybackState.Paused) await this.play();
    }
  }

  override async pause(): Promise<void> {
    await this._sendCommand(pb.Command.Pause);
  }

  override async stop(): Promise<void> {
    await this._sendCommand(pb.Command.Stop);
  }

  override async next(): Promise<void> {
    await this._sendCommand(pb.Command.NextTrack);
  }

  override async previous(): Promise<void> {
    await this._sendCommand(pb.Command.PreviousTrack);
  }

  override async select(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "select", action);
  }

  override async menu(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "menu", action);
  }

  override async volumeUp(): Promise<void> {
    await sendHidKey(this.protocol, "volume_up", InputAction.SingleTap);
  }

  override async volumeDown(): Promise<void> {
    await sendHidKey(this.protocol, "volume_down", InputAction.SingleTap);
  }

  override async home(action: InputAction = InputAction.SingleTap): Promise<void> {
    await sendHidKey(this.protocol, "home", action);
  }

  override async homeHold(): Promise<void> {
    await sendHidKey(this.protocol, "home", InputAction.Hold);
  }

  override async topMenu(): Promise<void> {
    await sendHidKey(this.protocol, "topmenu", InputAction.SingleTap);
  }

  override async suspend(): Promise<void> {
    await sendHidKey(this.protocol, "suspend", InputAction.SingleTap);
  }

  override async wakeup(): Promise<void> {
    await sendHidKey(this.protocol, "wakeup", InputAction.SingleTap);
  }

  override async skipForward(timeInterval = 0.0): Promise<void> {
    await this._skipCommand(pb.Command.SkipForward, timeInterval);
  }

  override async skipBackward(timeInterval = 0.0): Promise<void> {
    await this._skipCommand(pb.Command.SkipBackward, timeInterval);
  }

  private async _skipCommand(command: number, timeInterval: number): Promise<void> {
    const info = this.psm.playing.commandInfo(command);

    let skipInterval: number;
    if (timeInterval > 0) {
      skipInterval = Math.trunc(timeInterval);
    } else if (info && info.preferredIntervals.length > 0) {
      // Pick the first preferred interval for simplicity
      skipInterval = info.preferredIntervals[0]!;
    } else {
      skipInterval = DEFAULT_SKIP_TIME;
    }

    await this._sendCommand(command, { skipInterval });
  }

  override async setPosition(pos: number): Promise<void> {
    await this.protocol.sendAndReceive(messages.seekToPosition(pos));
  }

  override async setShuffle(shuffleState: ShuffleState): Promise<void> {
    await this.protocol.sendAndReceive(messages.shuffle(shuffleState));
  }

  override async setRepeat(repeatState: RepeatState): Promise<void> {
    await this.protocol.sendAndReceive(messages.repeat(repeatState));
  }
}

function formatTemplate(template: string, values: Record<string, string | number>): string | null {
  let failed = false;
  const result = template.replace(/\{(\w*)\}/g, (_match, key: string) => {
    if (!(key in values)) {
      failed = true;
      return "";
    }
    return String(values[key]);
  });
  return failed ? null : result;
}

/** Implementation of API for retrieving metadata. */
export class MrpMetadata extends Metadata {
  readonly artworkCache = new Cache<string, ArtworkInfo | null>(4);

  constructor(
    readonly protocol: MrpProtocol,
    readonly psm: PlayerStateManager,
    readonly identifier: string | null,
    readonly clientSession: ClientSession,
  ) {
    super();
  }

  override get deviceId(): string | null {
    return this.identifier;
  }

  override async artwork(width: number | null = 512, height: number | null = null): Promise<ArtworkInfo | null> {
    const identifier = this.artworkId;
    if (!identifier) {
      LOGGER.debug("No artwork available");
      return null;
    }

    if (this.artworkCache.has(identifier)) {
      LOGGER.debug("Retrieved artwork %s from cache", identifier);
      return this.artworkCache.get(identifier);
    }

    let artwork: ArtworkInfo | null = null;
    try {
      artwork = await this._fetchArtwork(width || 0, height || -1);
    } catch (ex) {
      LOGGER.warning("Artwork not present in response: %s", ex);
      return null;
    }
    this.artworkCache.put(identifier, artwork);
    return artwork;
  }

  private async _fetchArtwork(width: number, height: number): Promise<ArtworkInfo | null> {
    return (await this._fetchRemoteArtwork(width, height)) ?? (await this._fetchLocalArtwork(width, height));
  }

  /** Fetch external artwork from a URL. */
  private async _fetchRemoteArtwork(width: number, height: number): Promise<ArtworkInfo | null> {
    const metadata = this.psm.playing.metadata;
    if (!metadata) return null;

    const urls: string[] = [];

    if (metadata.hasField("artworkIdentifier")) {
      // appears to be a template to itunes artwork, but let's validate
      const url = formatTemplate(metadata.artworkIdentifier, {
        // the itunes image server preserves aspect ratio
        w: width < 1 ? 999999 : width,
        h: height < 1 ? 999999 : height,
        c: "bb",
        f: "png",
      });
      if (url && isUrl(url)) urls.push(url);
    }

    if (metadata.hasField("artworkURL")) {
      // artworkURL has fixed size and format, use it as a fallback
      urls.push(metadata.artworkURL);
    }

    for (const url of urls) {
      try {
        const response = await this.clientSession.get(url);
        if (response.status === 200) {
          return new ArtworkInfo(await response.read(), response.headers.get("content-type") ?? "", width, height);
        }
      } catch {
        // Ignore and try next
      }
    }
    return null;
  }

  /** Fetch artwork over MRP. */
  private async _fetchLocalArtwork(width: number, height: number): Promise<ArtworkInfo | null> {
    const playing = this.psm.playing;
    const resp = await this.psm.protocol.sendAndReceive(messages.playbackQueueRequest(playing.location, width, height));
    if (!resp.hasField("type")) return null;

    const item = (pb.extractInner(resp) as pb.SetStateMessage).playbackQueue.contentItems[playing.location];
    if (!item) throw new Error("artwork item missing in response");
    return new ArtworkInfo(item.artworkData, playing.metadata!.artworkMIMEType, item.artworkDataWidth, item.artworkDataHeight);
  }

  override get artworkId(): string {
    const metadata = this.psm.playing.metadata;
    if (metadata && (metadata.artworkAvailable || metadata.hasField("artworkURL"))) {
      if (metadata.hasField("artworkIdentifier")) return metadata.artworkIdentifier;
      if (metadata.hasField("contentIdentifier")) return metadata.contentIdentifier;
      return this.psm.playing.itemIdentifier as string;
    }
    return null as unknown as string;
  }

  override async playing(): Promise<Playing> {
    return buildPlayingInstance(this.psm.playing);
  }

  override get app(): App | null {
    const client = this.psm.client;
    if (client) return new App(client.displayName, client.bundleIdentifier);
    return null;
  }
}

/** Implementation of API for retrieving a power state from an Apple TV. */
export class MrpPower extends Power {
  deviceInfo: pb.ProtocolMessage | null = null;
  private readonly _waiters = new Map<PowerState, Event>();

  constructor(
    readonly protocol: MrpProtocol,
    readonly remote: MrpRemoteControl,
  ) {
    super();
    this.protocol.listenTo(pb.DEVICE_INFO_MESSAGE, (m) => this._updatePowerState(m));
    this.protocol.listenTo(pb.DEVICE_INFO_UPDATE_MESSAGE, (m) => this._updatePowerState(m));
  }

  private _getCurrentPowerState(): PowerState {
    const latestDeviceInfo = this.deviceInfo ?? this.protocol.deviceInfo;
    return MrpPower._getPowerState(latestDeviceInfo);
  }

  override get powerState(): PowerState {
    return this._getCurrentPowerState();
  }

  override async turnOn(awaitNewState = false): Promise<void> {
    await this.protocol.send(messages.wakeDevice());
    if (awaitNewState && this.powerState !== PowerState.On) await this._waiter(PowerState.On).wait();
  }

  override async turnOff(awaitNewState = false): Promise<void> {
    await this.remote.home(InputAction.Hold);
    await sleep(DELAY_BETWEEN_COMMANDS);
    await this.remote.select();
    if (awaitNewState && this.powerState !== PowerState.Off) await this._waiter(PowerState.Off).wait();
  }

  private _waiter(state: PowerState): Event {
    let event = this._waiters.get(state);
    if (!event) {
      event = new Event();
      this._waiters.set(state, event);
    }
    return event;
  }

  private async _updatePowerState(message: pb.ProtocolMessage): Promise<void> {
    const oldState = this.powerState;
    const newState = MrpPower._getPowerState(message);
    this.deviceInfo = message;

    if (newState !== oldState) {
      LOGGER.debug("Power state changed from %s to %s", oldState, newState);
      const callback = this.listener.powerstateUpdate;
      queueMicrotask(() => callback(oldState, newState));
    }

    const waiter = this._waiters.get(newState);
    if (waiter) {
      waiter.set();
      this._waiters.delete(newState);
    }
  }

  private static _getPowerState(deviceInfoMessage: pb.ProtocolMessage | null): PowerState {
    if (deviceInfoMessage === null) return PowerState.Unknown;
    const logicalDeviceCount = (pb.extractInner(deviceInfoMessage) as pb.DeviceInfoMessage).logicalDeviceCount;
    if (logicalDeviceCount >= 1) return PowerState.On;
    if (logicalDeviceCount === 0) return PowerState.Off;
    return PowerState.Unknown;
  }
}

/** Implementation of API for handling push update from an Apple TV. */
export class MrpPushUpdater extends AbstractPushUpdater {
  constructor(
    readonly metadata: MrpMetadata,
    readonly psm: PlayerStateManager,
    stateDispatcher: ProtocolStateDispatcher,
  ) {
    super(stateDispatcher);
  }

  get active(): boolean {
    return this.psm.listener === this;
  }

  /** Wait for push updates from device. */
  start(_initialDelay = 0): void {
    if (this.listener === null) throw new NoAsyncListenerError();
    if (this.active) return;

    this.psm.listener = this;
    void this.stateUpdated();
  }

  /** No longer forward updates to listener. */
  stop(): void {
    this.psm.listener = null;
  }

  /** State was updated for active player. */
  async stateUpdated(): Promise<void> {
    try {
      const playstatus = await this.metadata.playing();
      this.postUpdate(playstatus);
    } catch (ex) {
      LOGGER.debug("Playstatus error occurred: %s", ex);
      const callback = this.listener.playstatusError;
      queueMicrotask(() => callback(this, ex as Error));
    }
  }
}

/** Implementation of audio functionality. */
export class MrpAudio extends Audio {
  private _volumeControlsAvailable = false;
  private _volumeControlsAbsolute = false;
  private _volumeControlsRelative = false;
  private _volume = 0.0;
  private _volumeEvent = new Event();
  private _outputDevices: OutputDevice[] = [];
  private _outputDevicesEvent = new Event();

  constructor(
    readonly protocol: MrpProtocol,
    readonly stateDispatcher: ProtocolStateDispatcher,
  ) {
    super();
    this._addListeners();
  }

  /** Return the UID of our device. */
  get deviceUid(): string | null {
    if (this.protocol.deviceInfo !== null) {
      const inner = pb.extractInner(this.protocol.deviceInfo) as pb.DeviceInfoMessage;
      return inner.clusterID || inner.deviceUID;
    }
    return null;
  }

  /** Return if audio controls are available. */
  get isAvailable(): boolean {
    return this._volumeControlsAvailable && this.deviceUid !== null;
  }

  /** Return if absolute audio controls are available. */
  get isVolumeAbsolute(): boolean {
    return this._volumeControlsAbsolute;
  }

  /** Return if relative audio controls are available. */
  get isVolumeRelative(): boolean {
    return this._volumeControlsRelative;
  }

  private _addListeners(): void {
    this.protocol.listenTo(pb.VOLUME_CONTROL_AVAILABILITY_MESSAGE, async (m) =>
      this._updateVolumeControls(pb.extractInner(m)),
    );
    this.protocol.listenTo(pb.VOLUME_CONTROL_CAPABILITIES_DID_CHANGE_MESSAGE, async (m) => {
      const inner = pb.extractInner(m) as pb.VolumeControlCapabilitiesDidChangeMessage;
      // Make sure update is for our device (in case it changed for someone else)
      if (inner.outputDeviceUID === this.deviceUid) this._updateVolumeControls(inner.capabilities);
    });
    this.protocol.listenTo(pb.VOLUME_DID_CHANGE_MESSAGE, async (m) => this._volumeDidChange(m));
    this.protocol.listenTo(pb.DEVICE_INFO_MESSAGE, async (m) => this._updateOutputDevices(m));
    this.protocol.listenTo(pb.DEVICE_INFO_UPDATE_MESSAGE, async (m) => this._updateOutputDevices(m));
  }

  private _updateVolumeControls(availability: pb.VolumeControlAvailabilityMessage): void {
    this._volumeControlsAvailable = availability.volumeControlAvailable;
    this._volumeControlsAbsolute = [pb.VolumeCapabilities.Absolute, pb.VolumeCapabilities.Both].includes(
      availability.volumeCapabilities as 1 | 3,
    );
    this._volumeControlsRelative = [pb.VolumeCapabilities.Relative, pb.VolumeCapabilities.Both].includes(
      availability.volumeCapabilities as 2 | 3,
    );
    LOGGER.debug("Volume control availability changed to %s", this._volumeControlsAvailable);
  }

  private _signalVolumeEvent(): void {
    const event = this._volumeEvent;
    this._volumeEvent = new Event();
    event.set();
  }

  private _volumeDidChange(message: pb.ProtocolMessage): void {
    const inner = pb.extractInner(message) as pb.VolumeDidChangeMessage;
    const volume = Math.round(inner.volume * 100.0 * 10) / 10;

    // Make sure update is for our device (in case it changed for someone else)
    if (inner.outputDeviceUID === this.deviceUid) {
      this._volume = volume;
      LOGGER.debug("Volume changed to %s", this.volume.toFixed(1));
      this.stateDispatcher.dispatch(UpdatedState.Volume, this._volume);
    } else {
      LOGGER.debug("Volume changed to %s for output device %s", volume.toFixed(1), inner.outputDeviceUID);
      this.stateDispatcher.dispatch(UpdatedState.OutputDeviceVolume, new OutputDeviceState(inner.outputDeviceUID, volume));
    }

    // There are no responses to the volume_up/down commands sent to the device. So
    // when calling volumeUp/Down here, they will wait for the volume to change to
    // know when done.
    this._signalVolumeEvent();
  }

  override get volume(): number {
    return this._volume;
  }

  override async setVolume(level: number, outputDevice: OutputDevice | null = null): Promise<void> {
    if (outputDevice === null) {
      if (this.deviceUid === null) throw new ProtocolError("no output device");
      const waiter = this._volumeEvent.wait();
      await this.protocol.send(messages.setVolume(this.deviceUid, level / 100.0));
      if (this.isVolumeAbsolute && this._volume !== level) await waitFor(waiter, 5.0);
    } else {
      const waiter = this._volumeEvent.wait();
      await this.protocol.send(messages.setVolume(outputDevice.identifier, level / 100.0));
      if (outputDevice.volume !== level) await waitFor(waiter, 5.0);
    }
  }

  override async volumeUp(): Promise<void> {
    if (this.isVolumeAbsolute && this._volume === 100.0) return;
    if (this.isVolumeRelative) {
      const waiter = this._volumeEvent.wait();
      await sendHidKey(this.protocol, "volume_up", InputAction.SingleTap, false);
      if (this.isVolumeAbsolute) await waitFor(waiter, 5.0);
    } else if (this.isVolumeAbsolute) {
      await this.setVolume(Math.min(this.volume + 5, 100.0));
    }
  }

  override async volumeDown(): Promise<void> {
    if (this.isVolumeAbsolute && this._volume === 0.0) return;
    if (this.isVolumeRelative) {
      const waiter = this._volumeEvent.wait();
      await sendHidKey(this.protocol, "volume_down", InputAction.SingleTap, false);
      if (this.isVolumeAbsolute) await waitFor(waiter, 5.0);
    } else if (this.isVolumeAbsolute) {
      await this.setVolume(Math.max(this.volume - 5, 0.0));
    }
  }

  private _updateOutputDevices(message: pb.ProtocolMessage): void {
    const inner = pb.extractInner(message) as pb.DeviceInfoMessage;
    const devices: OutputDevice[] = [];
    if (inner.isGroupLeader && !inner.isProxyGroupPlayer) {
      devices.push(new OutputDevice(inner.uniqueIdentifier, inner.name));
    }
    for (const device of inner.groupedDevices) {
      devices.push(new OutputDevice(device.deviceUID, device.name));
    }
    this._outputDevices = devices;
    const event = this._outputDevicesEvent;
    this._outputDevicesEvent = new Event();
    event.set();
    this.stateDispatcher.dispatch(UpdatedState.OutputDevices, devices);
  }

  override get outputDevices(): OutputDevice[] {
    return this._outputDevices;
  }

  private async _waitOutputDevices(waiter: Promise<void>): Promise<void> {
    try {
      await waitFor(waiter, 5.0);
    } catch (ex) {
      if (!(ex instanceof TimeoutError)) throw ex;
    }
  }

  override async addOutputDevices(...devices: string[]): Promise<void> {
    const waiter = this._outputDevicesEvent.wait();
    await this.protocol.send(messages.addOutputDevices(...devices));
    await this._waitOutputDevices(waiter);
  }

  override async removeOutputDevices(...devices: string[]): Promise<void> {
    const waiter = this._outputDevicesEvent.wait();
    await this.protocol.send(messages.removeOutputDevices(...devices));
    await this._waitOutputDevices(waiter);
  }

  override async setOutputDevices(...devices: string[]): Promise<void> {
    const waiter = this._outputDevicesEvent.wait();
    await this.protocol.send(messages.setOutputDevices(...devices));
    await this._waitOutputDevices(waiter);
  }
}

/** Implementation of API for supported feature functionality. */
export class MrpFeatures extends Features {
  constructor(
    readonly config: BaseConfig,
    readonly psm: PlayerStateManager,
    readonly audio: MrpAudio,
  ) {
    super();
  }

  override getFeature(featureName: FeatureName): FeatureInfo {
    if (FEATURES_SUPPORTED.includes(featureName)) return new FeatureInfo(FeatureState.Available);
    if (featureName === FeatureName.Artwork) {
      const metadata = this.psm.playing.metadata;
      if (metadata && metadata.artworkAvailable) return new FeatureInfo(FeatureState.Available);
      return new FeatureInfo(FeatureState.Unavailable);
    }

    const fieldName = FIELD_FEATURES.get(featureName);
    if (fieldName) {
      const available = this.psm.playing.metadataField(fieldName) !== null;
      return new FeatureInfo(available ? FeatureState.Available : FeatureState.Unavailable);
    }

    // Special case for PlayPause emulation. Based on the behavior in the Youtube app,
    // only the "opposite" feature to current state is available. E.g. if something
    // is playing, then pause will be available but not play.
    if (featureName === FeatureName.PlayPause) {
      const playbackState = this.psm.playing.playbackState;
      if (playbackState === pb.PlaybackState.Playing && this.inState(FeatureState.Available, FeatureName.Pause)) {
        return new FeatureInfo(FeatureState.Available);
      }
      if (playbackState === pb.PlaybackState.Paused && this.inState(FeatureState.Available, FeatureName.Play)) {
        return new FeatureInfo(FeatureState.Available);
      }
    }

    const cmdId = FEATURE_COMMAND_MAP.get(featureName);
    if (cmdId !== undefined) {
      const cmd = this.psm.playing.commandInfo(cmdId);
      if (cmd && cmd.enabled) return new FeatureInfo(FeatureState.Available);
      return new FeatureInfo(FeatureState.Unavailable);
    }

    if (featureName === FeatureName.App) {
      return new FeatureInfo(this.psm.client ? FeatureState.Available : FeatureState.Unavailable);
    }

    if (featureName === FeatureName.VolumeDown || featureName === FeatureName.VolumeUp) {
      return new FeatureInfo(this.audio.isAvailable ? FeatureState.Available : FeatureState.Unavailable);
    }

    if (featureName === FeatureName.Volume || featureName === FeatureName.SetVolume) {
      return new FeatureInfo(
        this.audio.isAvailable && this.audio.isVolumeAbsolute ? FeatureState.Available : FeatureState.Unavailable,
      );
    }

    return new FeatureInfo(FeatureState.Unsupported);
  }
}

/** Parse and return a new MRP service. */
export function mrpServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn {
  let enabled = true;

  // Disable this service if tvOS version is >= 15 as it doesn't work anymore
  const build = mdns.getProperty(mdnsService.properties, "SystemBuildVersion") ?? "";
  const match = /^(\d+)[A-Z]/.exec(build);
  if (match) {
    const base = parseInt(match[1]!, 10);
    if (base >= 19) {
      LOGGER.debug("Disabling MRP service since tvOS >= 15");
      enabled = false;
    }
  }

  const name = mdns.getProperty(mdnsService.properties, "Name") ?? "Unknown";
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties as any),
    Protocol.MRP,
    mdnsService.port,
    mdnsService.properties as any,
    null,
    null,
    enabled,
  );
  return [name, service];
}

/** Return handlers used for scanning. */
export function scan(): Record<string, ScanHandlerDeviceInfoName> {
  return { "_mediaremotetv._tcp.local": [mrpServiceHandler, deviceInfoNameFromUniqueShortName] };
}

function getProp(properties: Record<string, string> | Map<string, string>, key: string): string | undefined {
  return mdns.getProperty(properties as any, key);
}

/** Return device information from zeroconf properties. */
export function deviceInfo(
  _serviceType: string,
  properties: Record<string, string> | Map<string, string>,
): Record<string, unknown> {
  const devinfo: Record<string, unknown> = {};
  const build = getProp(properties, "systembuildversion");
  if (build !== undefined) {
    devinfo[DeviceInfo.BUILD_NUMBER] = build;
    const version = lookupVersion(build);
    if (version) devinfo[DeviceInfo.VERSION] = version;
  }
  const mac = getProp(properties, "macaddress");
  if (mac !== undefined) devinfo[DeviceInfo.MAC] = mac;

  // MRP has only been seen on Apple TV and HomePod, which both run tvOS, so an
  // educated guess is made here.
  devinfo[DeviceInfo.OPERATING_SYSTEM] = OperatingSystem.TvOS;
  return devinfo;
}

/**
 * Update service with additional information.
 *
 * Pairing has never been enforced by MRP (maybe by design), but it is possible to pair
 * if AllowPairing is YES.
 */
export async function serviceInfo(
  service: MutableService,
  _devinfo: DeviceInfo,
  _services: Map<Protocol, BaseService>,
): Promise<void> {
  if (!service.enabled) {
    service.pairing = PairingRequirement.NotNeeded;
  } else if ((getProp(service.properties, "allowpairing") ?? "no").toLowerCase() === "yes") {
    service.pairing = PairingRequirement.Optional;
  } else {
    service.pairing = PairingRequirement.Disabled;
  }
}

/** Set up a new MRP service from a connection. */
export function createWithConnection(core: Core, connection: AbstractMrpConnection, requiresHeartbeat = true): SetupData {
  const protocol = new MrpProtocol(connection, new SRPAuthHandler(), core.service, core.settings.info);
  const psm = new PlayerStateManager(protocol);

  const remoteControl = new MrpRemoteControl(psm, protocol);
  const metadata = new MrpMetadata(protocol, psm, core.config.identifier, core.sessionManager.session);
  const power = new MrpPower(protocol, remoteControl);
  const pushUpdater = new MrpPushUpdater(metadata, psm, core.stateDispatcher);
  const audio = new MrpAudio(protocol, core.stateDispatcher);

  const interfaces = new Map<unknown, unknown>([
    [RemoteControl, remoteControl],
    [Metadata, metadata],
    [Power, power],
    [PushUpdater, pushUpdater],
    [Features, new MrpFeatures(core.config, psm, audio)],
    [Audio, audio],
  ]);

  const connect = async (): Promise<boolean> => {
    await protocol.start();
    if (requiresHeartbeat) protocol.enableHeartbeat();
    return true;
  };

  const close = (): Set<Promise<unknown>> => {
    pushUpdater.stop();
    protocol.stop();
    return new Set();
  };

  const getDeviceInfo = (): Record<string, unknown> => {
    const devinfo = deviceInfo(Object.keys(scan())[0]!, core.service.properties);

    // Extract build number from DEVICE_INFO_MESSAGE from device
    if (protocol.deviceInfo) {
      const info = pb.extractInner(protocol.deviceInfo) as pb.DeviceInfoMessage;
      devinfo[DeviceInfo.BUILD_NUMBER] = info.systemBuildVersion;
      if (info.modelID) {
        devinfo[DeviceInfo.RAW_MODEL] = info.modelID;
        devinfo[DeviceInfo.MODEL] = lookupModel(info.modelID);
      }
    }
    return devinfo;
  };

  // Features managed by this protocol
  const features = new Set<FeatureName>([
    FeatureName.Artwork,
    FeatureName.VolumeDown,
    FeatureName.VolumeUp,
    FeatureName.SetVolume,
    FeatureName.Volume,
    FeatureName.App,
    ...FEATURES_SUPPORTED,
    ...FEATURE_COMMAND_MAP.keys(),
    ...FIELD_FEATURES.keys(),
  ]);

  return { protocol: Protocol.MRP, connect, close, deviceInfo: getDeviceInfo, interfaces, features };
}

/** Set up a new MRP service. */
export function* setup(core: Core): Generator<SetupData> {
  yield createWithConnection(core, new MrpConnection(core.config.address, core.service.port, core.deviceListener));
}

/** Return pairing handler for protocol. */
export function pair(core: Core, options: Record<string, unknown> = {}): PairingHandler {
  return new MrpPairingHandler(core, options);
}

registerProtocol(Protocol.MRP, { setup, scan, pair, deviceInfo, serviceInfo });
