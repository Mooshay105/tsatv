/** PoC code for Companion protocol. */

import {
  DeviceModel,
  FeatureName,
  FeatureState,
  InputAction,
  KeyboardFocusState,
  PairingRequirement,
  PowerState,
  Protocol,
  type TouchAction,
} from "../../const.ts";
import { type Core, MutableService, type SetupData, UpdatedState } from "../../core/index.ts";
import type * as mdns from "../../core/mdns.ts";
import { deviceInfoNameFromUniqueShortName, type ScanHandlerDeviceInfoName, type ScanHandlerReturn } from "../../core/scan.ts";
import { NotImplementedError, NotSupportedError, ProtocolError } from "../../exceptions.ts";
import { getUniqueId } from "../../helpers.ts";
import {
  App,
  Apps,
  Audio,
  type BaseService,
  DeviceInfo,
  FeatureInfo,
  Features,
  Keyboard,
  type OutputDevice,
  type PairingHandler,
  Power,
  RemoteControl,
  TouchGestures,
  UserAccount,
  UserAccounts,
} from "../../interface.ts";
import { Event, sleep, waitFor } from "../../support/asyncio.ts";
import { lookupModel } from "../../support/device_info.ts";
import { Float } from "../../support/float.ts";
import { getLogger } from "../../support/logging.ts";
import { registerProtocol } from "../index.ts";
import { CompanionAPI, HidCommand, MediaControlCommand, SystemStatus } from "./api.ts";
import { CompanionPairingHandler } from "./pairing.ts";
import type { OpackDict } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.companion");

// Observed values of rpfl (zeroconf):
// 0x62792 -> All on the same network (Unsupported/Mandatory)
// 0x627B6 -> Only devices in same home (Disabled)
// 0xB67A2 -> Same as above
// Mask = 0x62792 & ~0xB67A2 & ~0x627B6 & ~0xB67A2 = 0x20
export const PAIRING_DISABLED_MASK = 0x04;

// Pairing with PIN seems to be supported according to this pattern (again, observed
// from values of rpfl):
//
// Not pairable:
// 0010 0000 0000 0000 0000 = 0x20000 (Mac Mini, MacBook)
// 0110 0010 0111 1011 0010 = 0x627B2 (HomePod, HomePod mini)
// 0110 0010 0111 1001 0010 = 0x62792 (HomePod mini)
// 0011 0000 0000 0000 0000 = 0x30000 (iPad)
//
// Pairable:
// 0011 0110 0111 1010 0010 = 0x367A2 (Apple TV 4K)
// 0011 0110 0111 1000 0010 = 0x36782 (Apple TV 4K)
// ===
// 0000 0100 0000 0000 0000 = 0x04000
//
// So masking 0x40000 should tell if pairing is supported or not (in a way that pyatv
// supports).
export const PAIRING_WITH_PIN_SUPPORTED_MASK = 0x4000;

// As seen in the TV Remote App
const DEFAULT_SKIP_TIME = 10;

/** Media control flags used to indicate available controls. */
export enum MediaControlFlags {
  NoControls = 0x0000,
  Play = 0x0001,
  Pause = 0x0002,
  NextTrack = 0x0004,
  PreviousTrack = 0x0008,
  FastForward = 0x0010,
  Rewind = 0x0020,
  // ? = 0x0040
  // ? = 0x0080
  Volume = 0x0100,
  SkipForward = 0x0200,
  SkipBackward = 0x0400,
}

export const MEDIA_CONTROL_MAP = new Map<FeatureName, MediaControlFlags>([
  [FeatureName.Play, MediaControlFlags.Play],
  [FeatureName.Pause, MediaControlFlags.Pause],
  [FeatureName.Next, MediaControlFlags.NextTrack],
  [FeatureName.Previous, MediaControlFlags.PreviousTrack],
  [FeatureName.Volume, MediaControlFlags.Volume],
  [FeatureName.SetVolume, MediaControlFlags.Volume],
  [FeatureName.SkipForward, MediaControlFlags.SkipForward],
  [FeatureName.SkipBackward, MediaControlFlags.SkipBackward],
]);

