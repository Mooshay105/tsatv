/** High level implementation of Companion API. */

import { randomInt } from "node:crypto";
import { parseCredentials } from "../../auth/hap_pairing.ts";
import { SRPAuthHandler } from "../../auth/hap_srp.ts";
import { InputAction, TouchAction } from "../../const.ts";
import type { Core } from "../../core/index.ts";
import { MessageDispatcher } from "../../core/protocol.ts";
import { ProtocolError } from "../../exceptions.ts";
import { sleep } from "../../support/asyncio.ts";
import { Float } from "../../support/float.ts";
import { getLogger } from "../../support/logging.ts";
import { isUrlOrScheme } from "../../support/url.ts";
import { readArchiveProperties } from "./keyed_archiver.ts";
import { CompanionConnection, FrameType } from "./connection.ts";
import { getRtiClearTextPayload, getRtiInputTextPayload } from "./plist_payloads.ts";
import { CompanionProtocol, type CompanionProtocolListener, MessageType, type OpackDict } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.companion.api");

/** HID command constants. */
export enum HidCommand {
  Up = 1,
  Down = 2,
  Left = 3,
  Right = 4,
  Menu = 5,
  Select = 6,
  Home = 7,
  VolumeUp = 8,
  VolumeDown = 9,
  Siri = 10,
  Screensaver = 11,
  Sleep = 12,
  Wake = 13,
  PlayPause = 14,
  ChannelIncrement = 15,
  ChannelDecrement = 16,
  Guide = 17,
  PageUp = 18,
  PageDown = 19,
}

/** Media Control command constants. */
export enum MediaControlCommand {
  Play = 1,
  Pause = 2,
  NextTrack = 3,
  PreviousTrack = 4,
  GetVolume = 5,
  SetVolume = 6,
  SkipBy = 7,
  FastForwardBegin = 8,
  FastForwardEnd = 9,
  RewindBegin = 10,
  RewindEnd = 11,
  GetCaptionSettings = 12,
  SetCaptionSettings = 13,
}

/** Current system state. */
export enum SystemStatus {
  Unknown = 0x00, // NB: Not a valid protocol entry (only used here)
  Asleep = 0x01,
  Screensaver = 0x02,
  Awake = 0x03,
  Idle = 0x04, // NB: Not verified
}

export const TOUCHPAD_WIDTH = 1000.0; // Touchpad width
export const TOUCHPAD_HEIGHT = 1000.0; // Touchpad height
export const TOUCHPAD_DELAY_MS = 16; // Delay between touch events in ms

// Wall clock time in nanoseconds (like time.time_ns), but based on a monotonic clock
// so that it never goes backwards
const HRTIME_OFFSET = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
const timeNs = (): bigint => process.hrtime.bigint() + HRTIME_OFFSET;

/** Implementation of Companion API. */
export class CompanionAPI extends MessageDispatcher<string, OpackDict> implements CompanionProtocolListener {
  private _connection: CompanionConnection | null = null;
  private _protocol: CompanionProtocol | null = null;
  private readonly _subscribedEvents: string[] = [];
  sid: bigint = 0n;
  private _baseTimestamp: bigint = timeNs();

  constructor(readonly core: Core) {
    super();
  }

  /** Disconnect from companion device. */
  async disconnect(): Promise<void> {
    if (this._protocol === null) return;

    try {
      for (const event of [...this._subscribedEvents]) await this.unsubscribeEvent(event);

      // Sometimes unsubscribe fails for an unknown reason, but we are not going to
      // bother with that and just swallow the error.
      await this._sessionStop();

      await this._touchStop();
      await this._textInputStop();
    } catch (ex) {
      LOGGER.debug("Ignoring error during disconnect: %s", ex);
    } finally {
      this._protocol?.stop();
      this._protocol = null;
    }
  }

  /** Event was received. */
  eventReceived(eventName: string, data: Record<string, unknown>): void {
    LOGGER.debug("Got event %s from device: %s", eventName, data);
    this.dispatch(eventName, data);
  }

