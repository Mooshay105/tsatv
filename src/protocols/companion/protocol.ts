/** Implementation of the Companion protocol. */

import { randomInt } from "node:crypto";
import { parseCredentials } from "../../auth/hap_pairing.ts";
import type { SRPAuthHandler } from "../../auth/hap_srp.ts";
import { AuthenticationError, ProtocolError } from "../../exceptions.ts";
import type { BaseService } from "../../interface.ts";
import { SharedData } from "../../support/collections.ts";
import { errorHandler } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import * as opack from "../../support/opack.ts";
import { StateProducer } from "../../support/state_producer.ts";
import { CompanionPairVerifyProcedure } from "./auth.ts";
import { type CompanionConnection, type CompanionConnectionListener, FrameType } from "./connection.ts";

const LOGGER = getLogger("pyatv.protocols.companion.protocol");

const AUTH_FRAMES = [FrameType.PS_Start, FrameType.PS_Next, FrameType.PV_Start, FrameType.PV_Next];
const OPACK_FRAMES = [FrameType.U_OPACK, FrameType.E_OPACK, FrameType.P_OPACK];

export const DEFAULT_TIMEOUT = 5.0; // Seconds

export const SRP_SALT = "";
export const SRP_OUTPUT_INFO = "ClientEncrypt-main";
export const SRP_INPUT_INFO = "ServerEncrypt-main";

/** Type of message. */
export enum MessageType {
  Event = 1,
  Request = 2,
  Response = 3,
}

/** Listener interface for Companion protocol. */
export interface CompanionProtocolListener {
  /** Event was received. */
  eventReceived(eventName: string, data: Record<string, unknown>): void;
}

// Either an XID (number) or the frame type (FrameType) is used as an identifier when
// dispatching responses depending on what is supported by a frame. Authentication
// frames never have an XID as multiple authentication attempts cannot be made in
// parallel. Regular OPACK message are however asynchronous and can arrive in any order.
// Frame types are prefixed to not collide with XIDs.
type FrameId = number | `frame:${number}`;
const frameId = (frameType: FrameType): FrameId => `frame:${frameType}`;

export type OpackDict = Record<string, any>;

const isDict = (value: unknown): value is OpackDict =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Map);

/** Protocol logic related to Companion. */
export class CompanionProtocol extends StateProducer<CompanionProtocolListener> implements CompanionConnectionListener {
  private _xid: number = randomInt(0, 2 ** 16); // Don't know range here, just use something
  private _queues = new Map<FrameId, SharedData<unknown>>();
  private _isStarted = false;

  constructor(
    readonly connection: CompanionConnection,
    readonly srp: SRPAuthHandler,
    readonly service: BaseService,
  ) {
    super();
    this.connection.setListener(this);
  }

  /** Connect to device and listen to incoming messages. */
  async start(): Promise<void> {
    if (this._isStarted) throw new ProtocolError("Already started");

    this._isStarted = true;
    await this.connection.connect();

    if (this.service.credentials) {
      this.srp.pairingId = parseCredentials(this.service.credentials).clientId;
    }

    LOGGER.debug("Companion credentials: %s", this.service.credentials);

    await errorHandler(() => this._setupEncryption(), AuthenticationError);
  }

  /** Disconnect from device. */
  stop(): void {
    this._queues = new Map();
    this.connection.close();
  }

  private async _setupEncryption(): Promise<void> {
    if (this.service.credentials) {
      const credentials = parseCredentials(this.service.credentials);
      const pairVerifier = new CompanionPairVerifyProcedure(this, this.srp, credentials);

      await pairVerifier.verifyCredentials();
      const [outputKey, inputKey] = pairVerifier.encryptionKeys(SRP_SALT, SRP_OUTPUT_INFO, SRP_INPUT_INFO);
      this.connection.enableEncryption(outputKey, inputKey);
    }
  }

