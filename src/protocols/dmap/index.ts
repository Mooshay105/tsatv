/** Implementation of the DMAP protocol used by ATV 1, 2 and 3. */

import {
  DeviceModel,
  DeviceState,
  FeatureName,
  FeatureState,
  InputAction,
  MediaType,
  OperatingSystem,
  PairingRequirement,
  Protocol,
  RepeatState,
  ShuffleState,
} from "../../const.ts";
import { AbstractPushUpdater, type Core, MutableService, type ProtocolStateDispatcher, type SetupData } from "../../core/index.ts";
import * as mdns from "../../core/mdns.ts";
import type { ScanHandlerDeviceInfoName, ScanHandlerReturn } from "../../core/scan.ts";
import { NoAsyncListenerError } from "../../exceptions.ts";
import { getUniqueId } from "../../helpers.ts";
import {
  ArtworkInfo,
  Audio,
  type BaseConfig,
  type BaseService,
  DeviceInfo,
  FeatureInfo,
  Features,
  Metadata,
  type PairingHandler,
  Playing,
  PushUpdater,
  RemoteControl,
} from "../../interface.ts";
import { CancelledError, createTask, sleep, type Task } from "../../support/asyncio.ts";
import { Cache } from "../../support/cache.ts";
import { dictMerge } from "../../support/collections.ts";
import { HttpSession } from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import { registerProtocol } from "../index.ts";
import * as daap from "./daap.ts";
import { DaapRequester } from "./daap.ts";
import { DmapPairingHandler } from "./pairing.ts";
import * as parser from "./parser.ts";
import * as tags from "./tags.ts";

const LOGGER = getLogger("pyatv.protocols.dmap");

// Skip forward/backwards isn't supported by the protocol so it is simulated by seeking
// this many seconds forward/backwards in time
const DEFAULT_SKIP_TIME = 10;

const PSU_CMD = (revision: number) => `ctrl-int/1/playstatusupdate?[AUTH]&revision-number=${revision}`;
const ARTWORK_CMD = (width: number, height: number) => `ctrl-int/1/nowplayingartwork?mw=${width}&mh=${height}&[AUTH]`;
const CTRL_PROMPT_CMD = "ctrl-int/1/controlpromptentry?[AUTH]&prompt-id=0";

// Features that are always considered to be available
const AVAILABLE_FEATURES: FeatureName[] = [
  FeatureName.Down,
  FeatureName.Left,
  FeatureName.Menu,
  FeatureName.Right,
  FeatureName.Select,
  FeatureName.TopMenu,
  FeatureName.Up,
];

// Features that are supported by the device but we don't now if available
const UNKNOWN_FEATURES: FeatureName[] = [
  FeatureName.Artwork,
  FeatureName.Next,
  FeatureName.Pause,
  FeatureName.Play,
  FeatureName.PlayPause,
  FeatureName.Previous,
  FeatureName.SetPosition,
  FeatureName.SetRepeat,
  FeatureName.SetShuffle,
  FeatureName.Stop,
  FeatureName.SkipForward,
  FeatureName.SkipBackward,
];

// Features that are considered available if corresponding field is present
const FIELD_FEATURES = new Map<FeatureName, [string, string]>([
  [FeatureName.Title, ["cmst", "caps"]],
  [FeatureName.Artist, ["cmst", "cann"]],
  [FeatureName.Album, ["cmst", "canl"]],
  [FeatureName.Genre, ["cmst", "cang"]],
  [FeatureName.TotalTime, ["cmst", "cast"]],
  [FeatureName.Position, ["cmst", "cant"]],
  [FeatureName.Shuffle, ["cmst", "cash"]],
  [FeatureName.Repeat, ["cmst", "carp"]],
]);

