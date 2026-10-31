/** Fake Companion Apple TV for tests. */

import { KeyboardFocusState, Protocol, TouchAction } from "../../src/const.ts";
import { HidCommand, MediaControlCommand, SystemStatus } from "../../src/protocols/companion/api.ts";
import { FrameType } from "../../src/protocols/companion/connection.ts";
import { MediaControlFlags } from "../../src/protocols/companion/index.ts";
import { readArchiveProperties } from "../../src/protocols/companion/keyed_archiver.ts";
import { CompanionServerAuth } from "../../src/protocols/companion/server_auth.ts";
import * as chacha20 from "../../src/support/chacha20.ts";
import { logBinary } from "../../src/support/index.ts";
import { getLogger } from "../../src/support/logging.ts";
import * as opack from "../../src/support/opack.ts";
import * as plistlib from "../../src/support/plistlib.ts";
import { createServer, type Protocol as TransportProtocol, type Server, type Transport } from "../../src/support/transport.ts";
import { registerFake } from "./index.ts";
import type { WebApp } from "./web.ts";

const LOGGER = getLogger("tests.fake_device.companion");

export const DEVICE_NAME = "Fake Companion ATV";
export const INITIAL_VOLUME = 10.0;
export const INITIAL_DURATION = 10.0;
export const VOLUME_STEP = 5.0;
export const INITIAL_RTI_TEXT = "Fake Companion Keyboard Text";

const COMPANION_AUTH_FRAMES = [FrameType.PS_Start, FrameType.PS_Next, FrameType.PV_Start, FrameType.PV_Next];

export const HID_BUTTON_MAP = new Map<HidCommand, string>([
  [HidCommand.Up, "up"],
  [HidCommand.Down, "down"],
  [HidCommand.Left, "left"],
  [HidCommand.Right, "right"],
  [HidCommand.Select, "select"],
  [HidCommand.Menu, "menu"],
  [HidCommand.Home, "home"],
  [HidCommand.VolumeDown, "volume_down"],
  [HidCommand.VolumeUp, "volume_up"],
  [HidCommand.PlayPause, "play_pause"],
  [HidCommand.ChannelIncrement, "channel_up"],
  [HidCommand.ChannelDecrement, "channel_down"],
  [HidCommand.Screensaver, "screensaver"],
  [HidCommand.Guide, "guide"],
  [HidCommand.PageDown, "control_center"],
]);

export const MEDIA_CONTROL_MAP = new Map<MediaControlCommand, string>([
  [MediaControlCommand.Play, "play"],
  [MediaControlCommand.Pause, "pause"],
  [MediaControlCommand.NextTrack, "next"],
  [MediaControlCommand.PreviousTrack, "previous"],
  [MediaControlCommand.SetVolume, "set_volume"],
  [MediaControlCommand.SkipBy, "skip"],
]);

export interface HidEvent {
  pressMode: TouchAction;
  x: number;
  y: number;
  ns: number | bigint;
}

/** Flags used to alter fake service behavior. */
export enum CompanionServiceFlags {
  /** Empty service flag. */
  EMPTY = 1,
  /** If system status is supported. */
  SYSTEM_STATUS_SUPPORTED = 2,
}

type Message = Record<string, any>;

export class FakeCompanionState {
  flags: number = CompanionServiceFlags.EMPTY | CompanionServiceFlags.SYSTEM_STATUS_SUPPORTED;
  clients: FakeCompanionService[] = [];
  private _systemStatus: SystemStatus = SystemStatus.Awake;
  activeApp: string | null = null;
  openUrl: string | null = null;
  installedApps: Record<string, string> = {};
  activeAccount: string | null = null;
  availableAccounts: Record<string, string> = {};
  hasPaired = false;
  poweredOn = true;
  sid = 0;
  serviceType: string | null = null;
  systemInfo: Message | null = null;
  tvRcProtocolVersion: string | null = null;
  latestButton: string | null = null;
  mediaControlFlags: number = MediaControlFlags.Volume;
  interests = new Set<string>();
  volume: number = INITIAL_VOLUME;
  duration: number = INITIAL_DURATION;
  rtiClients: FakeCompanionService[] = [];
  private _rtiFocusState: KeyboardFocusState = KeyboardFocusState.Focused;
  rtiText: string | null = INITIAL_RTI_TEXT;
  rtiSessionUuid: Buffer | null = null;
  touchEvent: HidEvent | null = null;
  action: HidEvent | null = null;
  touchWidth = 0;
  touchHeight = 0;

