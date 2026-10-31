/**
 * Facade pattern for public interface of pyatv.
 *
 * This module implements a facade-like pattern by implementing the external interface
 * of pyatv and relaying calls to methods to the appropriate protocol instance, based on
 * priority via the relayer module. The purpose is to support partial implementations of
 * the interface by a protocol, whilst allowing another protocol to implement the rest.
 * If two protocols implement the same functionality, the protocol with higher
 * "priority" is picked. See `DEFAULT_PRIORITIES` for priority list.
 */

import {
  FeatureName,
  FeatureState,
  InputAction,
  KeyboardFocusState,
  PowerState,
  Protocol,
  RepeatState,
  ShuffleState,
  TouchAction,
} from "../const.ts";
import { InvalidStateError, NoServiceError, NotSupportedError, ProtocolError } from "../exceptions.ts";
import * as iface from "../interface.ts";
import { OutputDevice } from "../interface.ts";
import type { Settings } from "../settings.ts";
import { dictMerge } from "../support/collections.ts";
import type { ClientSessionManager } from "../support/http.ts";
import { deprecated } from "../support/index.ts";
import { getLogger } from "../support/logging.ts";
import * as shield from "../support/shield.ts";
import { type CoreStateDispatcher, type OutputDeviceState, type SetupData, type StateMessage, UpdatedState } from "./index.ts";
import { Relayer } from "./relayer.ts";

const LOGGER = getLogger("pyatv.core.facade");

export const DEFAULT_PRIORITIES = [Protocol.MRP, Protocol.DMAP, Protocol.Companion, Protocol.AirPlay, Protocol.RAOP];

/** Something that holds a relayer. */
export interface RelayerHost<T extends object = any> {
  readonly relayer: Relayer<T>;
}

/** Facade implementation for API used to control an Apple TV. */
export class FacadeRemoteControl extends iface.RemoteControl implements RelayerHost<iface.RemoteControl> {
  readonly relayer = new Relayer<iface.RemoteControl>(iface.RemoteControl, DEFAULT_PRIORITIES);

  override async up(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("up")(action);
  }

  override async down(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("down")(action);
  }

  override async left(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("left")(action);
  }

  override async right(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("right")(action);
  }

  override async play(): Promise<void> {
    return this.relayer.relay("play")();
  }

  override async playPause(): Promise<void> {
    return this.relayer.relay("playPause")();
  }

  override async pause(): Promise<void> {
    return this.relayer.relay("pause")();
  }

  override async stop(): Promise<void> {
    return this.relayer.relay("stop")();
  }

  override async next(): Promise<void> {
    return this.relayer.relay("next")();
  }

  override async previous(): Promise<void> {
    return this.relayer.relay("previous")();
  }

  override async select(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("select")(action);
  }

  override async menu(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("menu")(action);
  }

  override async volumeUp(): Promise<void> {
    deprecated("volumeUp");
    return this.relayer.relay("volumeUp")();
  }

  override async volumeDown(): Promise<void> {
    deprecated("volumeDown");
    return this.relayer.relay("volumeDown")();
  }

  override async home(action: InputAction = InputAction.SingleTap): Promise<void> {
    return this.relayer.relay("home")(action);
  }

  override async homeHold(): Promise<void> {
    return this.relayer.relay("homeHold")();
  }

  override async topMenu(): Promise<void> {
    return this.relayer.relay("topMenu")();
  }

  override async suspend(): Promise<void> {
    deprecated("suspend");
    return this.relayer.relay("suspend")();
  }

  override async wakeup(): Promise<void> {
    deprecated("wakeup");
    return this.relayer.relay("wakeup")();
  }

  override async skipForward(timeInterval = 0.0): Promise<void> {
    return this.relayer.relay("skipForward")(timeInterval);
  }

  override async skipBackward(timeInterval = 0.0): Promise<void> {
    return this.relayer.relay("skipBackward")(timeInterval);
  }