export const SUPPORTED_FEATURES = new Set<FeatureName>([
  // App interface
  FeatureName.AppList,
  FeatureName.LaunchApp,
  // User account interface
  FeatureName.AccountList,
  FeatureName.SwitchAccount,
  // Power interface
  FeatureName.PowerState,
  FeatureName.TurnOn,
  FeatureName.TurnOff,
  // Remote control (navigation, i.e. HID)
  FeatureName.Up,
  FeatureName.Down,
  FeatureName.Left,
  FeatureName.Right,
  FeatureName.Select,
  FeatureName.Menu,
  FeatureName.Home,
  FeatureName.VolumeUp,
  FeatureName.VolumeDown,
  FeatureName.PlayPause,
  FeatureName.ChannelUp,
  FeatureName.ChannelDown,
  FeatureName.Screensaver,
  FeatureName.Guide,
  FeatureName.ControlCenter,
  // Keyboard interface
  FeatureName.TextFocusState,
  FeatureName.TextGet,
  FeatureName.TextClear,
  FeatureName.TextAppend,
  FeatureName.TextSet,
  FeatureName.Swipe,
  FeatureName.Action,
  FeatureName.Click,
  // Remote control (playback, i.e. Media Control)
  ...MEDIA_CONTROL_MAP.keys(),
]);

/** Implementation of API for app handling. */
export class CompanionApps extends Apps {
  constructor(readonly api: CompanionAPI) {
    super();
  }

  /** Fetch a list of apps that can be launched. */
  override async appList(): Promise<App[]> {
    const appList = await this.api.appList();
    if (!("_c" in appList)) throw new ProtocolError("missing content in response");
    return Object.entries(appList._c as Record<string, string>).map(([bundleId, name]) => new App(name, bundleId));
  }

  /** Launch an app based on bundle ID or URL. */
  override async launchApp(bundleIdOrUrl: string): Promise<void> {
    await this.api.launchApp(bundleIdOrUrl);
  }
}

/** Implementation of API for account handling. */
export class CompanionUserAccounts extends UserAccounts {
  constructor(readonly api: CompanionAPI) {
    super();
  }

  /** Fetch a list of user accounts that can be switched. */
  override async accountList(): Promise<UserAccount[]> {
    const accountList = await this.api.accountList();
    if (!("_c" in accountList)) throw new ProtocolError("missing content in response");
    return Object.entries(accountList._c as Record<string, string>).map(([accountId, name]) => new UserAccount(name, accountId));
  }

  /** Switch user account by account ID. */
  override async switchAccount(accountId: string): Promise<void> {
    await this.api.switchAccount(accountId);
  }
}

/** Implementation of power management API. */
export class CompanionPower extends Power {
  private _powerState: PowerState = PowerState.Unknown;

  constructor(readonly api: CompanionAPI) {
    super();
  }

  /** Return if power updates are supported or not. */
  get supportsPowerUpdates(): boolean {
    return this._powerState !== PowerState.Unknown;
  }

  /** Initialize Power module. */
  async initialize(): Promise<void> {
    // Fetching the initial power state snapshot can fail on newer tvOS versions where
    // FetchAttentionState is no longer handled (the device replies with "No request
    // handler"). This must not prevent us from subscribing to live status updates,
    // otherwise powerState stays Unknown forever and can never recover from pushed
    // events.
    try {
      const systemStatus = await this.api.fetchAttentionState();
      this._powerState = CompanionPower._systemStatusToPowerState(systemStatus);
      LOGGER.debug("Initial power state is %s", PowerState[this.powerState]);
    } catch (ex) {
      LOGGER.debug("Could not fetch initial SystemStatus (%s)", ex);
    }

    // Subscribe regardless, so power state can still be tracked via pushed
    // SystemStatus/TVSystemStatus events even if the initial fetch failed.
    try {
      this.api.listenTo("SystemStatus", (data) => this._handleSystemStatusUpdate(data));
      await this.api.subscribeEvent("SystemStatus");

      this.api.listenTo("TVSystemStatus", (data) => this._handleSystemStatusUpdate(data));
      await this.api.subscribeEvent("TVSystemStatus");
    } catch (ex) {
      LOGGER.debug("Could not subscribe to SystemStatus updates (%s)", ex);
    }
  }

  /** Return device power state. */
  override get powerState(): PowerState {
    return this._powerState;
  }

  private async _handleSystemStatusUpdate(data: OpackDict): Promise<void> {
    try {
      const state = Math.trunc(Number(data.state));
      if (!(state in SystemStatus)) throw new Error(`invalid state ${data.state}`);
      const oldState = this.powerState;
      this._powerState = CompanionPower._systemStatusToPowerState(state as SystemStatus);
      this._updatePowerState(oldState, this._powerState);
    } catch (ex) {
      LOGGER.exception("Got invalid SystemStatus: %s (%s)", data, ex);
    }
  }