  /** Return if a feature is supported. */
  isSupported(flag: CompanionServiceFlags): boolean {
    return (this.flags & flag) !== 0;
  }

  /** Set if a feature is supported or not. */
  setFlagState(flag: CompanionServiceFlags, enabled: boolean): void {
    if (enabled) this.flags |= flag;
    else this.flags &= ~flag;
  }

  get systemStatus(): SystemStatus {
    return this._systemStatus;
  }

  set systemStatus(value: SystemStatus) {
    this._systemStatus = value;

    // Only send event updates if feature is supported
    if (this.isSupported(CompanionServiceFlags.SYSTEM_STATUS_SUPPORTED)) {
      for (const client of this.clients) client.sendEvent("SystemStatus", 1234, { state: this.systemStatus });
    }
  }

  private _sendRti(identifier: string, content: Message): void {
    for (const client of this.rtiClients) client.sendEvent(identifier, 1234, content);
  }

  get rtiFocusState(): KeyboardFocusState {
    return this._rtiFocusState;
  }

  set rtiFocusState(value: KeyboardFocusState) {
    if (value === this._rtiFocusState) return;
    this._rtiFocusState = value;
    if (value === KeyboardFocusState.Focused) this._sendRti("_tiStarted", this.rtiEncodedData);
    else if (value === KeyboardFocusState.Unfocused) this._sendRti("_tiStopped", this.rtiEncodedData);
  }

  get rtiEncodedData(): Message {
    if (this.rtiFocusState !== KeyboardFocusState.Focused) return {};

    const objects =
      this.rtiText !== null
        ? ["$null", this.rtiSessionUuid, { docSt: new plistlib.UID(3) }, { contextBeforeInput: new plistlib.UID(4) }, this.rtiText]
        : [{}];
    return {
      _tiD: plistlib.dumps(
        {
          $top: { sessionUUID: new plistlib.UID(1), documentState: new plistlib.UID(2) },
          $objects: objects,
        },
        { fmt: plistlib.PlistFormat.BINARY, sortKeys: false },
      ),
    };
  }

  get touchEventState(): HidEvent | null {
    return this.touchEvent;
  }
}

export class FakeCompanionServiceFactory {
  server: Server | null = null;

  constructor(
    readonly state: FakeCompanionState,
    readonly app: WebApp,
  ) {}

  async start(_startWebServer: boolean): Promise<void> {
    this.server = await createServer(() => new FakeCompanionService(this.state), "0.0.0.0", 0);
    LOGGER.info("Started Companion server at port %d", this.port);
  }

  async cleanup(): Promise<void> {
    this.server?.close();
  }

  get port(): number {
    return this.server!.port;
  }
}

/** Implementation of a fake Companion Apple TV. */
export class FakeCompanionService extends CompanionServerAuth implements TransportProtocol {
  private buffer: Buffer = Buffer.alloc(0);
  private chacha: chacha20.Chacha20Cipher | null = null;
  transport: Transport | null = null;
  private readonly pressedButtons = new Set<HidCommand>();
  private readonly handlers: Record<string, (message: Message) => void>;

  constructor(readonly state: FakeCompanionState) {
    super(DEVICE_NAME);
    // Handler name is based on lower case identifier (like handle_<identifier> in pyatv)
    this.handlers = {
      _launchapp: (m) => this.handleLaunchApp(m),
      fetchlaunchableapplicationsevent: (m) => this.sendResponse(m, this.state.installedApps),
      switchuseraccountevent: (m) => this.handleSwitchUserAccount(m),
      fetchuseraccountsevent: (m) => this.sendResponse(m, this.state.availableAccounts),
      _hidc: (m) => this.handleHidC(m),
      _touchstart: (m) => this.handleTouchStart(m),
      _touchstop: (m) => this.sendResponse(m, {}),
      _hidt: (m) => this.handleHidT(m),
      _mcc: (m) => this.handleMcc(m),
      _sessionstart: (m) => this.handleSessionStart(m),
      _sessionstop: (m) => this.handleSessionStop(m),
      _systeminfo: (m) => this.handleSystemInfo(m),
      tvrcsessionstart: (m) => this.handleTvRcSessionStart(m),
      _interest: (m) => this.handleInterest(m),
      _tistart: (m) => this.handleTiStart(m),
      _tistop: (m) => this.handleTiStop(m),
      _tic: (m) => this.handleTiC(m),
      fetchattentionstate: (m) => this.handleFetchAttentionState(m),
    };
  }