  /** Connect to remote host. */
  async connect(): Promise<void> {
    if (this._protocol) return;

    LOGGER.debug("Connect to Companion from API");
    this._connection = new CompanionConnection(this.core.config.address, this.core.service.port, this.core.deviceListener);
    this._protocol = new CompanionProtocol(this._connection, new SRPAuthHandler(), this.core.service);
    this._protocol.listener = this;
    await this._protocol.start();

    await this.systemInfo();
    await this._touchStart();
    await this._sessionStart();
    // Text input must be started before the TV Remote Client session, otherwise
    // keyboard focus events (_tiStarted/_tiStopped) are no longer delivered to us
    // (regression in pyatv 0.17.0 when TVRCSessionStart was added, see pyatv #2853)
    await this._textInputStart();
    await this._tvRcSessionStart();

    await this.subscribeEvent("_iMC");
  }

  /** Send a command to the device and return response. */
  private async _sendCommand(identifier: string, content: OpackDict, messageType = MessageType.Request): Promise<OpackDict> {
    await this.connect();
    if (this._protocol === null) throw new Error("not connected to companion");

    try {
      return await this._protocol.exchangeOpack(FrameType.E_OPACK, { _i: identifier, _t: messageType, _c: content });
    } catch (ex) {
      if (ex instanceof ProtocolError) throw ex;
      throw new ProtocolError(`Command ${identifier} failed`, { cause: ex });
    }
  }

  /** Send system information to device. */
  async systemInfo(): Promise<void> {
    LOGGER.debug("Sending system information");
    const creds = parseCredentials(this.core.service.credentials);
    const info = this.core.settings.info;

    // Bunch of semi-random values here...
    await this._sendCommand("_systemInfo", {
      _bf: 0,
      _cf: 512,
      _clFl: 128,
      // A null "_i" stops the device from pushing TVSystemStatus (power state) events;
      // fall back to a stable identifier.
      _i: info.rp_id || info.device_id.replaceAll(":", "").toLowerCase(),
      _idsID: creds.clientId,
      // Not really device id here, but better then anything...
      _pubID: info.device_id,
      _sf: 256, // Status flags?
      _sv: "170.18", // Software Version (I guess?)
      model: info.model,
      name: info.name,
    });
  }

  private async _sessionStart(): Promise<void> {
    const localSid = randomInt(0, 2 ** 32 - 1);
    const resp = await this._sendCommand("_sessionStart", { _srvT: "com.apple.tvremoteservices", _sid: localSid });

    const content = resp._c;
    if (content === undefined || content === null) throw new ProtocolError("missing content");

    const remoteSid = BigInt(content._sid);
    this.sid = (remoteSid << 32n) | BigInt(localSid);
    LOGGER.debug("Started session with SID 0x%s", this.sid.toString(16).toUpperCase());
  }

  /**
   * Open a TV Remote Client session.
   *
   * tvOS does not answer FetchAttentionState until a TV Remote Client session is
   * registered with the tvremoted process.
   */
  private async _tvRcSessionStart(): Promise<void> {
    try {
      const resp = await this._sendCommand("TVRCSessionStart", { ProtocolVersionKey: "1.2" });
      LOGGER.debug("Started TV RC session: %s", resp._c);
    } catch (ex) {
      LOGGER.debug("TVRCSessionStart not supported: %s", ex);
    }
  }

  private async _sessionStop(): Promise<void> {
    await this._sendCommand("_sessionStop", { _srvT: "com.apple.tvremoteservices", _sid: this.sid });
    LOGGER.debug("Stopped session with SID 0x%s", this.sid.toString(16).toUpperCase());
  }

  /** Send an event to the device. */
  private async _sendEvent(identifier: string, content: OpackDict): Promise<void> {
    await this.connect();
    if (this._protocol === null) throw new Error("not connected to companion");

    try {
      this._protocol.sendOpack(FrameType.E_OPACK, { _i: identifier, _t: MessageType.Event, _c: content });
    } catch (ex) {
      if (ex instanceof ProtocolError) throw ex;
      throw new ProtocolError("Send event failed", { cause: ex });
    }
  }

