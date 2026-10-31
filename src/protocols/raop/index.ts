/** Support for audio streaming using Remote Audio Output Protocol (RAOP). */

import {
  DeviceModel,
  DeviceState,
  FeatureName,
  FeatureState,
  MediaType,
  OperatingSystem,
  PairingRequirement,
  Protocol,
} from "../../const.ts";
import {
  AbstractPushUpdater,
  type Core,
  MutableService,
  type ProtocolStateDispatcher,
  type SetupData,
  type StateMessage,
  UpdatedState,
} from "../../core/index.ts";
import type * as mdns from "../../core/mdns.ts";
import { deviceInfoNameFromUniqueShortName, type ScanHandlerDeviceInfoName, type ScanHandlerReturn } from "../../core/scan.ts";
import { InvalidStateError, NoAsyncListenerError, ProtocolError } from "../../exceptions.ts";
import { getUniqueId } from "../../helpers.ts";
import {
  Audio,
  type BaseService,
  DeviceInfo,
  FeatureInfo,
  Features,
  type MediaMetadata,
  Metadata,
  type OutputDevice,
  type PairingHandler,
  Playing,
  PushUpdater,
  RemoteControl,
  Stream,
  type StreamFileOptions,
  type StreamSource,
} from "../../interface.ts";
import { dictMerge } from "../../support/collections.ts";
import { lookupModel, lookupOs } from "../../support/device_info.ts";
import { type HttpConnection, httpConnect } from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import { mergeInto } from "../../support/metadata.ts";
import { RtspSession } from "../../support/rtsp.ts";
import { extractCredentials } from "../airplay/auth/index.ts";
import { AirPlayPairingHandler } from "../airplay/pairing.ts";
import { AirPlayMajorVersion, dbfsToPct, getProtocolVersion, pctToDbfs, updateServiceDetails } from "../airplay/utils.ts";
import { registerProtocol } from "../index.ts";
import { type AudioSource, openSource } from "./audio_source.ts";
import { AirPlayV1 } from "./protocols/airplayv1.ts";
import { AirPlayV2 } from "./protocols/airplayv2.ts";
import { StreamContext } from "./protocols/index.ts";
import { type PlaybackInfo, type RaopListener, StreamClient } from "./stream_client.ts";

const LOGGER = getLogger("pyatv.protocols.raop");

export const INITIAL_VOLUME = 33.0; // Percent

type Props = Record<string, string> | Map<string, string>;

function prop(properties: Props, key: string): string | undefined {
  if (properties instanceof Map) return properties.get(key);
  return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
}

/** Implementation of push update support for RAOP. */
export class RaopPushUpdater extends AbstractPushUpdater {
  private _activated = false;

  constructor(
    readonly metadata: Metadata,
    stateDispatcher: ProtocolStateDispatcher,
  ) {
    super(stateDispatcher);
  }

  get active(): boolean {
    return this._activated;
  }

  /** Begin to listen to updates. If an error occurs, start must be called again. */
  start(_initialDelay = 0): void {
    if (this.listener === null) throw new NoAsyncListenerError();
    this._activated = true;
    void this.stateUpdated();
  }

  /** No longer forward updates to listener. */
  stop(): void {
    this._activated = false;
  }

  /** State was updated, call listener. */
  async stateUpdated(): Promise<void> {
    try {
      const playing = await this.metadata.playing();
      this.postUpdate(playing);
    } catch (ex) {
      LOGGER.debug("Playstatus error occurred: %s", ex);
    }
  }
}

/** Manage current play state for RAOP. */
export class RaopPlaybackManager {
  playbackInfo: PlaybackInfo | null = null;
  private _isAcquired = false;
  private readonly _context = new StreamContext();
  private _connection: HttpConnection | null = null;
  private _rtsp: RtspSession | null = null;
  private _streamClient: StreamClient | null = null;

  constructor(readonly core: Core) {}

  /** Return RTSP context if a session is active. */
  get context(): StreamContext {
    return this._context;
  }

  /** Return stream client if a session is active. */
  get streamClient(): StreamClient | null {
    return this._streamClient;
  }

  /** Acquire playback manager for playback. */
  acquire(): void {
    if (this._isAcquired) throw new InvalidStateError("already streaming to device");
    this._isAcquired = true;
  }