  connectionMade(transport: Transport): void {
    LOGGER.debug("Client connected");
    this.transport = transport;
    this.state.clients.push(this);
  }

  connectionLost(_exc: Error | null): void {
    LOGGER.debug("Client disconnected");
    this.transport = null;
    const index = this.state.clients.indexOf(this);
    if (index >= 0) this.state.clients.splice(index, 1);
  }

  /** Enable encryption with specified keys. */
  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this.chacha = new chacha20.Chacha20Cipher(outputKey, inputKey, 12);
  }

  /** Call when a client has paired. */
  override hasPaired(): void {
    this.state.hasPaired = true;
  }

  sendToClient(frameType: FrameType, data: Record<string, unknown>): void {
    LOGGER.debug("Send %s with data: %s", FrameType[frameType], data);

    let payload = opack.pack(data);
    const header = Buffer.alloc(4);
    header[0] = frameType;
    header.writeUIntBE(payload.length + (this.chacha ? 16 : 0), 1, 3);

    if (this.chacha) payload = this.chacha.encrypt(payload, null, header);

    logBinary(LOGGER, ">> Send", { Header: header, Data: payload });
    this.transport?.write(Buffer.concat([header, payload]));
  }

  dataReceived(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length > 0) {
      const payloadLength = 4 + this.buffer.readUIntBE(1, 3);
      if (this.buffer.length < payloadLength) {
        LOGGER.debug("Expect %d bytes, have %d bytes", payloadLength, this.buffer.length);
        break;
      }

      const frameType = this.buffer[0] as FrameType;
      const header = this.buffer.subarray(0, 4);
      let payload = this.buffer.subarray(4, payloadLength);
      this.buffer = this.buffer.subarray(payloadLength);

      try {
        if (this.chacha) payload = this.chacha.decrypt(payload, null, header);
        const [unpacked] = opack.unpack(payload);

        if (COMPANION_AUTH_FRAMES.includes(frameType)) {
          this.handleAuthFrame(frameType, unpacked);
        } else {
          if (!this.chacha) throw new Error("client has not authenticated");

          LOGGER.debug("Received OPACK: %s", unpacked);
          const handler = this.handlers[String(unpacked._i).toLowerCase()];
          if (handler) handler(unpacked);
          else this.sendHandlerNotSupported(unpacked);
        }
      } catch (ex) {
        LOGGER.exception("failed to handle incoming data: %s", ex);
      }
    }
  }

  sendResponse(request: Message, content: unknown): void {
    this.sendToClient(FrameType.E_OPACK, { _i: request._i, _x: request._x, _t: 3, _c: content });
  }

  sendEvent(identifier: string, xid: number, content: unknown): void {
    this.sendToClient(FrameType.E_OPACK, { _i: identifier, _x: xid, _t: 1, _c: content });
  }

  sendError(request: Message, message: string, code = 1337, domain = "RPErrorDomain"): void {
    this.sendToClient(FrameType.E_OPACK, { _i: request._i, _x: request._x, _t: 3, _ec: code, _ed: domain, _em: message });
  }

  sendHandlerNotSupported(request: Message): void {
    LOGGER.warning("No handler for type %s", request._i);
    this.sendError(request, "No request handler", 58822);
  }

  volumeChanged(newVolume: number): void {
    this.state.volume = Math.min(Math.max(newVolume, 0.0), 100.0);
    LOGGER.debug("Volume changed to %f", this.state.volume);
    this.sendEvent("_iMC", 1234, { _mcF: this.state.mediaControlFlags | MediaControlFlags.Volume });
  }

  private handleLaunchApp(message: Message): void {
    const bundleId = message._c._bundleID;
    const url = message._c._urlS;
    if (bundleId !== undefined) this.state.activeApp = bundleId;
    else if (url !== undefined) this.state.openUrl = url;
    this.sendResponse(message, {});
  }

  private handleSwitchUserAccount(message: Message): void {
    this.state.activeAccount = message._c.SwitchAccountID ?? null;
    this.sendResponse(message, {});
  }

  private handleHidC(message: Message): void {
    const buttonState = message._c._hBtS;
    const buttonCode = message._c._hidC as HidCommand;

    if (buttonState === 1) {
      LOGGER.debug("Button %s pressed DOWN", HidCommand[buttonCode]);
      this.pressedButtons.add(buttonCode);
    } else if (buttonState === 2 && buttonCode === HidCommand.Sleep) {
      LOGGER.debug("Putting device to sleep");
      this.state.poweredOn = false;
    } else if (buttonState === 2 && buttonCode === HidCommand.Wake) {
      LOGGER.debug("Waking up device");
      this.state.poweredOn = true;
    } else if (HID_BUTTON_MAP.has(buttonCode)) {
      if (!this.pressedButtons.has(buttonCode)) {
        LOGGER.warning("Button UP with no DOWN action for %s", HidCommand[buttonCode]);
        this.sendError(message, `Missing button DOWN for ${HidCommand[buttonCode]}`);
        return;
      }

      LOGGER.debug("Button pressed: %s", HID_BUTTON_MAP.get(buttonCode));
      this.pressedButtons.delete(buttonCode);
      this.state.latestButton = HID_BUTTON_MAP.get(buttonCode)!;

      // Buttons that change volume
      if (buttonCode === HidCommand.VolumeUp) this.volumeChanged(this.state.volume + VOLUME_STEP);
      else if (buttonCode === HidCommand.VolumeDown) this.volumeChanged(this.state.volume - VOLUME_STEP);
    } else {
      LOGGER.warning("Unhandled command: %d %s", buttonState, buttonCode);
      return; // Would be good to send error message here
    }

    this.sendResponse(message, {});
  }

  private handleTouchStart(message: Message): void {
    const width = message._c._width;
    const height = message._c._height;
    LOGGER.debug("Touch start command received with touchpad width %s and height %s", width, height);
    this.state.touchWidth = width;
    this.state.touchHeight = height;
    if (!width || width < 0 || width > 1000 || !height || height < 0 || height > 1000) {
      this.sendError(message, "Invalid touchpad width or height");
    } else {
      this.sendResponse(message, {});
    }
  }

  private handleHidT(message: Message): void {
    const pressMode: number = message._c._tPh;
    const { _ns: ns, _cx: cx, _cy: cy } = message._c;
    LOGGER.debug("Touch event %s to (%s, %s) at time %s", TouchAction[pressMode] ?? pressMode, cx, cy, ns);
    this.state.action = { pressMode: pressMode as TouchAction, x: cx, y: cy, ns };
  }

  private handleMcc(message: Message): void {
    const args: Message = {};
    const mcc = message._c._mcc as MediaControlCommand;

    if (mcc === MediaControlCommand.SetVolume) {
      // Make sure we send response before triggering event with volume update
      const volume = Number(message._c._vol) * 100.0;
      setImmediate(() => this.volumeChanged(volume));
    } else if (mcc === MediaControlCommand.GetVolume) {
      args._vol = this.state.volume / 100.0;
    } else if (mcc === MediaControlCommand.SkipBy) {
      this.state.duration = Math.max(0, this.state.duration + Number(message._c._skpS));
    } else if (MEDIA_CONTROL_MAP.has(mcc)) {
      LOGGER.debug("Activated Media Control Command %s", MediaControlCommand[mcc]);
      this.state.latestButton = MEDIA_CONTROL_MAP.get(mcc)!;
    } else {
      LOGGER.warning("Unsupported Media Control Code: %s", mcc);
      return;
    }

    this.sendResponse(message, args);
  }

  private handleSessionStart(message: Message): void {
    this.state.sid = Number(message._c._sid);
    this.state.serviceType = message._c._srvT;
    this.sendResponse(message, { _sid: 5555 });
  }

  private handleSessionStop(message: Message): void {
    if (BigInt(message._c._sid) === ((5555n << 32n) | BigInt(this.state.sid))) {
      this.state.sid = 0;
      this.sendResponse(message, {});
    } else {
      this.sendError(message, "Invalid SID");
    }
  }

  private handleSystemInfo(message: Message): void {
    this.state.systemInfo = message._c;
    this.sendResponse(message, {});
  }

  private handleTvRcSessionStart(message: Message): void {
    this.state.tvRcProtocolVersion = message._c?.ProtocolVersionKey ?? null;
    this.sendResponse(message, message._c ?? {});
  }

  private handleInterest(message: Message): void {
    const content = message._c;
    if ("_regEvents" in content) {
      for (const event of content._regEvents) this.state.interests.add(event);
      if (this.state.interests.has("_iMC")) this.sendEvent("_iMC", message._x, { _mcF: this.state.mediaControlFlags });
    } else if ("_deregEvents" in content) {
      for (const event of content._deregEvents) this.state.interests.delete(event);
    }
  }

  private handleTiStart(message: Message): void {
    if (message._t !== 2) return;
    if (this.state.rtiText === null) {
      this.sendResponse(message, {});
      this.state.rtiClients.push(this);
    } else if (this.state.rtiSessionUuid !== null) {
      LOGGER.warning("RTI session already started");
    } else {
      this.state.rtiSessionUuid = Buffer.from("0123456789abcdef");
      this.sendResponse(message, this.state.rtiEncodedData);
      this.state.rtiClients.push(this);
    }
  }

  private handleTiStop(message: Message): void {
    if (message._t !== 2) return;
    if (this.state.rtiSessionUuid !== null) {
      this.state.rtiSessionUuid = null;
      this.sendResponse(message, {});
      const index = this.state.rtiClients.indexOf(this);
      if (index >= 0) this.state.rtiClients.splice(index, 1);
    } else {
      LOGGER.warning("No RTI session");
    }
  }

  private handleTiC(message: Message): void {
    if (message._t !== 1) return;

    const [sessionUuid, textToAssert, insertionText] = readArchiveProperties(
      message._c._tiD,
      ["textOperations", "targetSessionUUID", "NS.uuidbytes"],
      ["textOperations", "textToAssert"],
      ["textOperations", "keyboardOutput", "insertionText"],
    ) as [Buffer | null, string | null, string | null];

    if (!sessionUuid || !this.state.rtiSessionUuid || !sessionUuid.equals(this.state.rtiSessionUuid)) return;

    if (textToAssert === "") this.state.rtiText = "";
    if (insertionText !== null) this.state.rtiText = (this.state.rtiText ?? "") + insertionText;
  }

  private handleFetchAttentionState(message: Message): void {
    if (this.state.isSupported(CompanionServiceFlags.SYSTEM_STATUS_SUPPORTED)) {
      LOGGER.debug("Returning system status: %s", SystemStatus[this.state.systemStatus]);
      this.sendResponse(message, { state: this.state.systemStatus });
    } else {
      this.sendHandlerNotSupported(message);
    }
  }
}

/** Wrapper for altering behavior of a FakeCompanionService instance. */
export class FakeCompanionUseCases {
  constructor(readonly state: FakeCompanionState) {}

  /** Set which apps that are currently installed. */
  setInstalledApps(apps: Record<string, string>): void {
    this.state.installedApps = apps;
  }

  /** Set which user accounts are available. */
  setAvailableAccounts(accounts: Record<string, string>): void {
    this.state.availableAccounts = accounts;
  }

  /** Set media control flags. */
  setControlFlags(flags: number): void {
    this.state.mediaControlFlags = flags;
  }

  setRtiFocusState(state: KeyboardFocusState): void {
    this.state.rtiFocusState = state;
  }

  setRtiText(text: string | null): void {
    this.state.rtiText = text;
  }

  /** Set a specific system state. */
  setSystemStatus(systemStatus: SystemStatus): void {
    this.state.systemStatus = systemStatus;
  }
}

registerFake(
  Protocol.Companion,
  (state, app) => new FakeCompanionServiceFactory(state, app),
  () => new FakeCompanionState(),
  (state) => new FakeCompanionUseCases(state),
);