  override async setPosition(pos: number): Promise<void> {
    return this.relayer.relay("setPosition")(pos);
  }

  override async setShuffle(shuffleState: ShuffleState): Promise<void> {
    return this.relayer.relay("setShuffle")(shuffleState);
  }

  override async setRepeat(repeatState: RepeatState): Promise<void> {
    return this.relayer.relay("setRepeat")(repeatState);
  }

  override async channelUp(): Promise<void> {
    return this.relayer.relay("channelUp")();
  }

  override async channelDown(): Promise<void> {
    return this.relayer.relay("channelDown")();
  }

  override async screensaver(): Promise<void> {
    return this.relayer.relay("screensaver")();
  }

  override async guide(): Promise<void> {
    return this.relayer.relay("guide")();
  }

  override async controlCenter(): Promise<void> {
    return this.relayer.relay("controlCenter")();
  }
}

/** Facade implementation for retrieving metadata from an Apple TV. */
export class FacadeMetadata extends iface.Metadata implements RelayerHost<iface.Metadata> {
  readonly relayer = new Relayer<iface.Metadata>(iface.Metadata, DEFAULT_PRIORITIES);

  override get deviceId(): string | null {
    return this.relayer.relay("deviceId");
  }

  override async artwork(width: number | null = 512, height: number | null = null): Promise<iface.ArtworkInfo | null> {
    return this.relayer.relay("artwork")(width, height);
  }

  override get artworkId(): string {
    return this.relayer.relay("artworkId");
  }

  override async playing(): Promise<iface.Playing> {
    return this.relayer.relay("playing")();
  }

  override get app(): iface.App | null {
    return this.relayer.relay("app");
  }
}

/**
 * Facade implementation for supported feature functionality.
 *
 * This class holds a map from feature name to an instance handling that feature name.
 */
export class FacadeFeatures extends iface.Features implements RelayerHost<iface.Features> {
  readonly relayer = new Relayer<iface.Features>(iface.Features, DEFAULT_PRIORITIES);
  private readonly _featureMap = new Map<FeatureName, [Protocol, iface.Features]>();

  constructor(private readonly _pushUpdaterRelay: RelayerHost) {
    super();
  }

  /** Add mapping from protocol to features handled by that protocol. */
  addMapping(protocol: Protocol, features: Set<FeatureName>): void {
    const instance = this.relayer.get(protocol);
    if (instance) {
      for (const feature of features) {
        // Add feature to map if missing OR replace if this protocol has higher
        // priority than previous mapping
        const existing = this._featureMap.get(feature);
        if (!existing || FacadeFeatures._hasHigherPriority(protocol, existing[0])) {
          this._featureMap.set(feature, [protocol, instance]);
        }
      }
    }
  }

  override getFeature(featureName: FeatureName): iface.FeatureInfo {
    if (featureName === FeatureName.PushUpdates) {
      // Multiple protocols can register a push updater implementation, but only one
      // of them will ever be used (i.e. relaying is not done on method level). So if
      // at least one push updater is available, then we can return "Available" here.
      if (this._pushUpdaterRelay.relayer.count >= 1) {
        return new iface.FeatureInfo(FeatureState.Available);
      }
    }
    const entry = this._featureMap.get(featureName);
    if (entry) return entry[1].getFeature(featureName);
    return new iface.FeatureInfo(FeatureState.Unsupported);
  }

  private static _hasHigherPriority(first: Protocol, second: Protocol): boolean {
    return DEFAULT_PRIORITIES.indexOf(first) < DEFAULT_PRIORITIES.indexOf(second);
  }
}

/** Facade implementation for retrieving power state from an Apple TV. */
export class FacadePower extends iface.Power implements RelayerHost<iface.Power>, iface.PowerListener {
  // Generally favor Companion as it implements power better than MRP
  static readonly OVERRIDE_PRIORITIES = [
    Protocol.Companion,
    Protocol.MRP,
    Protocol.DMAP,
    Protocol.AirPlay,
    Protocol.RAOP,
  ];