/** Build a Playing instance from play state. */
export function buildPlayingInstance(playstatus: parser.DmapData): Playing {
  const getTimeInSeconds = (tag: string) => daap.msToS(parser.first(playstatus, "cmst", tag));
  const title = (): string | null => parser.first(playstatus, "cmst", "cann");
  const artist = (): string | null => parser.first(playstatus, "cmst", "cana");
  const album = (): string | null => parser.first(playstatus, "cmst", "canl");
  const genre = (): string | null => parser.first(playstatus, "cmst", "cang");
  const totalTime = (): number => getTimeInSeconds("cast");

  const mediaType = (): MediaType => {
    const state = parser.first(playstatus, "cmst", "caps");
    if (!state) return MediaType.Unknown;

    const mediakind = parser.first(playstatus, "cmst", "cmmk");
    if (mediakind !== null && mediakind !== undefined) return daap.mediaKind(mediakind);

    // Fallback: if artist or album exists we assume music (not present for video)
    if (artist() || album()) return MediaType.Music;
    return MediaType.Video;
  };

  const deviceState = (): DeviceState => daap.playstate(parser.first(playstatus, "cmst", "caps"));

  const position = (): number | null => {
    const total = totalTime();
    const remainingTime = getTimeInSeconds("cant");
    if (!total || !remainingTime) return null;
    return total - remainingTime;
  };

  const shuffle = (): ShuffleState => {
    const state = parser.first(playstatus, "cmst", "cash");
    if (state === null || state === undefined || state === 0) return ShuffleState.Off;
    // DMAP does not support the "albums" state and will always report "songs" if
    // shuffle is active
    return ShuffleState.Songs;
  };

  const repeat = (): RepeatState => {
    const state = parser.first(playstatus, "cmst", "carp");
    if (state === null || state === undefined) return RepeatState.Off;
    if (!(state in RepeatState)) throw new RangeError(`${state} is not a valid RepeatState`);
    return state as RepeatState;
  };

  return new Playing({
    mediaType: mediaType(),
    deviceState: deviceState(),
    title: title(),
    artist: artist(),
    album: album(),
    genre: genre(),
    totalTime: totalTime(),
    position: position(),
    shuffle: shuffle(),
    repeat: repeat(),
  });
}

/** Common protocol logic used to interact with an Apple TV. */
export class BaseDmapAppleTV {
  playstatusRevision = 0;
  latestPlaystatus: parser.DmapData | null = null;
  latestPlaying: Playing | null = null;
  latestHash: string | null = null;

  constructor(readonly daap: DaapRequester) {}

  /**
   * Request raw data about what is currently playing.
   *
   * If useRevision=true, this command will "block" until playstatus changes on the
   * device. Must be logged in.
   */
  async playstatus(useRevision = false, timeout: number | null = null, signal?: AbortSignal): Promise<Playing> {
    const cmdUrl = PSU_CMD(useRevision ? this.playstatusRevision : 0);
    const resp = await this.daap.get(cmdUrl, { timeout, signal });
    this.playstatusRevision = parser.first(resp, "cmst", "cmsr");
    this.latestPlaystatus = resp;
    this.latestPlaying = buildPlayingInstance(resp);
    this.latestHash = this.latestPlaying.hash;
    return this.latestPlaying;
  }

  /** Return artwork for what is currently playing (or null). */
  async artwork(width: number | null, height: number | null): Promise<Buffer | null> {
    const url = ARTWORK_CMD(width || 0, height || 0);
    const art: Buffer = await this.daap.get(url, { daapData: false });
    return art.length > 0 ? art : null;
  }

  /** Perform a "ctrl-int" command. */
  ctrlIntCmd(cmd: string): Promise<unknown> {
    return this.daap.post(`ctrl-int/1/${cmd}?[AUTH]&prompt-id=0`);
  }

  /** Perform a "controlpromptentry" command. */
  controlpromptCmd(cmd: string): Promise<unknown> {
    const data = Buffer.concat([tags.stringTag("cmbe", cmd), tags.uint8Tag("cmcc", 0)]);
    return this.daap.post(CTRL_PROMPT_CMD, data);
  }