  /** Exchange an auth frame (PS_* or PV_*). */
  async exchangeAuth(frameType: FrameType, data: OpackDict, timeout = DEFAULT_TIMEOUT): Promise<OpackDict> {
    // Authentication frames have strange logic as *_Start is only used for first
    // message, then *_Next is used for remaining message (even response to first
    // message)
    let identifier: FrameType;
    if (frameType === FrameType.PS_Start) identifier = FrameType.PS_Next;
    else if (frameType === FrameType.PV_Start) identifier = FrameType.PV_Next;
    else identifier = frameType;
    return this._exchangeGenericOpack(frameType, data, frameId(identifier), timeout);
  }

  /** Send data as OPACK and decode result as OPACK. */
  async exchangeOpack(frameType: FrameType, data: OpackDict, timeout = DEFAULT_TIMEOUT): Promise<OpackDict> {
    data._x = this._xid;
    const identifier = this._xid;
    this._xid += 1;
    return this._exchangeGenericOpack(frameType, data, identifier, timeout);
  }

  private async _exchangeGenericOpack(frameType: FrameType, data: OpackDict, identifier: FrameId, timeout: number): Promise<OpackDict> {
    LOGGER.debug("Exchange OPACK: %s", data);

    this.sendOpack(frameType, data);
    const shared = new SharedData<unknown>();
    this._queues.set(identifier, shared);
    const unpackedObject = await shared.wait(timeout);

    if (!isDict(unpackedObject)) {
      throw new ProtocolError(`Received unexpected type: ${typeof unpackedObject}`);
    }
    if ("_em" in unpackedObject) throw new ProtocolError(`Command failed: ${unpackedObject._em}`);
    return unpackedObject;
  }

  /** Send data encoded with OPACK. */
  sendOpack(frameType: FrameType, data: OpackDict): void {
    // Add XID if not present
    if (!("_x" in data)) {
      data._x = this._xid;
      this._xid += 1;
    }

    LOGGER.debug("Send OPACK: %s", data);
    this.connection.send(frameType, opack.pack(data));
  }

  /** Frame was received from remote device. */
  frameReceived(frameType: FrameType, data: Buffer): void {
    LOGGER.debug("Received frame %s: %s", FrameType[frameType] ?? frameType, data);

    if (OPACK_FRAMES.includes(frameType) || AUTH_FRAMES.includes(frameType)) {
      try {
        const [opackData] = opack.unpack(data);
        if (!isDict(opackData)) {
          LOGGER.debug("Unsupported OPACK base type: %s", typeof opackData);
          return;
        }

        if (AUTH_FRAMES.includes(frameType)) this._handleAuth(frameType, opackData);
        else this._handleOpack(frameType, opackData);
      } catch (ex) {
        LOGGER.exception("failed to process frame: %s", ex);
      }
    } else {
      LOGGER.debug("Received unsupported frame type: %s", frameType);
    }
  }

  private _handleAuth(frameType: FrameType, opackData: OpackDict): void {
    LOGGER.debug("Process incoming auth frame (%s): %s", FrameType[frameType], opackData);
    const shared = this._queues.get(frameId(frameType));
    if (shared) {
      this._queues.delete(frameId(frameType));
      shared.set(opackData);
    } else {
      LOGGER.warning("No receiver for auth frame %s", FrameType[frameType]);
    }
  }

  private _handleOpack(frameType: FrameType, opackData: OpackDict): void {
    LOGGER.debug("Process incoming OPACK frame (%s): %s", FrameType[frameType], opackData);

    const messageType = opackData._t;
    if (messageType === MessageType.Event) {
      LOGGER.debug("Received event: %s", opackData);
      this.listener.eventReceived(opackData._i, opackData._c);
    } else if (messageType === MessageType.Response) {
      const xid = opackData._x;
      const shared = this._queues.get(xid);
      if (shared) {
        this._queues.delete(xid);
        shared.set(opackData);
      } else {
        LOGGER.debug("No receiver for XID %s", xid);
      }
    } else {
      LOGGER.warning("Got OPACK frame with unsupported type: %s", messageType);
    }
  }
}