  readonly relayer = new Relayer<iface.Power>(iface.Power, FacadePower.OVERRIDE_PRIORITIES);

  constructor(_coreDispatcher: CoreStateDispatcher) {
    super();
  }

  /** Forward power state updates from protocol implementations to actual listener. */
  powerstateUpdate(oldState: PowerState, newState: PowerState): void {
    this.listener.powerstateUpdate(oldState, newState);
  }

  override get powerState(): PowerState {
    return this.relayer.relay("powerState", FacadePower.OVERRIDE_PRIORITIES);
  }

  override async turnOn(awaitNewState = false): Promise<void> {
    await this.relayer.relay("turnOn", FacadePower.OVERRIDE_PRIORITIES)(awaitNewState);
  }

  override async turnOff(awaitNewState = false): Promise<void> {
    await this.relayer.relay("turnOff", FacadePower.OVERRIDE_PRIORITIES)(awaitNewState);
  }
}

/** Facade implementation for stream functionality. */
export class FacadeStream extends iface.Stream implements RelayerHost<iface.Stream> {
  readonly relayer = new Relayer<iface.Stream>(iface.Stream, DEFAULT_PRIORITIES);

  constructor(private readonly _features: iface.Features) {
    super();
  }

  override close(): void {
    this.relayer.relay("close")();
  }

  override async playUrl(url: string, options: Record<string, unknown> = {}): Promise<void> {
    if (!this._features.inState(FeatureState.Available, FeatureName.PlayUrl)) {
      throw new NotSupportedError("play_url is not supported");
    }
    await this.relayer.relay("playUrl")(url, options);
  }

  override async streamFile(file: iface.StreamSource, options: iface.StreamFileOptions = {}): Promise<void> {
    await this.relayer.relay("streamFile")(file, options);
  }
}

/** Facade implementation for app handling. */
export class FacadeApps extends iface.Apps implements RelayerHost<iface.Apps> {
  readonly relayer = new Relayer<iface.Apps>(iface.Apps, DEFAULT_PRIORITIES);

  override async appList(): Promise<iface.App[]> {
    return this.relayer.relay("appList")();
  }

  override async launchApp(bundleIdOrUrl: string): Promise<void> {
    await this.relayer.relay("launchApp")(bundleIdOrUrl);
  }
}

/** Facade implementation for account handling. */
export class FacadeUserAccounts extends iface.UserAccounts implements RelayerHost<iface.UserAccounts> {
  readonly relayer = new Relayer<iface.UserAccounts>(iface.UserAccounts, DEFAULT_PRIORITIES);

  override async accountList(): Promise<iface.UserAccount[]> {
    return this.relayer.relay("accountList")();
  }

  override async switchAccount(accountId: string): Promise<void> {
    await this.relayer.relay("switchAccount")(accountId);
  }
}

/** Facade implementation for audio functionality. */
export class FacadeAudio extends iface.Audio implements RelayerHost<iface.Audio> {
  readonly relayer = new Relayer<iface.Audio>(iface.Audio, DEFAULT_PRIORITIES);
  private _volume = 0.0;
  private _outputDevices: OutputDevice[] = [];

  constructor(coreDispatcher: CoreStateDispatcher) {
    super();
    coreDispatcher.listenTo(UpdatedState.Volume, (m) => this._volumeChanged(m));
    coreDispatcher.listenTo(UpdatedState.OutputDevices, (m) => this._outputDevicesChanged(m));
    coreDispatcher.listenTo(UpdatedState.OutputDeviceVolume, (m) => this._outputDeviceVolumeChanged(m));
  }

  private _volumeChanged(message: StateMessage): void {
    const volume = message.value as number;

    // Compute new state so we can know if we should update or not
    const oldLevel = this._volume;
    const newLevel = (this._volume = volume);

    // Do not update state in case it didn't change
    if (newLevel !== oldLevel) {
      this.listener.volumeUpdate(oldLevel, newLevel);
    }
  }