  private static _systemStatusToPowerState(systemStatus: SystemStatus): PowerState {
    if (systemStatus === SystemStatus.Asleep) return PowerState.Off;
    if ([SystemStatus.Screensaver, SystemStatus.Awake, SystemStatus.Idle].includes(systemStatus)) return PowerState.On;
    return PowerState.Unknown;
  }

  private _updatePowerState(oldState: PowerState, newState: PowerState): void {
    if (newState !== oldState) {
      LOGGER.debug("Power state changed from %s to %s", PowerState[oldState], PowerState[newState]);
      const callback = this.listener.powerstateUpdate;
      queueMicrotask(() => callback(oldState, newState));
    }
  }

  /** Turn device on. */
  override async turnOn(awaitNewState = false): Promise<void> {
    // TODO: add support for this
    if (awaitNewState) throw new NotImplementedError("not supported by Companion yet");
    await this.api.hidCommand(false, HidCommand.Wake);
  }

  /** Turn device off. */
  override async turnOff(awaitNewState = false): Promise<void> {
    // TODO: add support for this
    if (awaitNewState) throw new NotImplementedError("not supported by Companion yet");
    await this.api.hidCommand(false, HidCommand.Sleep);
  }
}

/** Implementation of remote control API. */
export class CompanionRemoteControl extends RemoteControl {
  constructor(readonly api: CompanionAPI) {
    super();
  }

  override async up(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Up, action);
  }

  override async down(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Down, action);
  }

  override async left(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Left, action);
  }

  override async right(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Right, action);
  }

  override async select(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Select, action);
  }

  override async menu(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Menu, action);
  }

  override async home(action: InputAction = InputAction.SingleTap): Promise<void> {
    await this._pressButton(HidCommand.Home, action);
  }

  override async volumeUp(): Promise<void> {
    await this._pressButton(HidCommand.VolumeUp);
  }

  override async volumeDown(): Promise<void> {
    await this._pressButton(HidCommand.VolumeDown);
  }

  override async playPause(): Promise<void> {
    await this._pressButton(HidCommand.PlayPause);
  }

  override async play(): Promise<void> {
    await this.api.mediacontrolCommand(MediaControlCommand.Play);
  }

  override async pause(): Promise<void> {
    await this.api.mediacontrolCommand(MediaControlCommand.Pause);
  }

  override async next(): Promise<void> {
    await this.api.mediacontrolCommand(MediaControlCommand.NextTrack);
  }

  override async previous(): Promise<void> {
    await this.api.mediacontrolCommand(MediaControlCommand.PreviousTrack);
  }

  /** Skip forward a time interval. */
  override async skipForward(timeInterval = 0.0): Promise<void> {
    await this.api.mediacontrolCommand(MediaControlCommand.SkipBy, {
      _skpS: new Float(timeInterval > 0 ? timeInterval : DEFAULT_SKIP_TIME),
    });
  }

  /** Skip backward a time interval. */
  override async skipBackward(timeInterval = 0.0): Promise<void> {
    // Float: opack fails with negative integers
    await this.api.mediacontrolCommand(MediaControlCommand.SkipBy, {
      _skpS: new Float(timeInterval > 0 ? -timeInterval : -DEFAULT_SKIP_TIME),
    });
  }

  override async channelUp(): Promise<void> {
    await this._pressButton(HidCommand.ChannelIncrement);
  }

  override async channelDown(): Promise<void> {
    await this._pressButton(HidCommand.ChannelDecrement);
  }

  override async screensaver(): Promise<void> {
    await this._pressButton(HidCommand.Screensaver);
  }

  override async guide(): Promise<void> {
    await this._pressButton(HidCommand.Guide);
  }

  override async controlCenter(): Promise<void> {
    await this._pressButton(HidCommand.PageDown);
  }

  private async _pressButton(command: HidCommand, action: InputAction = InputAction.SingleTap, delay = 1): Promise<void> {
    if (action === InputAction.SingleTap) {
      await this.api.hidCommand(true, command);
      await this.api.hidCommand(false, command);
    } else if (action === InputAction.Hold) {
      await this.api.hidCommand(true, command);
      await sleep(delay);
      await this.api.hidCommand(false, command);
    } else if (action === InputAction.DoubleTap) {
      // First press
      await this.api.hidCommand(true, command);
      await this.api.hidCommand(false, command);
      // Second press
      await this.api.hidCommand(true, command);
      await this.api.hidCommand(false, command);
    } else {
      throw new NotSupportedError(`unsupported input action: ${action}`);
    }
  }
}

