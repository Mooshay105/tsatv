/**
 * Public interface exposed by library.
 *
 * This module contains all the interfaces that represents a generic Apple TV device and
 * all its features.
 */

import { createHash } from "node:crypto";
import * as convert from "./convert.ts";
import {
  DeviceModel,
  DeviceState,
  FeatureName,
  FeatureState,
  InputAction,
  KeyboardFocusState,
  MediaType,
  OperatingSystem,
  PairingRequirement,
  PowerState,
  Protocol,
  RepeatState,
  ShuffleState,
  TouchAction,
} from "./const.ts";
import { NoServiceError, NotSupportedError, NotImplementedError } from "./exceptions.ts";
import type { Settings } from "./settings.ts";
import { lookupVersion } from "./support/device_info.ts";
import type { ClientSessionManager } from "./support/http.ts";
import { prettyRepr } from "./support/index.ts";
import { StateProducer } from "./support/state_producer.ts";
import type { StreamReader } from "./support/transport.ts";

// --- Command documentation (replacement for docstring introspection) ----------

const COMMAND_DOCS = new WeakMap<object, Record<string, string>>();

/** Return first sentence of a documentation string. */
export function getFirstSentence(doc: string): string {
  const index = doc.indexOf(".");
  if (index === -1) return doc;

  // Try to find the first complete sentence and respect abbreviations correctly
  const matches = [...doc.matchAll(/(.*\.[^A-Z]*)\.(?: [A-Z].*|)/g)];
  if (matches.length === 1) return matches[0]![1]!;
  return doc.slice(0, index);
}

/** Register documentation for commands (methods/properties) of a class. */
export function registerCommands(cls: object, docs: Record<string, string>): void {
  COMMAND_DOCS.set(cls, { ...(COMMAND_DOCS.get(cls) ?? {}), ...docs });
}

/** Return full help text for a command (or null if not a command). */
export function getCommandDoc(cls: object, name: string): string | null {
  return COMMAND_DOCS.get(cls)?.[name] ?? null;
}

/** Retrieve all commands and help texts from an API object (class). */
export function retrieveCommands(cls: object): Record<string, string> {
  const docs = COMMAND_DOCS.get(cls) ?? {};
  const commands: Record<string, string> = {};
  for (const [name, doc] of Object.entries(docs)) {
    if (name.startsWith("_") || name === "listener") continue;
    commands[name] = getFirstSentence(doc);
  }
  return commands;
}

// --- Basic types -------------------------------------------------------------

/** Artwork information. */
export class ArtworkInfo {
  constructor(
    readonly bytes: Buffer,
    readonly mimetype: string,
    readonly width: number,
    readonly height: number,
  ) {}
}

/** Container for media (e.g. audio or video) metadata. */
export class MediaMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: Buffer | null; // Raw JPEG data
  duration: number | null;

  static readonly FIELDS = ["title", "artist", "album", "artwork", "duration"] as const;

  constructor(
    init: {
      title?: string | null;
      artist?: string | null;
      album?: string | null;
      artwork?: Buffer | null;
      duration?: number | null;
    } = {},
  ) {
    this.title = init.title ?? null;
    this.artist = init.artist ?? null;
    this.album = init.album ?? null;
    this.artwork = init.artwork ?? null;
    this.duration = init.duration ?? null;
  }

  toString(): string {
    return prettyRepr("MediaMetadata", {
      title: this.title,
      artist: this.artist,
      album: this.album,
      artwork: this.artwork,
      duration: this.duration,
    });
  }
}

/** Feature state and options. */
export class FeatureInfo {
  constructor(
    readonly state: FeatureState,
    readonly options: Record<string, unknown> | null = {},
  ) {}
}

// --- Services ----------------------------------------------------------------

export type Properties = Record<string, string>;

function toProperties(properties: Properties | Map<string, string> | null | undefined): Properties {
  if (!properties) return {};
  if (properties instanceof Map) return Object.fromEntries(properties.entries());
  return { ...properties };
}

/** Base class for protocol services. */
export abstract class BaseService {
  protected _identifier: string | null;
  protected _protocol: Protocol;
  protected _port: number;
  protected _properties: Properties;
  protected _enabled: boolean;
  credentials: string | null;
  password: string | null;

  constructor(
    identifier: string | null,
    protocol: Protocol,
    port: number,
    properties: Properties | Map<string, string> | null | undefined,
    credentials: string | null = null,
    password: string | null = null,
    enabled = true,
  ) {
    this._identifier = identifier;
    this._protocol = protocol;
    this._port = port;
    this._properties = toProperties(properties);
    this._enabled = enabled;
    this.credentials = credentials;
    this.password = password;
  }

  /** Return unique identifier associated with this service. */
  get identifier(): string | null {
    return this._identifier;
  }

  /** Return protocol type. */
  get protocol(): Protocol {
    return this._protocol;
  }

  /** Return service port number. */
  get port(): number {
    return this._port;
  }

  /** Return True if service is enabled. */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /** Return if a password is required to access service. */
  abstract get requiresPassword(): boolean;

  /** Return if pairing is required by service. */
  abstract get pairing(): PairingRequirement;

  /** Return service Zeroconf properties. */
  get properties(): Properties {
    return this._properties;
  }