  private _outputDevicesChanged(message: StateMessage): void {
    const outputDevices = message.value as OutputDevice[];

    const oldDevices = this._outputDevices;
    const newDevices = (this._outputDevices = outputDevices);

    const same =
      oldDevices.length === newDevices.length && oldDevices.every((device, i) => device.equals(newDevices[i]));
    if (!same) {
      this.listener.outputdevicesUpdate(oldDevices, newDevices);
    }
  }

  private _outputDeviceVolumeChanged(message: StateMessage): void {
    const deviceState = message.value as OutputDeviceState;
    let outputDevice = this._outputDevices.find((device) => device.identifier === deviceState.identifier);
    if (!outputDevice) outputDevice = new OutputDevice(deviceState.identifier);
    const oldVolume = outputDevice.volume;
    outputDevice.volume = deviceState.volume;
    if (deviceState.volume !== oldVolume) {
      this.listener.volumeDeviceUpdate(outputDevice, oldVolume, deviceState.volume);
    }
  }

  override async volumeUp(): Promise<void> {
    return this.relayer.relay("volumeUp")();
  }

  override async volumeDown(): Promise<void> {
    return this.relayer.relay("volumeDown")();
  }

  override get volume(): number {
    const volume = this.relayer.relay("volume") as number;
    if (volume >= 0.0 && volume <= 100.0) return volume;
    throw new ProtocolError(`volume ${volume} is out of range`);
  }

  override async setVolume(level: number, outputDevice: OutputDevice | null = null): Promise<void> {
    if (level >= 0.0 && level <= 100.0) {
      await this.relayer.relay("setVolume")(level, outputDevice);
    } else {
      throw new ProtocolError(`volume ${level} is out of range`);
    }
  }

  override get outputDevices(): OutputDevice[] {
    return this.relayer.relay("outputDevices");
  }

  override async addOutputDevices(...devices: string[]): Promise<void> {
    return this.relayer.relay("addOutputDevices")(...devices);
  }

  override async removeOutputDevices(...devices: string[]): Promise<void> {
    return this.relayer.relay("removeOutputDevices")(...devices);
  }

  override async setOutputDevices(...devices: string[]): Promise<void> {
    return this.relayer.relay("setOutputDevices")(...devices);
  }
}

/** Facade implementation for keyboard handling. */
export class FacadeKeyboard extends iface.Keyboard implements RelayerHost<iface.Keyboard> {
  readonly relayer = new Relayer<iface.Keyboard>(iface.Keyboard, DEFAULT_PRIORITIES);
  private _focusState: KeyboardFocusState = KeyboardFocusState.Unknown;

  constructor(coreDispatcher: CoreStateDispatcher) {
    super();
    coreDispatcher.listenTo(
      UpdatedState.KeyboardFocus,
      (m) => this._focusStateChanged(m),
      (message) => message.protocol === this.relayer.mainProtocol,
    );
  }

  private _focusStateChanged(message: StateMessage): void {
    const state = message.value as KeyboardFocusState;
    const oldState = this._focusState;
    const newState = (this._focusState = state);
    if (newState !== oldState) {
      LOGGER.debug("Focus state changed from %s to %s", oldState, newState);
      this.listener.focusstateUpdate(oldState, newState);
    }
  }

  override get textFocusState(): KeyboardFocusState {
    return this.relayer.relay("textFocusState");
  }

  override async textGet(): Promise<string | null> {
    return this.relayer.relay("textGet")();
  }

  override async textClear(): Promise<void> {
    return this.relayer.relay("textClear")();
  }

  override async textAppend(text: string): Promise<void> {
    return this.relayer.relay("textAppend")(text);
  }

  override async textSet(text: string): Promise<void> {
    return this.relayer.relay("textSet")(text);
  }
}

/** Facade for push/async updates from an Apple TV. */
export class FacadePushUpdater extends iface.PushUpdater implements RelayerHost<iface.PushUpdater>, iface.PushListener {
  readonly relayer = new Relayer<iface.PushUpdater>(iface.PushUpdater, DEFAULT_PRIORITIES);