/** Implementation of audio API. */
export class CompanionAudio extends Audio {
  private readonly _volumeEvent = new Event();
  private _volume = 0.0;

  constructor(
    readonly api: CompanionAPI,
    readonly core: Core,
  ) {
    super();
    this.api.listenTo("_iMC", (data) => this._handleControlFlagUpdate(data));
  }

  private async _handleControlFlagUpdate(data: OpackDict): Promise<void> {
    if (data._mcF & MediaControlFlags.Volume) {
      LOGGER.debug("Volume control changed, updating volume");

      const resp = await this.api.mediacontrolCommand(MediaControlCommand.GetVolume);
      this._volume = Number(resp._c._vol) * 100.0;
      LOGGER.debug("Volume changed to %f", this._volume);
      this._volumeEvent.set();
    } else {
      // No volume control means we know nothing about the volume
      this._volume = 0.0;
    }

    this.core.stateDispatcher.dispatch(UpdatedState.Volume, this.volume);
  }

  /** Return current volume level (range is in percent, i.e. [0.0-100.0]). */
  override get volume(): number {
    return this._volume;
  }

  /** Change current volume level (range is in percent, i.e. [0.0-100.0]). */
  override async setVolume(level: number, _outputDevice: OutputDevice | null = null): Promise<void> {
    this._volumeEvent.clear();
    await this.api.mediacontrolCommand(MediaControlCommand.SetVolume, { _vol: new Float(level / 100.0) });
    await waitFor(this._volumeEvent.wait(), 5.0);
  }

  /** Increase volume by one step. */
  override async volumeUp(): Promise<void> {
    this._volumeEvent.clear();
    await this.api.hidCommand(true, HidCommand.VolumeUp);
    await this.api.hidCommand(false, HidCommand.VolumeUp);
    await waitFor(this._volumeEvent.wait(), 5.0);
  }

  /** Decrease volume by one step. */
  override async volumeDown(): Promise<void> {
    this._volumeEvent.clear();
    await this.api.hidCommand(true, HidCommand.VolumeDown);
    await this.api.hidCommand(false, HidCommand.VolumeDown);
    await waitFor(this._volumeEvent.wait(), 5.0);
  }
}

/** Implementation of API for keyboard handling. */
export class CompanionKeyboard extends Keyboard {
  private _focusState: KeyboardFocusState = KeyboardFocusState.Unknown;

  constructor(
    readonly api: CompanionAPI,
    readonly core: Core,
  ) {
    super();
    const handler = (data: OpackDict) => this._handleTextInput(data);
    // _tiStarted will not be sent if session is started while already focused
    this.api.listenTo("_tiStarted", handler);
    this.api.listenTo("_tiStopped", handler);
    // _tiStart is actually a command that we forward the response of
    this.api.listenTo("_tiStart", handler);
  }

  private async _handleTextInput(data: OpackDict): Promise<void> {
    const state = "_tiD" in data ? KeyboardFocusState.Focused : KeyboardFocusState.Unfocused;
    this._focusState = state;
    this.core.stateDispatcher.dispatch(UpdatedState.KeyboardFocus, state);
  }

  /** Return keyboard focus state. */
  override get textFocusState(): KeyboardFocusState {
    return this._focusState;
  }

  /** Get current virtual keyboard text. */
  override async textGet(): Promise<string | null> {
    return this.api.textInputCommand("", false);
  }

  /** Clear virtual keyboard text. */
  override async textClear(): Promise<void> {
    await this.api.textInputCommand("", true);
  }

  /** Input text into virtual keyboard. */
  override async textAppend(text: string): Promise<void> {
    await this.api.textInputCommand(text, false);
  }

  /** Replace text in virtual keyboard. */
  override async textSet(text: string): Promise<void> {
    await this.api.textInputCommand(text, true);
  }
}

/** Implementation of touch gesture API. */
export class CompanionTouchGestures extends TouchGestures {
  constructor(readonly api: CompanionAPI) {
    super();
  }

  /** Generate a touch swipe from start to end x,y coordinates (in range [0,1000]). */
  override async swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number): Promise<void> {
    await this.api.swipe(startX, startY, endX, endY, durationMs);
  }

  /** Generate a touch event to x,y coordinates (in range [0,1000]). */
  override async action(x: number, y: number, mode: TouchAction): Promise<void> {
    await this.api.action(x, y, mode);
  }

  /** Send a touch click. */
  override async click(action: InputAction): Promise<void> {
    await this.api.click(action);
  }
}