  /**
   * Merge with other service of same type.
   *
   * Merge will only include credentials, password and properties.
   */
  merge(other: BaseService): void {
    this.credentials = other.credentials || this.credentials;
    this.password = other.password || this.password;
    Object.assign(this._properties, other.properties);
  }

  /** Return settings and their values. */
  settings(): Record<string, unknown> {
    return { credentials: this.credentials, password: this.password };
  }

  /**
   * Apply settings to service.
   *
   * Unknown properties are silently ignored. Settings with a null value are also
   * ignored (keeps original value).
   */
  apply(settings: Record<string, unknown>): void {
    this.credentials = (settings.credentials as string | null) || this.credentials;
    this.password = (settings.password as string | null) || this.password;
  }

  toString(): string {
    return (
      `Protocol: ${convert.protocolStr(this.protocol)}, ` +
      `Port: ${this.port}, ` +
      `Credentials: ${this.credentials ?? "None"}, ` +
      `Requires Password: ${this.requiresPassword ? "True" : "False"}, ` +
      `Password: ${this.password ?? "None"}, ` +
      `Pairing: ${PairingRequirement[this.pairing]}` +
      (this.enabled ? "" : " (Disabled)")
    );
  }

  /** Return deep-copy of instance. */
  abstract deepcopy(): BaseService;
}

/** Base class for API used to pair with an Apple TV. */
export abstract class PairingHandler {
  constructor(
    public sessionManager: ClientSessionManager,
    protected _service: BaseService,
  ) {}

  /** Return service used for pairing. */
  get service(): BaseService {
    return this._service;
  }

  /** Call to free allocated resources after pairing. */
  async close(): Promise<void> {
    await this.sessionManager.close();
  }

  /** Pin code used for pairing. */
  abstract pin(pin: number | string): void;

  /** Return True if remote device presents PIN code, else False. */
  abstract get deviceProvidesPin(): boolean;

  /** If a successful pairing has been performed. */
  abstract get hasPaired(): boolean;

  /** Start pairing process. */
  abstract begin(): Promise<void>;

  /** Stop pairing process. */
  abstract finish(): Promise<void>;
}

// --- Remote control ----------------------------------------------------------