  /** Perform a "controlpromptentry" command with raw data. */
  controlpromptData(data: Uint8Array): Promise<unknown> {
    return this.daap.post(CTRL_PROMPT_CMD, data);
  }

  /** Change value of a DAAP property, e.g. volume or media position. */
  setProperty(prop: string, value: number | string): Promise<unknown> {
    return this.daap.post(`ctrl-int/1/setproperty?${prop}=${value}&[AUTH]`);
  }
}

/** Implementation of API for controlling an Apple TV. */
export class DmapRemoteControl extends RemoteControl {
  constructor(readonly appleTv: BaseDmapAppleTV) {
    super();
  }

  override async up(_action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._sendCommands(
      DmapRemoteControl._move("Down", 0, 20, 275),
      DmapRemoteControl._move("Move", 1, 20, 270),
      DmapRemoteControl._move("Move", 2, 20, 265),
      DmapRemoteControl._move("Move", 3, 20, 260),
      DmapRemoteControl._move("Move", 4, 20, 255),
      DmapRemoteControl._move("Move", 5, 20, 250),
      DmapRemoteControl._move("Up", 6, 20, 250),
    );
  }

  override async down(_action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._sendCommands(
      DmapRemoteControl._move("Down", 0, 20, 250),
      DmapRemoteControl._move("Move", 1, 20, 255),
      DmapRemoteControl._move("Move", 2, 20, 260),
      DmapRemoteControl._move("Move", 3, 20, 265),
      DmapRemoteControl._move("Move", 4, 20, 270),
      DmapRemoteControl._move("Move", 5, 20, 275),
      DmapRemoteControl._move("Up", 6, 20, 275),
    );
  }

  override async left(_action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._sendCommands(
      DmapRemoteControl._move("Down", 0, 75, 100),
      DmapRemoteControl._move("Move", 1, 70, 100),
      DmapRemoteControl._move("Move", 3, 65, 100),
      DmapRemoteControl._move("Move", 4, 60, 100),
      DmapRemoteControl._move("Move", 5, 55, 100),
      DmapRemoteControl._move("Move", 6, 50, 100),
      DmapRemoteControl._move("Up", 7, 50, 100),
    );
  }

  override async right(_action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._sendCommands(
      DmapRemoteControl._move("Down", 0, 50, 100),
      DmapRemoteControl._move("Move", 1, 55, 100),
      DmapRemoteControl._move("Move", 3, 60, 100),
      DmapRemoteControl._move("Move", 4, 65, 100),
      DmapRemoteControl._move("Move", 5, 70, 100),
      DmapRemoteControl._move("Move", 6, 75, 100),
      DmapRemoteControl._move("Up", 7, 75, 100),
    );
  }

  private static _move(direction: string, time: number, point1: number, point2: number): Buffer {
    const data = `touch${direction}&time=${time}&point=${point1},${point2}`;
    return Buffer.concat([tags.uint8Tag("cmcc", 0x30), tags.stringTag("cmbe", data)]);
  }

  private async _sendCommands(...cmds: Buffer[]): Promise<void> {
    for (const cmd of cmds) await this.appleTv.controlpromptData(cmd);
  }

  override async play(): Promise<void> {
    await this.appleTv.ctrlIntCmd("play");
  }

  override async playPause(): Promise<void> {
    await this.appleTv.ctrlIntCmd("playpause");
  }

  override async pause(): Promise<void> {
    await this.appleTv.ctrlIntCmd("pause");
  }

  override async stop(): Promise<void> {
    await this.appleTv.ctrlIntCmd("stop");
  }

  override async next(): Promise<void> {
    await this.appleTv.ctrlIntCmd("nextitem");
  }

  override async previous(): Promise<void> {
    await this.appleTv.ctrlIntCmd("previtem");
  }

  override async select(_action: InputAction = InputAction.SingleTap): Promise<void> {
    await this.appleTv.controlpromptCmd("select");
  }

  override async menu(_action: InputAction = InputAction.SingleTap): Promise<void> {
    await this.appleTv.controlpromptCmd("menu");
  }