  /** Set up a session or return active if it exists. */
  async setup(service: BaseService): Promise<[StreamClient, StreamContext]> {
    if (this._streamClient && this._rtsp) return [this._streamClient, this._context];

    this._connection = await httpConnect(this.core.config.address, this.core.service.port);
    this._rtsp = new RtspSession(this._connection);

    const protocolVersion = getProtocolVersion(service, this.core.settings.protocols.raop.protocol_version);
    LOGGER.debug("Using AirPlay version %s", protocolVersion);

    // AirPlay 1 authenticates with the password in ANNOUNCE, AirPlay 2 receivers send a
    // digest challenge to the first RTSP request instead
    if (protocolVersion !== AirPlayMajorVersion.AirPlayV1) this._connection.password = service.password ?? null;

    const protocol =
      protocolVersion === AirPlayMajorVersion.AirPlayV1
        ? new AirPlayV1(this._context, this._rtsp)
        : new AirPlayV2(this._context, this._rtsp);

    this._streamClient = new StreamClient(this._rtsp, this._context, protocol, this.core.settings);
    return [this._streamClient, this._context];
  }

  /** Tear down and disconnect current session. */
  async teardown(): Promise<void> {
    this._streamClient?.close();
    this._connection?.close();
    this._streamClient = null;
    this._context.reset();
    this._rtsp = null;
    this._connection = null;
    this._isAcquired = false;
  }
}

/** Implementation of metadata interface for RAOP. */
export class RaopMetadata extends Metadata {
  constructor(private readonly _playbackManager: RaopPlaybackManager) {
    super();
  }

  /** Return what is currently playing. */
  override async playing(): Promise<Playing> {
    const info = this._playbackManager.playbackInfo;
    if (info === null) return new Playing({ deviceState: DeviceState.Idle, mediaType: MediaType.Unknown });

    const metadata = info.metadata;
    const totalTime = metadata.duration ? Math.trunc(metadata.duration) : null;
    return new Playing({
      deviceState: DeviceState.Playing,
      mediaType: MediaType.Music,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      position: Math.trunc(info.position),
      totalTime,
    });
  }
}

const availability = (value: unknown) => new FeatureInfo(value ? FeatureState.Available : FeatureState.Unavailable);

/** Implementation of supported feature functionality. */
export class RaopFeatures extends Features {
  constructor(readonly playbackManager: RaopPlaybackManager) {
    super();
  }

  /** Return current state of a feature. */
  override getFeature(featureName: FeatureName): FeatureInfo {
    if (featureName === FeatureName.StreamFile) return new FeatureInfo(FeatureState.Available);

    const metadata = this.playbackManager.playbackInfo?.metadata ?? null;

    if (featureName === FeatureName.Title) return availability(metadata?.title);
    if (featureName === FeatureName.Artist) return availability(metadata?.artist);
    if (featureName === FeatureName.Album) return availability(metadata?.album);
    if (featureName === FeatureName.Position || featureName === FeatureName.TotalTime) {
      return availability(metadata?.duration);
    }

    // As far as known, volume controls are always supported
    if (
      [FeatureName.SetVolume, FeatureName.Volume, FeatureName.VolumeDown, FeatureName.VolumeUp].includes(featureName)
    ) {
      return new FeatureInfo(FeatureState.Available);
    }

    if (featureName === FeatureName.Stop || featureName === FeatureName.Pause) {
      return availability(this.playbackManager.streamClient !== null);
    }

    return new FeatureInfo(FeatureState.Unavailable);
  }
}

/** Implementation of audio functionality. */
export class RaopAudio extends Audio {
  constructor(
    readonly playbackManager: RaopPlaybackManager,
    readonly stateDispatcher: ProtocolStateDispatcher,
  ) {
    super();
    this.stateDispatcher.listenTo(UpdatedState.Volume, (message) => this._volumeChanged(message));
  }

  // Intercept volume changes by other protocols and update accordingly. We blindly
  // trust any volume we see here as it's a much better guess than we have.
  private _volumeChanged(message: StateMessage): void {
    const volume = message.value as number;
    LOGGER.debug("Protocol %s changed volume to %f", Protocol[message.protocol], volume);
    this.playbackManager.context.volume = pctToDbfs(volume);
  }

  /** Return whether volume has changed from default or not. */
  get hasChangedVolume(): boolean {
    return this.playbackManager.context.volume !== null;
  }

  /** Return current volume level. */
  override get volume(): number {
    const vol = this.playbackManager.context.volume;
    if (vol === null) return INITIAL_VOLUME;
    return dbfsToPct(vol);
  }

  /** Change current volume level. */
  override async setVolume(level: number, _outputDevice: OutputDevice | null = null): Promise<void> {
    const raop = this.playbackManager.streamClient;
    const dbfsVolume = pctToDbfs(level);

    if (raop) await raop.setVolume(dbfsVolume);
    else this.playbackManager.context.volume = dbfsVolume;

    this.stateDispatcher.dispatch(UpdatedState.Volume, this.volume);
  }

  /** Increase volume by one step. */
  override async volumeUp(): Promise<void> {
    await this.setVolume(Math.min(this.volume + 5.0, 100.0));
  }