  /** Subscribe to updates to an event. */
  async subscribeEvent(event: string): Promise<void> {
    if (!this._subscribedEvents.includes(event)) {
      await this._sendEvent("_interest", { _regEvents: [event] });
      this._subscribedEvents.push(event);
    }
  }

  /** Unsubscribe to updates to an event. */
  async unsubscribeEvent(event: string): Promise<void> {
    const index = this._subscribedEvents.indexOf(event);
    if (index >= 0) {
      await this._sendEvent("_interest", { _deregEvents: [event] });
      this._subscribedEvents.splice(index, 1);
    }
  }

  /** Launch an app on the remote device. */
  async launchApp(bundleIdentifierOrUrl: string): Promise<void> {
    const key = isUrlOrScheme(bundleIdentifierOrUrl) ? "_urlS" : "_bundleID";
    await this._sendCommand("_launchApp", { [key]: bundleIdentifierOrUrl });
  }

  /** Return list of launchable apps on remote device. */
  async appList(): Promise<OpackDict> {
    return this._sendCommand("FetchLaunchableApplicationsEvent", {});
  }

  /** Switch user account on the remote device. */
  async switchAccount(accountId: string): Promise<void> {
    await this._sendCommand("SwitchUserAccountEvent", { SwitchAccountID: accountId });
  }

  /** Return list of user accounts on remote device. */
  async accountList(): Promise<OpackDict> {
    return this._sendCommand("FetchUserAccountsEvent", {});
  }

  /** Send a HID command. */
  async hidCommand(down: boolean, command: HidCommand): Promise<void> {
    await this._sendCommand("_hidC", { _hBtS: down ? 1 : 2, _hidC: command });
  }

  /** Send a HID (touch) event. */
  async hidEvent(x: number, y: number, mode: TouchAction): Promise<void> {
    x = Math.min(Math.max(x, 0), Math.trunc(TOUCHPAD_WIDTH));
    y = Math.min(Math.max(y, 0), Math.trunc(TOUCHPAD_HEIGHT));
    await this._sendEvent("_hidT", {
      _ns: timeNs() - this._baseTimestamp,
      _tFg: 1,
      _cx: x,
      _tPh: mode,
      _cy: y,
    });
  }