  override async topMenu(): Promise<void> {
    await this.appleTv.controlpromptCmd("topmenu");
  }

  override async volumeUp(): Promise<void> {
    await this.appleTv.ctrlIntCmd("volumeup");
  }

  override async volumeDown(): Promise<void> {
    await this.appleTv.ctrlIntCmd("volumedown");
  }

  override async skipForward(timeInterval = 0.0): Promise<void> {
    const currentPosition = (await this.appleTv.playstatus()).position;
    if (currentPosition) {
      await this.setPosition(currentPosition + (timeInterval > 0 ? Math.trunc(timeInterval) : DEFAULT_SKIP_TIME));
    }
  }

  override async skipBackward(timeInterval = 0.0): Promise<void> {
    const currentPosition = (await this.appleTv.playstatus()).position;
    if (currentPosition) {
      await this.setPosition(currentPosition - (timeInterval > 0 ? Math.trunc(timeInterval) : DEFAULT_SKIP_TIME));
    }
  }

  override async setPosition(pos: number): Promise<void> {
    const timeInMs = Math.trunc(pos) * 1000;
    await this.appleTv.setProperty("dacp.playingtime", timeInMs);
  }

  override async setShuffle(shuffleState: ShuffleState): Promise<void> {
    const state = shuffleState === ShuffleState.Off ? 0 : 1;
    await this.appleTv.setProperty("dacp.shufflestate", state);
  }

  override async setRepeat(repeatState: RepeatState): Promise<void> {
    await this.appleTv.setProperty("dacp.repeatstate", repeatState);
  }
}

/** Implementation of API for retrieving metadata from an Apple TV. */
export class DmapMetadata extends Metadata {
  readonly artworkCache = new Cache<string, ArtworkInfo>(4);

  constructor(
    readonly identifier: string | null,
    readonly appleTv: BaseDmapAppleTV,
  ) {
    super();
  }

  override get deviceId(): string | null {
    return this.identifier;
  }

  override async artwork(width: number | null = 512, height: number | null = null): Promise<ArtworkInfo | null> {
    // Having to fetch "playing" here is not ideal, but an identifier is needed and we
    // cannot trust any previous identifiers.
    const playing = await this.playing();
    const identifier = playing.hash;
    if (this.artworkCache.has(identifier)) {
      LOGGER.debug("Retrieved artwork %s from cache", identifier);
      return this.artworkCache.get(identifier);
    }

    LOGGER.debug("Fetching artwork");
    const artwork = await this.appleTv.artwork(width, height);
    if (artwork) {
      const info = new ArtworkInfo(artwork, "image/png", -1, -1);
      this.artworkCache.put(identifier, info);
      return info;
    }
    return null;
  }

  override get artworkId(): string {
    return this.appleTv.latestHash as string;
  }

  override async playing(): Promise<Playing> {
    return this.appleTv.playstatus();
  }
}

function isClientError(ex: unknown): boolean {
  const code = (ex as { code?: unknown })?.code;
  return typeof code === "string";
}

/** Implementation of API for handling push update from an Apple TV. */
export class DmapPushUpdater extends AbstractPushUpdater {
  private readonly _deviceListenerRef: WeakRef<any>;
  private _future: Task<void> | null = null;
  private _initialDelay = 0;

  constructor(
    private readonly _atv: BaseDmapAppleTV,
    stateDispatcher: ProtocolStateDispatcher,
    listener: object,
  ) {
    super(stateDispatcher);
    this._deviceListenerRef = new WeakRef(listener);
  }

  get active(): boolean {
    return this._future !== null;
  }

  /** Wait for push updates from device. */
  start(initialDelay = 0): void {
    if (this.listener === null) throw new NoAsyncListenerError();
    if (this.active) return;

    // Always start with 0 to trigger an immediate response for the first request
    this._atv.playstatusRevision = 0;

    // Delay before restarting after an error
    this._initialDelay = initialDelay;

    const task = createTask((signal) => this._poller(signal));
    this._future = task;
    task.promise.catch(() => undefined);
  }