  /** Decrease volume by one step. */
  override async volumeDown(): Promise<void> {
    await this.setVolume(Math.max(this.volume - 5.0, 0.0));
  }
}

/** Implementation of stream functionality. */
export class RaopStream extends Stream {
  constructor(
    readonly core: Core,
    readonly listener: RaopListener,
    readonly audio: RaopAudio,
    readonly playbackManager: RaopPlaybackManager,
  ) {
    super();
  }

  override close(): void {}

  /**
   * Stream local or remote file to device.
   *
   * Supports either local file paths or a HTTP(s) address.
   *
   * INCUBATING METHOD - MIGHT CHANGE IN THE FUTURE!
   */
  override async streamFile(file: StreamSource, options: StreamFileOptions = {}): Promise<void> {
    const metadata = options.metadata ?? null;
    const overrideMissingMetadata = options.overrideMissingMetadata ?? false;

    this.playbackManager.acquire();
    let audioFile: AudioSource | null = null;
    const takeoverRelease = this.core.takeover(Audio, Metadata, PushUpdater, RemoteControl);
    try {
      const [client, context] = await this.playbackManager.setup(this.core.service);
      context.credentials = extractCredentials(this.core.service);
      context.password = this.core.service.password;
      context.audioFormat = this.core.settings.protocols.raop.audio_format;

      client.listener = this.listener;
      await client.initialize(this.core.service.properties);

      // After initialize has been called, all the audio properties will be initialized
      // and can be used when decoding audio
      audioFile = await openSource(file, context.sampleRate, context.channels, context.bytesPerChannel);

      // If no custom metadata is provided, try to load from source. If it is provided,
      // check if metadata should be overridden or not.
      let fileMetadata: MediaMetadata;
      if (metadata === null) {
        fileMetadata = await audioFile.getMetadata();
      } else if (overrideMissingMetadata) {
        fileMetadata = mergeInto(await audioFile.getMetadata(), metadata);
      } else {
        fileMetadata = metadata;
      }

      // If the user didn't change volume level prior to streaming, try to extract
      // volume level from device (if supported). Otherwise set the default level in
      // pyatv.
      let volume: number | null = null;
      if (!this.audio.hasChangedVolume && "initialVolume" in client.info) {
        const initialVolume = client.info.initialVolume;
        if (typeof initialVolume !== "number") {
          throw new ProtocolError(`initial volume ${initialVolume} has incorrect type ${typeof initialVolume}`);
        }
        context.volume = initialVolume;
      } else {
        // Try to set volume. If it fails, defer to setting it once streaming has
        // started.
        try {
          await this.audio.setVolume(this.audio.volume);
        } catch (ex) {
          LOGGER.debug("Failed to set volume (%s), delaying call", ex);
          volume = this.audio.volume;
        }
      }

      await client.sendAudio(audioFile, fileMetadata, volume);
    } finally {
      takeoverRelease();
      if (audioFile) await audioFile.close();
      await this.playbackManager.teardown();
    }
  }
}

/** Implementation of remote control functionality. */
export class RaopRemoteControl extends RemoteControl {
  constructor(
    readonly audio: RaopAudio,
    readonly playbackManager: RaopPlaybackManager,
  ) {
    super();
  }

  // At the moment, pause will stop playback until it is properly implemented. This
  // gives a better experience in Home Assistant.
  override async pause(): Promise<void> {
    this.playbackManager.streamClient?.stop();
  }

  override async stop(): Promise<void> {
    this.playbackManager.streamClient?.stop();
  }

  override async volumeUp(): Promise<void> {
    await this.audio.setVolume(Math.min(this.audio.volume + 5.0, 100.0));
  }

  override async volumeDown(): Promise<void> {
    await this.audio.setVolume(Math.max(this.audio.volume - 5.0, 0.0));
  }
}

/** Convert an raop service name to a name. */
export function raopNameFromServiceName(serviceName: string): string {
  const index = serviceName.indexOf("@");
  return index >= 0 ? serviceName.slice(index + 1) : serviceName;
}

/** Parse and return a new RAOP service. */
export function raopServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn | null {
  const name = raopNameFromServiceName(mdnsService.name);
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties),
    Protocol.RAOP,
    mdnsService.port,
    mdnsService.properties,
  );
  return [name, service];
}

/** Return handlers used for scanning. */
export function scan(): Record<string, ScanHandlerDeviceInfoName> {
  return {
    "_raop._tcp.local": [raopServiceHandler, raopNameFromServiceName],
    "_airport._tcp.local": [() => null, deviceInfoNameFromUniqueShortName],
  };
}