/** Base class for API used to control an Apple TV. */
export class RemoteControl {
  /** Press key up. */
  async up(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key down. */
  async down(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key left. */
  async left(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key right. */
  async right(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key play. */
  async play(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Toggle between play and pause. */
  async playPause(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key pause. */
  async pause(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key stop. */
  async stop(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key next. */
  async next(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key previous. */
  async previous(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key select. */
  async select(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key menu. */
  async menu(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key volume up. DEPRECATED: Use Audio.volumeUp instead. */
  async volumeUp(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key volume down. DEPRECATED: Use Audio.volumeDown instead. */
  async volumeDown(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Press key home. */
  async home(_action: InputAction = InputAction.SingleTap): Promise<void> {
    throw new NotSupportedError();
  }

  /** Hold key home. */
  async homeHold(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Go to main menu (long press menu). */
  async topMenu(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Suspend the device. DEPRECATED: Use Power.turnOff instead. */
  async suspend(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Wake up the device. DEPRECATED: Use Power.turnOn instead. */
  async wakeup(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Skip forward a time interval (default or app-chosen interval if not positive). */
  async skipForward(_timeInterval = 0.0): Promise<void> {
    throw new NotSupportedError();
  }

  /** Skip backward a time interval (default or app-chosen interval if not positive). */
  async skipBackward(_timeInterval = 0.0): Promise<void> {
    throw new NotSupportedError();
  }

  /** Seek in the current playing media. */
  async setPosition(_pos: number): Promise<void> {
    throw new NotSupportedError();
  }

  /** Change shuffle mode to on or off. */
  async setShuffle(_shuffleState: ShuffleState): Promise<void> {
    throw new NotSupportedError();
  }

  /** Change repeat state. */
  async setRepeat(_repeatState: RepeatState): Promise<void> {
    throw new NotSupportedError();
  }

  /** Select next channel. */
  async channelUp(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Select previous channel. */
  async channelDown(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Activate screen saver. */
  async screensaver(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Show EPG. */
  async guide(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Open the control center. */
  async controlCenter(): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(RemoteControl, {
  up: "Press key up.",
  down: "Press key down.",
  left: "Press key left.",
  right: "Press key right.",
  play: "Press key play.",
  playPause: "Toggle between play and pause.",
  pause: "Press key pause.",
  stop: "Press key stop.",
  next: "Press key next.",
  previous: "Press key previous.",
  select: "Press key select.",
  menu: "Press key menu.",
  volumeUp: "Press key volume up.",
  volumeDown: "Press key volume down.",
  home: "Press key home.",
  homeHold: "Hold key home.",
  topMenu: "Go to main menu (long press menu).",
  suspend: "Suspend the device.",
  wakeup: "Wake up the device.",
  skipForward: "Skip forward a time interval.",
  skipBackward: "Skip backward a time interval.",
  setPosition: "Seek in the current playing media.",
  setShuffle: "Change shuffle mode to on or off.",
  setRepeat: "Change repeat state.",
  channelUp: "Select next channel.",
  channelDown: "Select previous channel.",
  screensaver: "Activate screen saver..",
  guide: "Show EPG.",
  controlCenter: "Open the control center.",
});

// --- Playing -------------------------------------------------------------------

export interface PlayingInit {
  mediaType?: MediaType;
  deviceState?: DeviceState;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  totalTime?: number | null;
  position?: number | null;
  shuffle?: ShuffleState | null;
  repeat?: RepeatState | null;
  hash?: string | null;
  seriesName?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  contentIdentifier?: string | null;
  itunesStoreIdentifier?: number | null;
}

/** Base class for retrieving what is currently playing. */
export class Playing {
  static readonly PROPERTIES = [
    "mediaType",
    "deviceState",
    "title",
    "artist",
    "album",
    "genre",
    "totalTime",
    "position",
    "shuffle",
    "repeat",
    "hash",
    "seriesName",
    "seasonNumber",
    "episodeNumber",
    "contentIdentifier",
    "itunesStoreIdentifier",
  ] as const;

  protected _mediaType: MediaType;
  protected _deviceState: DeviceState;
  protected _title: string | null;
  protected _artist: string | null;
  protected _album: string | null;
  protected _genre: string | null;
  protected _totalTime: number | null;
  protected _position: number | null;
  protected _shuffle: ShuffleState | null;
  protected _repeat: RepeatState | null;
  protected _hash: string | null;
  protected _seriesName: string | null;
  protected _seasonNumber: number | null;
  protected _episodeNumber: number | null;
  protected _contentIdentifier: string | null;
  protected _itunesStoreIdentifier: number | null;

  constructor(init: PlayingInit = {}) {
    this._mediaType = init.mediaType ?? MediaType.Unknown;
    this._deviceState = init.deviceState ?? DeviceState.Idle;
    this._title = init.title ?? null;
    this._artist = init.artist ?? null;
    this._album = init.album ?? null;
    this._genre = init.genre ?? null;
    this._totalTime = init.totalTime ?? null;
    this._position = init.position ?? null;
    this._shuffle = init.shuffle ?? null;
    this._repeat = init.repeat ?? null;
    this._hash = init.hash ?? null;
    this._seriesName = init.seriesName ?? null;
    this._seasonNumber = init.seasonNumber ?? null;
    this._episodeNumber = init.episodeNumber ?? null;
    this._contentIdentifier = init.contentIdentifier ?? null;
    this._itunesStoreIdentifier = init.itunesStoreIdentifier ?? null;
    this._postProcess();
  }

  private _postProcess(): void {
    if (this._position) {
      // Make sure position never is negative
      this._position = Math.max(this._position, 0);

      // If there's a total time, never exceed that
      if (this._totalTime) {
        this._position = Math.min(this._position, this._totalTime);
      }
    }
  }

  toString(): string {
    const output: string[] = [];
    output.push(`  Media type: ${convert.mediaTypeStr(this.mediaType)}`);
    output.push(`Device state: ${convert.deviceStateStr(this.deviceState)}`);

    if (this.title !== null) output.push(`       Title: ${this.title}`);
    if (this.artist !== null) output.push(`      Artist: ${this.artist}`);
    if (this.album !== null) output.push(`       Album: ${this.album}`);
    if (this.genre !== null) output.push(`       Genre: ${this.genre}`);
    if (this.seriesName !== null) output.push(` Series Name: ${this.seriesName}`);
    if (this.seasonNumber !== null) output.push(`      Season: ${this.seasonNumber}`);
    if (this.episodeNumber !== null) output.push(`     Episode: ${this.episodeNumber}`);
    if (this.contentIdentifier) output.push(`  Identifier: ${this.contentIdentifier}`);

    const position = this.position;
    const totalTime = this.totalTime;
    if (position !== null && totalTime !== null && totalTime !== 0) {
      const percent = ((position / totalTime) * 100).toFixed(1);
      output.push(`    Position: ${position}/${totalTime}s (${percent}%)`);
    } else if (position !== null && position !== 0) {
      output.push(`    Position: ${position}s`);
    } else if (totalTime !== null && position !== 0) {
      output.push(`  Total time: ${totalTime}s`);
    }

    if (this.repeat !== null) output.push(`      Repeat: ${convert.repeatStr(this.repeat)}`);
    if (this.shuffle !== null) output.push(`     Shuffle: ${convert.shuffleStr(this.shuffle)}`);
    if (this._itunesStoreIdentifier !== null) {
      output.push(`iTunes Store Identifier: ${this._itunesStoreIdentifier}`);
    }
    return output.join("\n");
  }

  /** Compare if two objects are equal. */
  equals(other: unknown): boolean {
    if (!(other instanceof Playing)) return false;
    for (const prop of Playing.PROPERTIES) {
      if (this[prop] !== other[prop]) return false;
    }
    return true;
  }

  /**
   * Create a unique hash for what is currently playing.
   *
   * The hash is based on title, artist, album and total time. It should always be the
   * same for the same content, but it is not guaranteed.
   */
  get hash(): string {
    if (this._hash) return this._hash;
    const s = (v: unknown) => (v === null || v === undefined ? "None" : String(v));
    const base = `${s(this.title)}${s(this.artist)}${s(this.album)}${s(this.totalTime)}`;
    return createHash("sha256").update(base, "utf-8").digest("hex");
  }

  /** Type of media is currently playing, e.g. video, music. */
  get mediaType(): MediaType {
    return this._mediaType;
  }

  /** Device state, e.g. playing or paused. */
  get deviceState(): DeviceState {
    return this._deviceState;
  }

  /** Title of the current media, e.g. movie or song name. */
  get title(): string | null {
    return this._title;
  }

  /** Artist of the currently playing song. */
  get artist(): string | null {
    return this._artist;
  }

  /** Album of the currently playing song. */
  get album(): string | null {
    return this._album;
  }

  /** Genre of the currently playing song. */
  get genre(): string | null {
    return this._genre;
  }

  /** Total play time in seconds. */
  get totalTime(): number | null {
    return this._totalTime;
  }

  /** Position in the playing media (seconds). */
  get position(): number | null {
    return this._position;
  }

  /** If shuffle is enabled or not. */
  get shuffle(): ShuffleState | null {
    return this._shuffle;
  }

  /** Repeat mode. */
  get repeat(): RepeatState | null {
    return this._repeat;
  }

  /** Title of TV series. */
  get seriesName(): string | null {
    return this._seriesName;
  }

  /** Season number of TV series. */
  get seasonNumber(): number | null {
    return this._seasonNumber;
  }

  /** Episode number of TV series. */
  get episodeNumber(): number | null {
    return this._episodeNumber;
  }

  /** Content identifier (app specific). */
  get contentIdentifier(): string | null {
    return this._contentIdentifier;
  }

  /** Itunes Store identifier. */
  get itunesStoreIdentifier(): number | null {
    return this._itunesStoreIdentifier;
  }
}

registerCommands(Playing, {
  hash: "Create a unique hash for what is currently playing.",
  mediaType: "Type of media is currently playing, e.g. video, music.",
  deviceState: "Device state, e.g. playing or paused.",
  title: "Title of the current media, e.g. movie or song name.",
  artist: "Artist of the currently playing song.",
  album: "Album of the currently playing song.",
  genre: "Genre of the currently playing song.",
  totalTime: "Total play time in seconds.",
  position: "Position in the playing media (seconds).",
  shuffle: "If shuffle is enabled or not.",
  repeat: "Repeat mode.",
  seriesName: "Title of TV series.",
  seasonNumber: "Season number of TV series.",
  episodeNumber: "Episode number of TV series.",
  contentIdentifier: "Content identifier (app specific).",
  itunesStoreIdentifier: "Itunes Store identifier.",
});

// --- Apps / accounts -----------------------------------------------------------

/** Information about an app. */
export class App {
  constructor(
    private readonly _name: string | null,
    private readonly _identifier: string,
  ) {}

  /** User friendly name of app. */
  get name(): string | null {
    return this._name;
  }

  /** Return a unique bundle id for the app. */
  get identifier(): string {
    return this._identifier;
  }

  toString(): string {
    return `App: ${this.name ?? "None"} (${this.identifier})`;
  }

  equals(other: unknown): boolean {
    return other instanceof App && this.name === other.name && this.identifier === other.identifier;
  }
}

/** Base class for app handling. */
export class Apps {
  /** Fetch a list of apps that can be launched. */
  async appList(): Promise<App[]> {
    throw new NotSupportedError();
  }

  /** Launch an app based on bundle ID or URL. */
  async launchApp(_bundleIdOrUrl: string): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(Apps, {
  appList: "Fetch a list of apps that can be launched.",
  launchApp: "Launch an app based on bundle ID or URL.",
});

/** Information about a user account. */
export class UserAccount {
  constructor(
    private readonly _name: string,
    private readonly _identifier: string,
  ) {}

  /** User name. */
  get name(): string | null {
    return this._name;
  }

  /** Return a unique id for the account. */
  get identifier(): string {
    return this._identifier;
  }

  toString(): string {
    return `Account: ${this.name} (${this.identifier})`;
  }

  equals(other: unknown): boolean {
    return other instanceof UserAccount && this.name === other.name && this.identifier === other.identifier;
  }
}

/** Base class for account handling. */
export class UserAccounts {
  /** Fetch a list of user accounts that can be switched. */
  async accountList(): Promise<UserAccount[]> {
    throw new NotSupportedError();
  }

  /** Switch user account by account ID. */
  async switchAccount(_accountId: string): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(UserAccounts, {
  accountList: "Fetch a list of user accounts that can be switched.",
  switchAccount: "Switch user account by account ID.",
});

// --- Metadata ------------------------------------------------------------------

/** Base class for retrieving metadata from an Apple TV. */
export class Metadata {
  /** Return a unique identifier for current device. */
  get deviceId(): string | null {
    throw new NotSupportedError();
  }

  /**
   * Return artwork for what is currently playing (or null).
   *
   * The parameters "width" and "height" makes it possible to request artwork of a
   * specific size. Set both parameters to null to request default size. Set one of them
   * and let the other one be null to keep original aspect ratio.
   */
  async artwork(_width: number | null = 512, _height: number | null = null): Promise<ArtworkInfo | null> {
    throw new NotSupportedError();
  }

  /** Return a unique identifier for current artwork. */
  get artworkId(): string {
    throw new NotSupportedError();
  }

  /** Return what is currently playing. */
  async playing(): Promise<Playing> {
    throw new NotSupportedError();
  }

  /**
   * Return information about current app playing something.
   *
   * Do note that this property returns which app is currently playing something and
   * not which app is currently active.
   */
  get app(): App | null {
    throw new NotSupportedError();
  }
}

registerCommands(Metadata, {
  deviceId: "Return a unique identifier for current device.",
  artwork: "Return artwork for what is currently playing (or None).",
  artworkId: "Return a unique identifier for current artwork.",
  playing: "Return what is currently playing.",
  app: "Return information about current app playing something.",
});

// --- Push updates ----------------------------------------------------------------

/** Listener interface for push updates. */
export interface PushListener {
  /** Inform about changes to what is currently playing. */
  playstatusUpdate(updater: PushUpdater, playstatus: Playing): void;

  /** Inform about an error when updating play status. */
  playstatusError(updater: PushUpdater, exception: Error): void;
}

/**
 * Base class for push/async updates from an Apple TV.
 *
 * A PushUpdater shall only publish update in case the state actually changes.
 */
export abstract class PushUpdater extends StateProducer<PushListener> {
  /** Return if push updater has been started. */
  abstract get active(): boolean;

  /** Begin to listen to updates. If an error occurs, start must be called again. */
  abstract start(initialDelay?: number): void;

  /** No longer forward updates to listener. */
  abstract stop(): void;
}

// --- Stream ------------------------------------------------------------------------

/**
 * Source used when streaming: a file name/URL, file content, a stream reader, an async
 * iterable/web stream or any object with an async read method (like a file handle).
 */
export type StreamSource =
  | string
  | Uint8Array
  | StreamReader
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>
  | { read(size?: number): Promise<Uint8Array> };

export interface StreamFileOptions {
  metadata?: MediaMetadata | null;
  overrideMissingMetadata?: boolean;
  [key: string]: unknown;
}

/** Base class for stream functionality. */
export class Stream {
  /** Close connection and release allocated resources. */
  close(): void {
    throw new NotSupportedError();
  }

  /** Play media from an URL on the device. */
  async playUrl(_url: string, _options: Record<string, unknown> = {}): Promise<void> {
    throw new NotSupportedError();
  }

  /**
   * Stream local or remote file to device.
   *
   * Supports either local file paths or a HTTP(s) address.
   */
  async streamFile(_file: StreamSource, _options: StreamFileOptions = {}): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(Stream, {
  close: "Close connection and release allocated resources.",
  playUrl: "Play media from an URL on the device.",
  streamFile: "Stream local or remote file to device.",
});

// --- Listeners ---------------------------------------------------------------------

/** Listener interface for generic device updates. */
export interface DeviceListener {
  /** Device was unexpectedly disconnected. */
  connectionLost(exception: Error): void;

  /** Device connection was (intentionally) closed. */
  connectionClosed(): void;
}

/** Listener interface for power updates. */
export interface PowerListener {
  /** Device power state was updated. */
  powerstateUpdate(oldState: PowerState, newState: PowerState): void;
}

// --- Power ---------------------------------------------------------------------------

/** Base class for retrieving power state from an Apple TV. */
export class Power extends StateProducer<PowerListener> {
  /** Return device power state. */
  get powerState(): PowerState {
    throw new NotSupportedError();
  }

  /** Turn device on. */
  async turnOn(_awaitNewState = false): Promise<void> {
    throw new NotSupportedError();
  }

  /** Turn device off. */
  async turnOff(_awaitNewState = false): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(Power, {
  powerState: "Return device power state.",
  turnOn: "Turn device on.",
  turnOff: "Turn device off.",
});

// --- DeviceInfo ----------------------------------------------------------------------

/** General information about device. */
export class DeviceInfo {
  static readonly OPERATING_SYSTEM = "os";
  static readonly VERSION = "version";
  static readonly BUILD_NUMBER = "build_number";
  static readonly MODEL = "model";
  static readonly RAW_MODEL = "raw_model";
  static readonly MAC = "mac";
  static readonly OUTPUT_DEVICE_ID = "airplay_id";

  private readonly _devinfo: Record<string, any>;
  private readonly _os: OperatingSystem;
  private readonly _version: string | null;
  private readonly _buildNumber: string | null;
  private readonly _model: DeviceModel;
  private readonly _mac: string | null;
  private readonly _outputDeviceId: string | null;

  constructor(deviceInfo: Record<string, any>) {
    this._devinfo = deviceInfo;
    this._os = this._popWithType(DeviceInfo.OPERATING_SYSTEM, OperatingSystem.Unknown, OperatingSystem);
    this._version = this._popWithType(DeviceInfo.VERSION, null, "string");
    this._buildNumber = this._popWithType(DeviceInfo.BUILD_NUMBER, null, "string");
    this._model = this._popWithType(DeviceInfo.MODEL, DeviceModel.Unknown, DeviceModel);
    this._mac = this._popWithType(DeviceInfo.MAC, null, "string");
    this._outputDeviceId = this._popWithType(DeviceInfo.OUTPUT_DEVICE_ID, null, "string");
  }

  private _popWithType(field: string, defaultValue: any, expectedType: "string" | object): any {
    const value = field in this._devinfo ? this._devinfo[field] : defaultValue;
    delete this._devinfo[field];
    if (value === null || value === undefined) return value ?? null;
    if (expectedType === "string") {
      if (typeof value === "string") return value;
    } else if (typeof value === "number" && Object.values(expectedType).includes(value)) {
      return value;
    }
    throw new TypeError(
      `expected ${expectedType === "string" ? "str" : "enum"} for '${field}'' but got ${typeof value}`,
    );
  }

  /** Operating system running on device. */
  get operatingSystem(): OperatingSystem {
    if (this._os !== OperatingSystem.Unknown) return this._os;

    if ([DeviceModel.AirPortExpress, DeviceModel.AirPortExpressGen2].includes(this.model)) {
      return OperatingSystem.AirPortOS;
    }
    if (
      [DeviceModel.HomePod, DeviceModel.HomePodMini, DeviceModel.HomePodGen2, DeviceModel.HomePodMiniGen2].includes(
        this.model,
      )
    ) {
      return OperatingSystem.TvOS;
    }
    if (
      [
        DeviceModel.Gen2,
        DeviceModel.Gen3,
        DeviceModel.Gen4,
        DeviceModel.Gen4K,
        DeviceModel.AppleTV4KGen2,
        DeviceModel.AppleTV4KGen3,
      ].includes(this.model)
    ) {
      return OperatingSystem.TvOS;
    }
    return OperatingSystem.Unknown;
  }

  /** Operating system version. */
  get version(): string | null {
    if (this._version) return this._version;
    const version = lookupVersion(this.buildNumber);
    if (version) return version;
    return this._version;
  }

  /** Operating system build number, e.g. 17K795. */
  get buildNumber(): string | null {
    return this._buildNumber;
  }

  /** Hardware model name, e.g. 3, 4 or 4K. */
  get model(): DeviceModel {
    return this._model;
  }

  /** Return raw model description. */
  get rawModel(): string | null {
    return this._devinfo[DeviceInfo.RAW_MODEL] ?? null;
  }

  /** Return model name as string (falls back to raw_model). */
  get modelStr(): string {
    return this.model === DeviceModel.Unknown && this.rawModel ? this.rawModel : convert.modelStr(this.model);
  }

  /** Device MAC address. */
  get mac(): string | null {
    return this._mac;
  }

  /** Output device identifier. */
  get outputDeviceId(): string | null {
    return this._outputDeviceId;
  }

  toString(): string {
    const osNames: Partial<Record<OperatingSystem, string>> = {
      [OperatingSystem.Legacy]: "ATV SW",
      [OperatingSystem.TvOS]: "tvOS",
      [OperatingSystem.AirPortOS]: "AirPortOS",
      [OperatingSystem.MacOS]: "MacOS",
    };
    let output = this.modelStr + ", " + (osNames[this.operatingSystem] ?? "Unknown OS");
    if (this.version) output += " " + this.version;
    if (this.buildNumber) output += " build " + this.buildNumber;
    return output;
  }
}

registerCommands(DeviceInfo, {
  operatingSystem: "Operating system running on device.",
  version: "Operating system version.",
  buildNumber: "Operating system build number, e.g. 17K795.",
  model: "Hardware model name, e.g. 3, 4 or 4K.",
  rawModel: "Return raw model description.",
  modelStr: "Return model name as string.",
  mac: "Device MAC address.",
  outputDeviceId: "Output device identifier.",
});

// --- Features ------------------------------------------------------------------------

/** All feature names (numeric enum values). */
export const ALL_FEATURE_NAMES: FeatureName[] = Object.values(FeatureName).filter(
  (v): v is FeatureName => typeof v === "number",
);

/** Base class for supported feature functionality. */
export class Features {
  /** Return current state of a feature. */
  getFeature(_featureName: FeatureName): FeatureInfo {
    throw new NotImplementedError();
  }

  /** Return state of all features. */
  allFeatures(includeUnsupported = false): Map<FeatureName, FeatureInfo> {
    const features = new Map<FeatureName, FeatureInfo>();
    for (const name of ALL_FEATURE_NAMES) {
      const info = this.getFeature(name);
      if (info.state !== FeatureState.Unsupported || includeUnsupported) {
        features.set(name, info);
      }
    }
    return features;
  }

  /**
   * Return if features are in a specific state.
   *
   * Returns true if all given features are in the state specified by "states". If
   * "states" is a list of states, it is enough for the feature to be in one of them.
   */
  inState(states: FeatureState[] | FeatureState, ...featureNames: FeatureName[]): boolean {
    const expected = Array.isArray(states) ? states : [states];
    for (const name of featureNames) {
      if (!expected.includes(this.getFeature(name).state)) return false;
    }
    return true;
  }
}

// --- Audio ---------------------------------------------------------------------------

/** Information about an output device. */
export class OutputDevice {
  constructor(
    public identifier: string,
    public name: string | null = null,
    public volume = 0.0,
  ) {}

  toString(): string {
    return `Device: ${this.name ?? "None"} (${this.identifier})`;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof OutputDevice &&
      this.name === other.name &&
      this.identifier === other.identifier &&
      this.volume === other.volume
    );
  }
}

/** Listener interface for audio updates. */
export interface AudioListener {
  /** Device volume was updated. */
  volumeUpdate(oldLevel: number, newLevel: number): void;

  /** Output device volume was updated. */
  volumeDeviceUpdate(outputDevice: OutputDevice, oldLevel: number, newLevel: number): void;

  /** Output devices were updated. */
  outputdevicesUpdate(oldDevices: OutputDevice[], newDevices: OutputDevice[]): void;
}

/**
 * Base class for audio functionality.
 *
 * Volume level is managed in percent where 0 is muted and 100 is max volume.
 */
export class Audio extends StateProducer<AudioListener> {
  /** Return current volume level (range is in percent, i.e. [0.0-100.0]). */
  get volume(): number {
    throw new NotSupportedError();
  }

  /** Change current volume level (range is in percent, i.e. [0.0-100.0]). */
  async setVolume(_level: number, _outputDevice: OutputDevice | null = null): Promise<void> {
    throw new NotSupportedError();
  }

  /** Increase volume by one step. */
  async volumeUp(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Decrease volume by one step. */
  async volumeDown(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Return current list of output device IDs. */
  get outputDevices(): OutputDevice[] {
    throw new NotSupportedError();
  }

  /** Add output devices. */
  async addOutputDevices(..._devices: string[]): Promise<void> {
    throw new NotSupportedError();
  }

  /** Remove output devices. */
  async removeOutputDevices(..._devices: string[]): Promise<void> {
    throw new NotSupportedError();
  }

  /** Set output devices. */
  async setOutputDevices(..._devices: string[]): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(Audio, {
  volume: "Return current volume level.",
  setVolume: "Change current volume level.",
  volumeUp: "Increase volume by one step.",
  volumeDown: "Decrease volume by one step.",
  outputDevices: "Return current list of output device IDs.",
  addOutputDevices: "Add output devices.",
  removeOutputDevices: "Remove output devices.",
  setOutputDevices: "Set output devices.",
});

// --- Keyboard ------------------------------------------------------------------------

/** Listener interface for keyboard updates. */
export interface KeyboardListener {
  /** Keyboard focus state was updated. */
  focusstateUpdate(oldState: KeyboardFocusState, newState: KeyboardFocusState): void;
}

/** Base class for keyboard handling. */
export class Keyboard extends StateProducer<KeyboardListener> {
  /** Return keyboard focus state. */
  get textFocusState(): KeyboardFocusState {
    throw new NotSupportedError();
  }

  /** Get current virtual keyboard text. */
  async textGet(): Promise<string | null> {
    throw new NotSupportedError();
  }

  /** Clear virtual keyboard text. */
  async textClear(): Promise<void> {
    throw new NotSupportedError();
  }

  /** Input text into virtual keyboard. */
  async textAppend(_text: string): Promise<void> {
    throw new NotSupportedError();
  }

  /** Replace text in virtual keyboard. */
  async textSet(_text: string): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(Keyboard, {
  textFocusState: "Return keyboard focus state.",
  textGet: "Get current virtual keyboard text.",
  textClear: "Clear virtual keyboard text.",
  textAppend: "Input text into virtual keyboard.",
  textSet: "Replace text in virtual keyboard.",
});

// --- Touch ----------------------------------------------------------------------------

/** Base class for touch gestures. */
export class TouchGestures {
  /** Generate a swipe gesture from start to end x,y coordinates (range [0,1000]). */
  async swipe(_startX: number, _startY: number, _endX: number, _endY: number, _durationMs: number): Promise<void> {
    throw new NotSupportedError();
  }

  /** Generate a touch event to x,y coordinates (in range [0,1000]). */
  async action(_x: number, _y: number, _mode: TouchAction): Promise<void> {
    throw new NotSupportedError();
  }

  /** Send a touch click. */
  async click(_action: InputAction): Promise<void> {
    throw new NotSupportedError();
  }
}

registerCommands(TouchGestures, {
  swipe: "Generate a swipe gesture.",
  action: "Generate a touch event to x,y coordinates (in range [0,1000]).",
  click: "Send a touch click.",
});

// --- Configuration ----------------------------------------------------------------------

/**
 * Representation of a device configuration.
 *
 * An instance of this class represents a single device. A device can have several
 * services depending on the protocols it supports, e.g. DMAP or AirPlay.
 */
export abstract class BaseConfig {
  constructor(protected _properties: Record<string, Properties>) {}

  /** IP address of device. */
  abstract get address(): string;

  /** Name of device. */
  abstract get name(): string;

  /** If device is in deep sleep. */
  abstract get deepSleep(): boolean;

  /** Return all supported services. */
  abstract get services(): BaseService[];

  /** Return general device information. */
  abstract get deviceInfo(): DeviceInfo;

  /** Add a new service. If the service already exists, it will be merged. */
  abstract addService(service: BaseService): void;

  /** Look up a service based on protocol (null if not available). */
  abstract getService(protocol: Protocol): BaseService | null;

  /** Return Zeroconf properties. */
  get properties(): Record<string, Properties> {
    return this._properties;
  }

  /** Return if configuration is ready, (at least one service with identifier). */
  get ready(): boolean {
    return this.services.some((service) => Boolean(service.identifier));
  }

  /** Return the main identifier associated with this device. */
  get identifier(): string | null {
    for (const prot of [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay, Protocol.RAOP, Protocol.Companion]) {
      const service = this.getService(prot);
      if (service && service.identifier !== null) return service.identifier;
    }
    return null;
  }

  /** Return all unique identifiers for this device. */
  get allIdentifiers(): string[] {
    return this.services.map((x) => x.identifier).filter((x): x is string => x !== null);
  }

  /** Return suggested service used to establish connection. */
  mainService(protocol: Protocol | null = null): BaseService {
    const protocols =
      protocol !== null ? [protocol] : [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay, Protocol.RAOP];
    for (const prot of protocols) {
      const service = this.getService(prot);
      if (service !== null) return service;
    }
    throw new NoServiceError("no service to connect to");
  }

  /** Set credentials for a protocol if it exists. */
  setCredentials(protocol: Protocol, credentials: string): boolean {
    const service = this.getService(protocol);
    if (service) {
      service.credentials = credentials;
      return true;
    }
    return false;
  }

  /** Apply settings to configuration. */
  apply(settings: Settings): void {
    for (const service of this.services) {
      switch (service.protocol) {
        case Protocol.AirPlay:
          service.apply(settings.protocols.airplay.toDict());
          break;
        case Protocol.Companion:
          service.apply(settings.protocols.companion.toDict());
          break;
        case Protocol.DMAP:
          service.apply(settings.protocols.dmap.toDict());
          break;
        case Protocol.MRP:
          service.apply(settings.protocols.mrp.toDict());
          break;
        case Protocol.RAOP:
          service.apply(settings.protocols.raop.toDict());
          break;
      }
    }
  }

  /** Compare instance with another instance. */
  equals(other: unknown): boolean {
    return other instanceof this.constructor && (other as BaseConfig).identifier === this.identifier;
  }

  toString(): string {
    const deviceInfo = this.deviceInfo;
    const services = this.services.map((s) => ` - ${s}`).join("\n");
    const identifiers = this.allIdentifiers.map((x) => ` - ${x}`).join("\n");
    return (
      `       Name: ${this.name}\n` +
      `   Model/SW: ${deviceInfo}\n` +
      `    Address: ${this.address}\n` +
      `        MAC: ${deviceInfo.mac ?? "None"}\n` +
      ` Deep Sleep: ${this.deepSleep ? "True" : "False"}\n` +
      `Identifiers:\n` +
      `${identifiers}\n` +
      `Services:\n` +
      `${services}`
    );
  }

  /** Return deep-copy of instance. */
  abstract deepcopy(): BaseConfig;
}

// --- Storage ------------------------------------------------------------------------------

/** Base class for storage modules. */
export abstract class Storage {
  /** Return settings for all devices. */
  abstract get settings(): Settings[];

  /** Save settings to active storage. */
  abstract save(): Promise<void>;

  /** Load settings from active storage. */
  abstract load(): Promise<void>;

  /**
   * Return settings for a specific configuration (device).
   *
   * If no settings exists for the current configuration, new settings are created
   * automatically and returned. If the configuration does not contain any valid
   * identifiers, DeviceIdMissingError will be raised.
   */
  abstract getSettings(config: BaseConfig): Promise<Settings>;

  /** Remove settings from storage. Returns true if settings were removed. */
  abstract removeSettings(settings: Settings): Promise<boolean>;

  /** Update settings based on config. */
  abstract updateSettings(config: BaseConfig): Promise<void>;
}

// --- AppleTV ----------------------------------------------------------------------------

/** Base class representing an Apple TV. */
export abstract class AppleTV extends StateProducer<DeviceListener> {
  /** Initiate connection to device. No need to call it yourself, it's done automatically. */
  abstract connect(): Promise<void>;

  /** Close connection and release allocated resources. */
  abstract close(): Set<Promise<unknown>>;

  /** Return device settings used by pyatv. */
  abstract get settings(): Settings;

  /** Return API for device information. */
  abstract get deviceInfo(): DeviceInfo;

  /** Return service used to connect to the Apple TV. */
  abstract get service(): BaseService;

  /** Return API for controlling the Apple TV. */
  abstract get remoteControl(): RemoteControl;

  /** Return API for retrieving metadata from the Apple TV. */
  abstract get metadata(): Metadata;

  /** Return API for handling push update from the Apple TV. */
  abstract get pushUpdater(): PushUpdater;

  /** Return API for streaming media. */
  abstract get stream(): Stream;

  /** Return API for power management. */
  abstract get power(): Power;

  /** Return features interface. */
  abstract get features(): Features;

  /** Return apps interface. */
  abstract get apps(): Apps;

  /** Return user accounts interface. */
  abstract get userAccounts(): UserAccounts;

  /** Return audio interface. */
  abstract get audio(): Audio;

  /** Return keyboard interface. */
  abstract get keyboard(): Keyboard;

  /** Return touch gestures interface. */
  abstract get touch(): TouchGestures;
}
