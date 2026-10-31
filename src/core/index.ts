/** Core module of pyatv. */

import { FeatureName, PairingRequirement, Protocol } from "../const.ts";
import { type BaseConfig, BaseService, type Playing, PushUpdater, type Properties } from "../interface.ts";
import { Settings } from "../settings.ts";
import { type ClientSessionManager, createSession } from "../support/http.ts";
import { StateProducer } from "../support/state_producer.ts";
import { type DispatchFilterFunc, type DispatchFunc, MessageDispatcher } from "./protocol.ts";

export type TakeoverMethod = (...interfaces: unknown[]) => () => void;

/** Name of states that can be updated. */
export enum UpdatedState {
  /** Playing state in metadata was updated. */
  Playing = 1,
  /** Volume was updated. */
  Volume = 2,
  /** Keyboard focus was updated. */
  KeyboardFocus = 3,
  /** AirPlay output devices were updated. */
  OutputDevices = 4,
  /** Output device volume was updated. */
  OutputDeviceVolume = 5,
}

/**
 * Message sent when state of something changed.
 *
 * Type of value depends on state:
 * - UpdatedState.Playing -> interface.Playing
 * - UpdatedState.Volume -> number
 * - UpdatedState.KeyboardFocus -> const.KeyboardFocusState
 * - UpdatedState.OutputDevices -> interface.OutputDevice[]
 */
export class StateMessage {
  constructor(
    readonly protocol: Protocol,
    readonly state: UpdatedState,
    readonly value: any,
  ) {}

  toString(): string {
    return `[${Protocol[this.protocol]}.${UpdatedState[this.state]} -> ${this.value}]`;
  }
}

export class CoreStateDispatcher extends MessageDispatcher<UpdatedState, StateMessage> {}

/** Dispatch internal protocol state updates to listeners. */
export class ProtocolStateDispatcher {
  constructor(
    private readonly _protocol: Protocol,
    private readonly _coreDispatcher: CoreStateDispatcher,
  ) {}

  /** Create a copy of this instance but with a new protocol. */
  createCopy(protocol: Protocol): ProtocolStateDispatcher {
    return new ProtocolStateDispatcher(protocol, this._coreDispatcher);
  }

  /** Listen to a specific type of message type. */
  listenTo(
    state: UpdatedState,
    func: DispatchFunc<StateMessage>,
    messageFilter: DispatchFilterFunc<StateMessage> = () => true,
  ): void {
    this._coreDispatcher.listenTo(state, func, messageFilter);
  }

  /** Dispatch a message to listeners. */
  dispatch(state: UpdatedState, value: unknown): Array<Promise<void>> {
    return this._coreDispatcher.dispatch(state, new StateMessage(this._protocol, state, value));
  }
}

/**
 * Mutable version of BaseService allowing some fields to be changed.
 *
 * This is an internal implementation of BaseService that allows protocols to change
 * some fields during set up.
 */
export class MutableService extends BaseService {
  private _requiresPassword = false;
  private _pairingRequirement: PairingRequirement = PairingRequirement.Unsupported;

  constructor(
    identifier: string | null,
    protocol: Protocol,
    port: number,
    properties: Properties | Map<string, string> | null | undefined,
    credentials: string | null = null,
    password: string | null = null,
    enabled = true,
  ) {
    super(identifier, protocol, port, properties, credentials, password, enabled);
  }

  /** Return if a password is required to access service. */
  get requiresPassword(): boolean {
    return this._requiresPassword;
  }

  set requiresPassword(value: boolean) {
    this._requiresPassword = value;
  }

  /** Return if pairing is required by service. */
  get pairing(): PairingRequirement {
    return this._pairingRequirement;
  }

  set pairing(value: PairingRequirement) {
    this._pairingRequirement = value;
  }

  /** Return deep-copy of instance. */
  deepcopy(): MutableService {
    const copy = new MutableService(
      this.identifier,
      this.protocol,
      this.port,
      { ...this.properties },
      this.credentials,
      this.password,
      this.enabled,
    );
    copy.pairing = this.pairing;
    copy.requiresPassword = this.requiresPassword;
    return copy;
  }
}

/**
 * Abstract push updater class.
 *
 * This class adds a `postUpdate` method that publishes a new state, but only if it
 * has been updated.
 */
export abstract class AbstractPushUpdater extends PushUpdater {
  private _previousState: Playing | null = null;

  constructor(readonly stateDispatcher: ProtocolStateDispatcher) {
    super();
  }

  /** Post an update to listener. */
  postUpdate(playing: Playing): void {
    if (!playing.equals(this._previousState)) {
      // Dispatch message using message dispatcher
      this.stateDispatcher.dispatch(UpdatedState.Playing, playing);

      // Publish using regular (external) interface. This shall be removed at
      // some point in time.
      const callback = this.listener.playstatusUpdate;
      queueMicrotask(() => callback(this, playing));
    }
    this._previousState = playing;
  }
}

/** Information for setting up a protocol. */
export interface SetupData {
  protocol: Protocol;
  connect: () => Promise<boolean>;
  close: () => Set<Promise<unknown>>;
  deviceInfo: () => Record<string, unknown>;
  interfaces: Map<unknown, unknown>;
  features: Set<FeatureName>;
}

/** Instance for protocols to access core features. */
export class Core {
  constructor(
    readonly config: BaseConfig,
    readonly service: BaseService,
    readonly settings: Settings,
    readonly deviceListener: StateProducer<any>,
    readonly sessionManager: ClientSessionManager,
    readonly takeover: TakeoverMethod,
    readonly stateDispatcher: ProtocolStateDispatcher,
  ) {}
}

export interface CreateCoreOptions {
  settings?: Settings | null;
  deviceListener?: StateProducer<any> | null;
  sessionManager?: ClientSessionManager | null;
  coreDispatcher?: CoreStateDispatcher | null;
  takeoverMethod?: TakeoverMethod | null;
}

/** Create a new core instance (provides defaults for some arguments). */
export async function createCore(
  config: BaseConfig,
  service: BaseService,
  options: CreateCoreOptions = {},
): Promise<Core> {
  return new Core(
    config,
    service,
    options.settings ?? new Settings(),
    options.deviceListener ?? new StateProducer(),
    options.sessionManager ?? (await createSession()),
    options.takeoverMethod ?? (() => () => undefined),
    new ProtocolStateDispatcher(service.protocol, options.coreDispatcher ?? new CoreStateDispatcher()),
  );
}

/** State information of an output device. */
export class OutputDeviceState {
  constructor(
    readonly identifier: string,
    readonly volume = 0.0,
  ) {}

  toString(): string {
    return `Device: ${this.identifier} (${this.volume})`;
  }

  equals(other: unknown): boolean {
    return other instanceof OutputDeviceState && this.identifier === other.identifier && this.volume === other.volume;
  }
}