  override get active(): boolean {
    return this.relayer.relay("active");
  }

  override start(initialDelay = 0): void {
    for (const instance of this.relayer.instances) {
      instance.listener = this;
      instance.start(initialDelay);
    }
  }

  override stop(): void {
    for (const instance of this.relayer.instances) {
      instance.listener = null;
      instance.stop();
    }
  }

  /** Inform about changes to what is currently playing. */
  playstatusUpdate(updater: iface.PushUpdater, playstatus: iface.Playing): void {
    if (updater === this.relayer.mainInstance) {
      this.listener.playstatusUpdate(updater, playstatus);
    }
  }

  /** Inform about an error when updating play status. */
  playstatusError(updater: iface.PushUpdater, exception: Error): void {
    if (updater === this.relayer.mainInstance) {
      this.listener.playstatusError(updater, exception);
    }
  }
}

/** Facade implementation for touch gestures handling. */
export class FacadeTouchGestures extends iface.TouchGestures implements RelayerHost<iface.TouchGestures> {
  readonly relayer = new Relayer<iface.TouchGestures>(iface.TouchGestures, DEFAULT_PRIORITIES);

  constructor(_coreDispatcher: CoreStateDispatcher) {
    super();
  }

  override async swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number): Promise<void> {
    return this.relayer.relay("swipe")(startX, startY, endX, endY, durationMs);
  }

  override async action(x: number, y: number, mode: TouchAction): Promise<void> {
    return this.relayer.relay("action")(x, y, mode);
  }

  override async click(action: InputAction): Promise<void> {
    return this.relayer.relay("click")(action);
  }
}

type InterfaceClass = object;

/** Facade implementation of the external interface. */
export class FacadeAppleTV extends iface.AppleTV {
  private readonly _config: iface.BaseConfig;
  private readonly _sessionManager: ClientSessionManager;
  private readonly _protocolsToSetup: SetupData[] = [];
  private readonly _protocolHandlers = new Map<Protocol, SetupData>();
  private readonly _pushUpdates: FacadePushUpdater;
  private readonly _features: FacadeFeatures;
  private _pendingTasks: Set<Promise<unknown>> | null = null;
  private _deviceInfo = new iface.DeviceInfo({});
  private readonly _interfaces: Map<InterfaceClass, RelayerHost & object>;
  private readonly _settings: Settings;

  constructor(
    config: iface.BaseConfig,
    sessionManager: ClientSessionManager,
    coreDispatcher: CoreStateDispatcher,
    settings: Settings,
  ) {
    super(1); // To StateProducer via interface.AppleTV
    this._config = config;
    this._sessionManager = sessionManager;
    this._pushUpdates = new FacadePushUpdater();
    this._features = new FacadeFeatures(this._pushUpdates);
    this._interfaces = new Map<InterfaceClass, RelayerHost & object>([
      [iface.Features, this._features],
      [iface.RemoteControl, new FacadeRemoteControl()],
      [iface.Metadata, new FacadeMetadata()],
      [iface.Power, new FacadePower(coreDispatcher)],
      [iface.PushUpdater, this._pushUpdates],
      [iface.Stream, new FacadeStream(this._features)],
      [iface.Apps, new FacadeApps()],
      [iface.UserAccounts, new FacadeUserAccounts()],
      [iface.Audio, new FacadeAudio(coreDispatcher)],
      [iface.Keyboard, new FacadeKeyboard(coreDispatcher)],
      [iface.TouchGestures, new FacadeTouchGestures(coreDispatcher)],
    ]);
    this._settings = settings;
    this._shieldEverything();
  }

  private _shieldEverything(): void {
    shield.shield(this);
    for (const instance of this._interfaces.values()) shield.shield(instance);
  }

  private _blockEverything(): void {
    shield.block(this);
    for (const instance of this._interfaces.values()) shield.block(instance);
  }