/** Implementation of supported feature functionality. */
export class CompanionFeatures extends Features {
  private _controlFlags: number = MediaControlFlags.NoControls;

  constructor(
    api: CompanionAPI,
    private readonly _power: CompanionPower,
  ) {
    super();
    api.listenTo("_iMC", async (data) => {
      this._controlFlags = Number(data._mcF);
      LOGGER.debug("Updated media control flags to %s", this._controlFlags);
    });
  }

  /** Return current state of a feature. */
  override getFeature(featureName: FeatureName): FeatureInfo {
    const flag = MEDIA_CONTROL_MAP.get(featureName);
    if (flag !== undefined) {
      return new FeatureInfo(flag & this._controlFlags ? FeatureState.Available : FeatureState.Unavailable);
    }

    if (featureName === FeatureName.PowerState) {
      return new FeatureInfo(this._power.supportsPowerUpdates ? FeatureState.Available : FeatureState.Unsupported);
    }

    // Just assume these are available for now if the protocol is configured, we don't
    // have any way to verify it anyways.
    if (SUPPORTED_FEATURES.has(featureName)) return new FeatureInfo(FeatureState.Available);

    return new FeatureInfo(FeatureState.Unavailable);
  }
}

/** Parse and return a new Companion service. */
export function companionServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn | null {
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties),
    Protocol.Companion,
    mdnsService.port,
    mdnsService.properties,
  );
  return [mdnsService.name, service];
}

/** Return handlers used for scanning. */
export function scan(): Record<string, ScanHandlerDeviceInfoName> {
  return { "_companion-link._tcp.local": [companionServiceHandler, deviceInfoNameFromUniqueShortName] };
}

type Props = Record<string, string> | Map<string, string>;

function prop(properties: Props, key: string): string | undefined {
  if (properties instanceof Map) return properties.get(key);
  return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
}

/** Return device information from zeroconf properties. */
export function deviceInfo(_serviceType: string, properties: Props): Record<string, unknown> {
  const devinfo: Record<string, unknown> = {};
  const rpmd = prop(properties, "rpmd");
  if (rpmd !== undefined) {
    const model = lookupModel(rpmd);
    devinfo[DeviceInfo.RAW_MODEL] = rpmd;
    if (model !== DeviceModel.Unknown) devinfo[DeviceInfo.MODEL] = model;
  }
  return devinfo;
}

/** Update service with additional information. */
export async function serviceInfo(
  service: MutableService,
  _devinfo: DeviceInfo,
  _services: Map<Protocol, BaseService>,
): Promise<void> {
  const flags = parseInt(prop(service.properties, "rpfl") ?? "0x0", 16);
  if (flags & PAIRING_DISABLED_MASK) service.pairing = PairingRequirement.Disabled;
  else if (flags & PAIRING_WITH_PIN_SUPPORTED_MASK) service.pairing = PairingRequirement.Mandatory;
  else service.pairing = PairingRequirement.Unsupported;
}

/** Set up a new Companion service. */
export function* setup(core: Core): Generator<SetupData> {
  // Companion doesn't work without credentials, so don't setup if none exists
  if (!core.service.credentials) {
    LOGGER.debug("Not adding Companion as credentials are missing");
    return;
  }

  const api = new CompanionAPI(core);
  const power = new CompanionPower(api);

  const interfaces = new Map<unknown, unknown>([
    [Apps, new CompanionApps(api)],
    [UserAccounts, new CompanionUserAccounts(api)],
    [Features, new CompanionFeatures(api, power)],
    [Power, power],
    [RemoteControl, new CompanionRemoteControl(api)],
    [Audio, new CompanionAudio(api, core)],
    [Keyboard, new CompanionKeyboard(api, core)],
    [TouchGestures, new CompanionTouchGestures(api)],
  ]);

  yield {
    protocol: Protocol.Companion,
    connect: async () => {
      await api.connect();
      await power.initialize();
      return true;
    },
    close: () => new Set([api.disconnect()]),
    deviceInfo: () => deviceInfo(Object.keys(scan())[0]!, core.service.properties),
    interfaces,
    features: SUPPORTED_FEATURES,
  };
}

/** Return pairing handler for protocol. */
export function pair(core: Core, options: Record<string, unknown> = {}): PairingHandler {
  return new CompanionPairingHandler(core, options);
}

registerProtocol(Protocol.Companion, { setup, scan, pair, deviceInfo, serviceInfo });