/** Return device information from zeroconf properties. */
export function deviceInfo(_serviceType: string, properties: Props): Record<string, unknown> {
  const devinfo: Record<string, unknown> = {};
  const am = prop(properties, "am");
  if (am !== undefined) {
    const model = lookupModel(am);
    devinfo[DeviceInfo.RAW_MODEL] = am;
    if (model !== DeviceModel.Unknown) devinfo[DeviceInfo.MODEL] = model;
    const os = lookupOs(am);
    if (os !== OperatingSystem.Unknown) devinfo[DeviceInfo.OPERATING_SYSTEM] = os;
  }
  const ov = prop(properties, "ov");
  if (ov !== undefined) devinfo[DeviceInfo.VERSION] = ov;

  // This comes from _airport._tcp.local and belongs to AirPort Expresses
  const wama = prop(properties, "wama");
  if (wama !== undefined) {
    const props: Record<string, string> = {};
    for (const entry of ("macaddress=" + wama).split(",")) {
      const index = entry.indexOf("=");
      if (index < 0) throw new Error(`invalid wama entry: ${entry}`);
      props[entry.slice(0, index)] = entry.slice(index + 1);
    }
    if (!(DeviceInfo.MAC in devinfo)) devinfo[DeviceInfo.MAC] = props.macaddress!.replaceAll("-", ":").toUpperCase();
    if ("syVs" in props) devinfo[DeviceInfo.VERSION] = props.syVs;
  }
  return devinfo;
}

/** Update service with additional information. */
export async function serviceInfo(
  service: MutableService,
  _devinfo: DeviceInfo,
  services: Map<Protocol, BaseService>,
): Promise<void> {
  const airplayService = services.get(Protocol.AirPlay);
  const airplayProp = (key: string) => (airplayService ? (prop(airplayService.properties, key) ?? "0") : "0");
  if (airplayService && airplayProp("acl") === "1") {
    // Access control might say that pairing is not possible, e.g. only devices
    // belonging to the same home (not supported by pyatv)
    service.pairing = PairingRequirement.Disabled;
  } else if (airplayService && airplayProp("act") === "2") {
    // Similarly to ACL, we can have an access control type we do not support, e.g.
    // "2" which corresponds to "Current User". So we need to filter that.
    service.pairing = PairingRequirement.Unsupported;
  } else {
    // Same behavior as for AirPlay expected, so reusing that here
    updateServiceDetails(service);
  }
}

/** Set up a new RAOP service. */
export function* setup(core: Core): Generator<SetupData> {
  const playbackManager = new RaopPlaybackManager(core);
  const metadata = new RaopMetadata(playbackManager);
  const pushUpdater = new RaopPushUpdater(metadata, core.stateDispatcher);

  /** Trigger push update. */
  const trigger = () => {
    if (pushUpdater.active) void pushUpdater.stateUpdated();
  };

  const raopListener: RaopListener = {
    playing(playbackInfo: PlaybackInfo): void {
      playbackManager.playbackInfo = playbackInfo;
      trigger();
    },
    stopped(): void {
      playbackManager.playbackInfo = null;
      trigger();
    },
  };

  const raopAudio = new RaopAudio(playbackManager, core.stateDispatcher);
  const stream = new RaopStream(core, raopListener, raopAudio, playbackManager);

  const interfaces = new Map<unknown, unknown>([
    [Stream, stream],
    [Features, new RaopFeatures(playbackManager)],
    [PushUpdater, pushUpdater],
    [Metadata, metadata],
    [Audio, raopAudio],
    [RemoteControl, new RaopRemoteControl(raopAudio, playbackManager)],
  ]);

  const getDeviceInfo = (): Record<string, unknown> => {
    const devinfo: Record<string, unknown> = {};
    for (const serviceType of Object.keys(scan())) {
      const properties = core.config.properties[serviceType];
      if (properties) dictMerge(devinfo, deviceInfo(serviceType, properties));
    }
    return devinfo;
  };

  yield {
    protocol: Protocol.RAOP,
    connect: async () => true,
    close: () => new Set(),
    deviceInfo: getDeviceInfo,
    interfaces,
    features: new Set([
      FeatureName.StreamFile,
      FeatureName.PushUpdates,
      FeatureName.Artist,
      FeatureName.Album,
      FeatureName.Title,
      FeatureName.Position,
      FeatureName.TotalTime,
      FeatureName.SetVolume,
      FeatureName.Volume,
      FeatureName.VolumeUp,
      FeatureName.VolumeDown,
      FeatureName.Stop,
      FeatureName.Pause,
    ]),
  };
}

/** Return pairing handler for protocol. */
export function pair(core: Core, options: Record<string, unknown> = {}): PairingHandler {
  return new AirPlayPairingHandler(core, getProtocolVersion(core.service, core.settings.protocols.raop.protocol_version), options);
}

registerProtocol(Protocol.RAOP, { setup, scan, pair, deviceInfo, serviceInfo });