  /** Return relayer host for an interface (mainly for internal use and tests). */
  getInterface(interfaceClass: InterfaceClass): (RelayerHost & object) | undefined {
    return this._interfaces.get(interfaceClass);
  }

  /** Add a new protocol to the relay. */
  addProtocol(setupData: SetupData): void {
    // Connecting commits current configuration, thus adding new protocols is not
    // allowed anymore after that
    if (this._protocolHandlers.size > 0) {
      throw new InvalidStateError("cannot add protocol after connect was called");
    }
    LOGGER.debug("Adding handler for protocol %s", Protocol[setupData.protocol]);
    this._protocolsToSetup.push(setupData);
  }

  async connect(): Promise<void> {
    // No protocols to setup + no protocols previously set up => no service
    if (this._protocolsToSetup.length === 0 && this._protocolHandlers.size === 0) {
      throw new NoServiceError("no service to connect to");
    }

    // Protocols set up already => we have already connected
    if (this._protocolHandlers.size > 0) {
      throw new InvalidStateError("already connected");
    }

    const devinfo: Record<string, unknown> = {};

    // Set up protocols, ignoring duplicates
    while (this._protocolsToSetup.length > 0) {
      const setupData = this._protocolsToSetup.shift()!;

      if (this._protocolHandlers.has(setupData.protocol)) {
        LOGGER.debug("Protocol %s already set up, ignoring", Protocol[setupData.protocol]);
        continue;
      }

      LOGGER.debug("Connecting to protocol: %s", Protocol[setupData.protocol]);
      if (await setupData.connect()) {
        LOGGER.debug("Connected to protocol: %s", Protocol[setupData.protocol]);
        this._protocolHandlers.set(setupData.protocol, setupData);

        for (const [ifaceClass, instance] of setupData.interfaces) {
          this._interfaces.get(ifaceClass as InterfaceClass)?.relayer.register(instance as object, setupData.protocol);
        }

        this._features.addMapping(setupData.protocol, setupData.features);
        dictMerge(devinfo, setupData.deviceInfo());
      }
    }

    this._deviceInfo = new iface.DeviceInfo(devinfo);

    // Forward power events in case an interface exists for it
    try {
      const facadePower = this._interfaces.get(iface.Power) as FacadePower;
      const power = facadePower.relayer.mainInstance;
      power.listener = facadePower;
    } catch (ex) {
      if (!(ex instanceof NotSupportedError)) throw ex;
      LOGGER.debug("Power management not supported by any protocols");
    }
  }

  close(): Set<Promise<unknown>> {
    // If close was called before, returning pending tasks
    if (this._pendingTasks !== null) return this._pendingTasks;

    // Stop all push updaters otherwise they might continue in the background
    this._pushUpdates.stop();

    this._pendingTasks = new Set();
    this._pendingTasks.add(this._sessionManager.close());
    for (const setupData of this._protocolHandlers.values()) {
      for (const task of setupData.close()) this._pendingTasks.add(task);
    }

    // Block access to everything in the public interface
    this._blockEverything();

    return this._pendingTasks;
  }

  /**
   * Perform takeover of one or more interfaces by a protocol.
   *
   * Returns a function, that when called, releases the interfaces taken over.
   */
  takeover(protocol: Protocol, ...interfaces: unknown[]): () => void {
    const takenOver: Relayer[] = [];

    const release = () => {
      LOGGER.debug("Release %s by %s", interfaces.length, Protocol[protocol]);
      for (const relayer of takenOver) relayer.release();
    };

    LOGGER.debug("Takeover %s by %s", interfaces.length, Protocol[protocol]);

    for (const ifaceClass of interfaces) {
      const host = this._interfaces.get(ifaceClass as InterfaceClass);
      if (!host) continue;
      try {
        host.relayer.takeover(protocol);
      } catch (ex) {
        release();
        throw ex;
      }
      takenOver.push(host.relayer);
    }

    return release;
  }