  /**
   * Generate a swipe gesture.
   *
   * From start to end x,y coordinates (in range [0,1000]) in a given time (in
   * milliseconds).
   */
  async swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number): Promise<void> {
    const endTime = timeNs() + BigInt(durationMs) * 1_000_000n;
    let x = startX;
    let y = startY;
    await this.hidEvent(Math.trunc(x), Math.trunc(y), TouchAction.Press);
    const sleepTime = TOUCHPAD_DELAY_MS / 1000;
    // Without a delay between press and the first hold event, the device sometimes
    // interprets the start of the gesture as movement in the opposite direction
    await sleep(sleepTime);
    let currentTime = timeNs();
    while (currentTime < endTime) {
      const remaining = Number(endTime - currentTime);
      x = x + ((endX - x) * TOUCHPAD_DELAY_MS * 1_000_000) / remaining;
      y = y + ((endY - y) * TOUCHPAD_DELAY_MS * 1_000_000) / remaining;
      x = Math.min(Math.max(x, 0), TOUCHPAD_WIDTH);
      y = Math.min(Math.max(y, 0), TOUCHPAD_HEIGHT);
      await this.hidEvent(Math.trunc(x), Math.trunc(y), TouchAction.Hold);
      await sleep(sleepTime);
      currentTime = timeNs();
    }
    // Release at the end position, clamped and rounded the same way as hold events
    const releaseX = Math.trunc(Math.min(Math.max(endX, 0), TOUCHPAD_WIDTH));
    const releaseY = Math.trunc(Math.min(Math.max(endY, 0), TOUCHPAD_HEIGHT));
    await this.hidEvent(releaseX, releaseY, TouchAction.Release);
  }

  /** Generate a touch event to x,y coordinates (in range [0,1000]). */
  async action(x: number, y: number, mode: TouchAction): Promise<void> {
    await this.hidEvent(x, y, mode);
  }

  /** Send a touch click (single tap, double tap or hold). */
  async click(action: InputAction): Promise<void> {
    if (action === InputAction.SingleTap || action === InputAction.DoubleTap) {
      const count = action === InputAction.SingleTap ? 1 : 2;
      for (let i = 0; i < count; i++) {
        await this._sendCommand("_hidC", { _hBtS: 1, _hidC: 6 });
        await sleep(0.02);
        await this._sendCommand("_hidC", { _hBtS: 2, _hidC: 6 });
        await this.hidEvent(Math.trunc(TOUCHPAD_WIDTH), Math.trunc(TOUCHPAD_HEIGHT), TouchAction.Click);
      }
    } else {
      // Hold
      await this._sendCommand("_hidC", { _hBtS: 1, _hidC: 6 });
      await sleep(1);
      await this._sendCommand("_hidC", { _hBtS: 2, _hidC: 6 });
      await this.hidEvent(Math.trunc(TOUCHPAD_WIDTH), Math.trunc(TOUCHPAD_HEIGHT), TouchAction.Click);
    }
  }

  /** Send a media control command. */
  async mediacontrolCommand(command: MediaControlCommand, args: OpackDict | null = null): Promise<OpackDict> {
    return this._sendCommand("_mcc", { _mcc: command, ...(args ?? {}) });
  }

  private async _textInputStart(): Promise<OpackDict> {
    const response = await this._sendCommand("_tiStart", {});
    await Promise.all(this.dispatch("_tiStart", response._c ?? {}));
    return response;
  }

  private async _textInputStop(): Promise<void> {
    await this._sendCommand("_tiStop", {});
  }

  /** Send a text input command. */
  async textInputCommand(text: string, clearPreviousInput = false): Promise<string | null> {
    // Restart the text input session so that we have up-to-date data
    await this._textInputStop();
    const response = await this._textInputStart();
    const tiData = response._c?._tiD;

    if (tiData === undefined || tiData === null) return null;

    const [sessionUuid, contextText] = readArchiveProperties(
      tiData,
      ["sessionUUID"],
      ["documentState", "docSt", "contextBeforeInput"],
    ) as [Buffer, string | null];
    let currentText = contextText ?? "";

    if (clearPreviousInput) {
      await this._sendEvent("_tiC", { _tiV: 1, _tiD: getRtiClearTextPayload(sessionUuid) });
      currentText = "";
    }

    if (text) {
      await this._sendEvent("_tiC", { _tiV: 1, _tiD: getRtiInputTextPayload(sessionUuid, text) });
      currentText += text;
    }

    return currentText;
  }

  /** Fetch attention state from device (system status). */
  async fetchAttentionState(): Promise<SystemStatus> {
    const resp = await this._sendCommand("FetchAttentionState", {});
    const content = resp._c;
    if (content === undefined || content === null) throw new ProtocolError("missing content");
    const state = content.state;
    if (!(state in SystemStatus)) throw new ProtocolError(`unknown system status: ${state}`);
    return state as SystemStatus;
  }

  /** Subscribe to touch gestures. */
  private async _touchStart(): Promise<OpackDict> {
    this._baseTimestamp = timeNs();
    return this._sendCommand("_touchStart", {
      _height: new Float(TOUCHPAD_HEIGHT),
      _tFl: 0,
      _width: new Float(TOUCHPAD_WIDTH),
    });
  }

  /** Unsubscribe touch gestures. */
  private async _touchStop(): Promise<void> {
    await this._sendCommand("_touchStop", { _i: 1 });
  }
}
