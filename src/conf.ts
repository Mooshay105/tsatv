/**
 * Configuration used when connecting to a device.
 *
 * A configuration describes a device, e.g. it's name, IP address and credentials. It is
 * possible to manually create a configuration, but generally scanning for devices will
 * provide configurations for you.
 */

import { PairingRequirement, Protocol } from "./const.ts";
import { BaseConfig, BaseService, DeviceInfo, type Properties } from "./interface.ts";
import { deprecated } from "./support/index.ts";

/**
 * Representation of a device configuration.
 *
 * An instance of this class represents a single device. A device can have several
 * services depending on the protocols it supports, e.g. DMAP or AirPlay.
 */
export class AppleTV extends BaseConfig {
  private readonly _address: string;
  private readonly _name: string;
  private readonly _deepSleep: boolean;
  private readonly _services = new Map<Protocol, BaseService>();
  private readonly _deviceInfo: DeviceInfo;

  constructor(
    address: string,
    name: string,
    options: {
      deepSleep?: boolean;
      properties?: Record<string, Properties> | null;
      deviceInfo?: DeviceInfo | null;
    } = {},
  ) {
    super(options.properties ?? {});
    this._address = address;
    this._name = name;
    this._deepSleep = options.deepSleep ?? false;
    this._deviceInfo = options.deviceInfo ?? new DeviceInfo({});
  }

  /** IP address of device. */
  get address(): string {
    return this._address;
  }

  /** Name of device. */
  get name(): string {
    return this._name;
  }

  /** If device is in deep sleep. */
  get deepSleep(): boolean {
    return this._deepSleep;
  }

  /** Add a new service. If the service already exists, it will be merged. */
  addService(service: BaseService): void {
    const existing = this._services.get(service.protocol);
    if (existing !== undefined) {
      existing.merge(service);
    } else {
      this._services.set(service.protocol, service);
    }
  }

  /** Look up a service based on protocol (null if not available). */
  getService(protocol: Protocol): BaseService | null {
    return this._services.get(protocol) ?? null;
  }

  /** Return all supported services. */
  get services(): BaseService[] {
    return [...this._services.values()];
  }

  /** Return general device information. */
  get deviceInfo(): DeviceInfo {
    return this._deviceInfo;
  }

  /** Return deep-copy of instance. */
  deepcopy(): AppleTV {
    const copy = new AppleTV(this._address, this._name, {
      deepSleep: this._deepSleep,
      properties: this._properties,
      deviceInfo: this._deviceInfo,
    });
    for (const service of this.services) copy.addService(service.deepcopy());
    return copy;
  }
}

export interface ManualServiceOptions {
  credentials?: string | null;
  password?: string | null;
  requiresPassword?: boolean;
  pairingRequirement?: PairingRequirement;
  enabled?: boolean;
}

/** Service used when manually creating and adding a service. */
export class ManualService extends BaseService {
  protected _requiresPassword: boolean;
  protected _pairingRequirement: PairingRequirement;

  constructor(
    identifier: string | null,
    protocol: Protocol,
    port: number,
    properties: Properties | Map<string, string> | null | undefined,
    options: ManualServiceOptions = {},
  ) {
    super(
      identifier,
      protocol,
      port,
      properties,
      options.credentials ?? null,
      options.password ?? null,
      options.enabled ?? true,
    );
    this._requiresPassword = options.requiresPassword ?? false;
    this._pairingRequirement = options.pairingRequirement ?? PairingRequirement.Unsupported;
  }

  /** Return if a password is required to access service. */
  get requiresPassword(): boolean {
    return this._requiresPassword;
  }

  /** Return if pairing is required by service. */
  get pairing(): PairingRequirement {
    return this._pairingRequirement;
  }

  /** Return deep-copy of instance. */
  deepcopy(): ManualService {
    return new ManualService(this.identifier, this.protocol, this.port, { ...this.properties }, {
      credentials: this.credentials,
      password: this.password,
      requiresPassword: this.requiresPassword,
      pairingRequirement: this.pairing,
      enabled: this.enabled,
    });
  }
}

/** Representation of a DMAP service. DEPRECATED: Use ManualService instead. */
export class DmapService extends ManualService {
  constructor(identifier: string | null, credentials: string | null, port = 3689, properties: Properties | null = null) {
    deprecated("DmapService");
    super(identifier, Protocol.DMAP, port, properties, { credentials });
  }
}

/** Representation of a MediaRemote Protocol (MRP) service. DEPRECATED. */
export class MrpService extends ManualService {
  constructor(identifier: string | null, port: number, credentials: string | null = null, properties: Properties | null = null) {
    deprecated("MrpService");
    super(identifier, Protocol.MRP, port, properties, { credentials });
  }
}

/** Representation of an AirPlay service. DEPRECATED. */
export class AirPlayService extends ManualService {
  constructor(identifier: string | null, port = 7000, credentials: string | null = null, properties: Properties | null = null) {
    deprecated("AirPlayService");
    super(identifier, Protocol.AirPlay, port, properties, { credentials });
  }
}

/** Representation of a Companion link service. DEPRECATED. */
export class CompanionService extends ManualService {
  constructor(port: number, credentials: string | null = null, properties: Properties | null = null) {
    deprecated("CompanionService");
    super(null, Protocol.Companion, port, properties, { credentials });
  }
}

/** Representation of an RAOP service. DEPRECATED. */
export class RaopService extends ManualService {
  constructor(
    identifier: string | null,
    port = 7000,
    credentials: string | null = null,
    password: string | null = null,
    properties: Properties | null = null,
  ) {
    deprecated("RaopService");
    super(identifier, Protocol.RAOP, port, properties, { credentials, password });
  }
}