  /** No longer forward updates to listener. */
  stop(): void {
    if (this._future !== null) {
      this._future.cancel();
      this._future = null;
    }
  }

  private async _poller(signal: AbortSignal): Promise<void> {
    let firstCall = true;
    const self = this._future;

    while (!signal.aborted) {
      try {
        // Sleep some time before waiting for updates
        if (!firstCall && this._initialDelay > 0) {
          LOGGER.debug("Initial delay set to %d", this._initialDelay);
          await sleep(this._initialDelay);
          firstCall = false;
        }

        LOGGER.debug("Waiting for playstatus updates");
        const playstatus = await this._atv.playstatus(true, 0, signal);
        if (signal.aborted) break;

        this.postUpdate(playstatus);
      } catch (ex) {
        if (ex instanceof CancelledError || signal.aborted) break;

        if (isClientError(ex)) {
          LOGGER.error("A communication error happened: %s", ex);
          const listener = this._deviceListenerRef.deref();
          if (listener) {
            const callback = listener.listener.connectionLost;
            queueMicrotask(() => callback(ex));
          }
          break;
        }

        // We must catch _all_ exceptions to keep the API.
        LOGGER.debug("Playstatus error occurred: %s", ex);
        this._atv.playstatusRevision = 0;
        const callback = this.listener.playstatusError;
        queueMicrotask(() => callback(this, ex as Error));
      }
    }

    if (this._future === self) this._future = null;
  }
}

/** Implementation of API for supported feature functionality. */
export class DmapFeatures extends Features {
  constructor(
    readonly config: BaseConfig,
    readonly appleTv: BaseDmapAppleTV,
  ) {
    super();
  }

  override getFeature(featureName: FeatureName): FeatureInfo {
    if (AVAILABLE_FEATURES.includes(featureName)) return new FeatureInfo(FeatureState.Available);
    if (UNKNOWN_FEATURES.includes(featureName)) return new FeatureInfo(FeatureState.Unknown);
    const field = FIELD_FEATURES.get(featureName);
    if (field) return new FeatureInfo(this._isAvailable(field));
    if (featureName === FeatureName.VolumeUp || featureName === FeatureName.VolumeDown) {
      return new FeatureInfo(this._isAvailable(["cmst", "cavc"], true));
    }
    return new FeatureInfo(FeatureState.Unsupported);
  }

  private _isAvailable(field: [string, string], expectedValue: unknown = null): FeatureState {
    if (this.appleTv.latestPlaystatus) {
      const value = parser.first(this.appleTv.latestPlaystatus, ...field);
      if (value !== null && value !== undefined) {
        if (!expectedValue || expectedValue === value) return FeatureState.Available;
      }
    }
    return FeatureState.Unavailable;
  }
}

/** Implementation of API for audio functionality. */
export class DmapAudio extends Audio {
  constructor(readonly appleTv: BaseDmapAppleTV) {
    super();
  }

  override async volumeUp(): Promise<void> {
    await this.appleTv.ctrlIntCmd("volumeup");
  }

  override async volumeDown(): Promise<void> {
    await this.appleTv.ctrlIntCmd("volumedown");
  }
}

/** Parse and return a new DMAP (Home Sharing) service. */
export function homesharingServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn {
  const name = mdns.getProperty(mdnsService.properties, "Name") ?? "Unknown";
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties as any),
    Protocol.DMAP,
    mdnsService.port,
    mdnsService.properties as any,
  );
  service.credentials = mdns.getProperty(mdnsService.properties, "hG") ?? null;
  return [name, service];
}

/** Parse and return a new DMAP service. */
export function dmapServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn {
  const name = mdns.getProperty(mdnsService.properties, "CtlN") ?? "Unknown";
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties as any),
    Protocol.DMAP,
    mdnsService.port,
    mdnsService.properties as any,
  );
  return [name, service];
}