  get settings(): Settings {
    return this._settings;
  }

  get deviceInfo(): iface.DeviceInfo {
    return this._deviceInfo;
  }

  get service(): iface.BaseService {
    for (const protocol of DEFAULT_PRIORITIES) {
      const service = this._config.getService(protocol);
      if (service) return service;
    }
    throw new Error("no service (bug)");
  }

  get remoteControl(): iface.RemoteControl {
    return this._interfaces.get(iface.RemoteControl) as FacadeRemoteControl;
  }

  get metadata(): iface.Metadata {
    return this._interfaces.get(iface.Metadata) as FacadeMetadata;
  }

  get pushUpdater(): iface.PushUpdater {
    return this._interfaces.get(iface.PushUpdater) as FacadePushUpdater;
  }

  get stream(): iface.Stream {
    return this._interfaces.get(iface.Stream) as FacadeStream;
  }

  get power(): iface.Power {
    return this._interfaces.get(iface.Power) as FacadePower;
  }

  get features(): iface.Features {
    return this._interfaces.get(iface.Features) as FacadeFeatures;
  }

  get apps(): iface.Apps {
    return this._interfaces.get(iface.Apps) as FacadeApps;
  }

  get userAccounts(): iface.UserAccounts {
    return this._interfaces.get(iface.UserAccounts) as FacadeUserAccounts;
  }

  get audio(): iface.Audio {
    return this._interfaces.get(iface.Audio) as FacadeAudio;
  }

  get keyboard(): iface.Keyboard {
    return this._interfaces.get(iface.Keyboard) as FacadeKeyboard;
  }

  get touch(): iface.TouchGestures {
    return this._interfaces.get(iface.TouchGestures) as FacadeTouchGestures;
  }

  /**
   * Call when state was updated.
   *
   * One of the protocol called a method in DeviceListener so everything should be
   * torn down.
   */
  override stateWasUpdated(): void {
    this.close();
  }
}

// Guard public methods with shield (blocked after close)
shield.guardMethods(FacadeRemoteControl, [
  "up",
  "down",
  "left",
  "right",
  "play",
  "playPause",
  "pause",
  "stop",
  "next",
  "previous",
  "select",
  "menu",
  "volumeUp",
  "volumeDown",
  "home",
  "homeHold",
  "topMenu",
  "suspend",
  "wakeup",
  "skipForward",
  "skipBackward",
  "setPosition",
  "setShuffle",
  "setRepeat",
  "channelUp",
  "channelDown",
  "screensaver",
  "guide",
  "controlCenter",
]);
shield.guardMethods(FacadeMetadata, ["deviceId", "artwork", "artworkId", "playing", "app"]);
shield.guardMethods(FacadeFeatures, ["getFeature"]);
shield.guardMethods(FacadePower, ["powerState", "turnOn", "turnOff"]);
shield.guardMethods(FacadeStream, ["close", "playUrl", "streamFile"]);
shield.guardMethods(FacadeApps, ["appList", "launchApp"]);
shield.guardMethods(FacadeUserAccounts, ["accountList", "switchAccount"]);
shield.guardMethods(FacadeAudio, [
  "volumeUp",
  "volumeDown",
  "volume",
  "setVolume",
  "outputDevices",
  "addOutputDevices",
  "removeOutputDevices",
  "setOutputDevices",
]);
shield.guardMethods(FacadeKeyboard, ["textFocusState", "textGet", "textClear", "textAppend", "textSet"]);
shield.guardMethods(FacadePushUpdater, ["active", "start", "stop"]);
shield.guardMethods(FacadeTouchGestures, ["swipe", "action", "click"]);
shield.guardMethods(FacadeAppleTV, [
  "connect",
  "settings",
  "deviceInfo",
  "service",
  "remoteControl",
  "metadata",
  "pushUpdater",
  "stream",
  "power",
  "features",
  "apps",
  "userAccounts",
  "audio",
  "keyboard",
  "touch",
]);