/** Parse and return a new HSCP service. */
export function hscpServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn {
  const name = mdns.getProperty(mdnsService.properties, "Machine Name") ?? "Unknown";
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties as any),
    Protocol.DMAP,
    mdnsService.port,
    mdnsService.properties as any,
  );
  service.credentials = mdns.getProperty(mdnsService.properties, "hG") ?? null;
  return [name, service];
}

/** Return handlers used for scanning. */
export function scan(): Record<string, ScanHandlerDeviceInfoName> {
  return {
    "_appletv-v2._tcp.local": [homesharingServiceHandler, () => null],
    "_touch-able._tcp.local": [dmapServiceHandler, () => null],
    "_hscp._tcp.local": [hscpServiceHandler, () => null],
  };
}

/** Return device information from zeroconf properties. */
export function deviceInfo(serviceType: string, _properties: unknown): Record<string, unknown> {
  const devinfo: Record<string, unknown> = {};

  // Like with MRP, this is also border line OK, but will do for now
  devinfo[DeviceInfo.OPERATING_SYSTEM] = OperatingSystem.Legacy;

  if (serviceType === "_hscp._tcp.local") devinfo[DeviceInfo.MODEL] = DeviceModel.Music;

  return devinfo;
}

/**
 * Update service with additional information.
 *
 * If Home Sharing is enabled, then the "hG" property is present and can be used as
 * credentials. If not enabled, then pairing must be performed.
 */
export async function serviceInfo(
  service: MutableService,
  _devinfo: DeviceInfo,
  _services: Map<Protocol, BaseService>,
): Promise<void> {
  const hasHg = Object.keys(service.properties).some((k) => k.toLowerCase() === "hg");
  service.pairing = hasHg ? PairingRequirement.Optional : PairingRequirement.Mandatory;
}

/** Set up a new DMAP service. */
export function* setup(core: Core): Generator<SetupData> {
  const daapHttp = new HttpSession(core.sessionManager.session, `http://${core.config.address}:${core.service.port}/`);
  const requester = new DaapRequester(daapHttp, core.service.credentials);
  const appleTv = new BaseDmapAppleTV(requester);
  const pushUpdater = new DmapPushUpdater(appleTv, core.stateDispatcher, core.deviceListener);
  const metadata = new DmapMetadata(core.config.identifier, appleTv);
  const audio = new DmapAudio(appleTv);

  const interfaces = new Map<unknown, unknown>([
    [RemoteControl, new DmapRemoteControl(appleTv)],
    [Metadata, metadata],
    [PushUpdater, pushUpdater],
    [Features, new DmapFeatures(core.config, appleTv)],
    [Audio, audio],
  ]);

  const connect = async (): Promise<boolean> => {
    await requester.login();
    // Retrieve initial state to have volume control state
    await appleTv.playstatus();
    return true;
  };

  const close = (): Set<Promise<unknown>> => {
    pushUpdater.stop();
    core.deviceListener.listener.connectionClosed();
    return new Set();
  };

  const getDeviceInfo = (): Record<string, unknown> => {
    const devinfo: Record<string, unknown> = {};
    for (const serviceType of Object.keys(scan())) {
      if (serviceType in core.config.properties) {
        dictMerge(devinfo, deviceInfo(serviceType, core.config.properties[serviceType]));
      }
    }
    return devinfo;
  };

  // Features managed by this protocol
  const features = new Set<FeatureName>([
    FeatureName.VolumeDown,
    FeatureName.VolumeUp,
    ...AVAILABLE_FEATURES,
    ...UNKNOWN_FEATURES,
    ...FIELD_FEATURES.keys(),
  ]);

  yield { protocol: Protocol.DMAP, connect, close, deviceInfo: getDeviceInfo, interfaces, features };
}

/** Return pairing handler for protocol. */
export function pair(core: Core, options: Record<string, unknown> = {}): PairingHandler {
  return new DmapPairingHandler(core, options);
}

registerProtocol(Protocol.DMAP, { setup, scan, pair, deviceInfo, serviceInfo });
