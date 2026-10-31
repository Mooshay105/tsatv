/** Storage module. */

import { createHash } from "node:crypto";
import { Protocol } from "../const.ts";
import { DeviceIdMissingError, SettingsError } from "../exceptions.ts";
import { type BaseConfig, Storage } from "../interface.ts";
import { Settings } from "../settings.ts";
import type { Model } from "../support/model.ts";
import { pyJsonDumps } from "../support/pyjson.ts";

export const MODEL_VERSION = 1;

function dictHash(data: unknown): string {
  // Calculate a hash of all settings by dumping content to JSON and hashing all
  // output using SHA256.
  return createHash("sha256").update(pyJsonDumps(data), "utf-8").digest("hex");
}

/** Storage model of data that is saved or restored to underlying storage. */
export class StorageModel {
  constructor(
    readonly version: number,
    readonly devices: Settings[],
  ) {}

  /** Create model from raw (JSON) data. */
  static validate(raw: unknown): StorageModel {
    if (!raw || typeof raw !== "object") throw new SettingsError("invalid storage data");
    const data = raw as { version?: unknown; devices?: unknown };
    if (typeof data.version !== "number") throw new SettingsError("missing version");
    if (!Array.isArray(data.devices)) throw new SettingsError("missing devices");
    return new StorageModel(
      data.version,
      data.devices.map((d) => new Settings(d as Record<string, unknown>)),
    );
  }

  toDict(options: { excludeDefaults?: boolean } = {}): { version: number; devices: Record<string, unknown>[] } {
    return { version: this.version, devices: this.devices.map((d) => d.toDict(options)) };
  }
}

function copyWithServiceSettings<T extends Model>(model: T, update: Record<string, unknown>): T {
  return model.copyWith(update);
}

/**
 * Abstract base class handling all logic except for saving and loading.
 *
 * New storage modules should generally inherit from this class and implement save and
 * load according to the underlying storage mechanism.
 */
export abstract class AbstractStorage extends Storage {
  protected _settings: Settings[] = [];
  private _hash: string = dictHash({});

  /** Return if anything has changed in the model since loading. */
  hasChanged(data: unknown): boolean {
    return this._hash !== dictHash(data);
  }

  /** Return settings for all devices. */
  get settings(): Settings[] {
    return this._settings;
  }

  /** Return storage model representation. */
  get storageModel(): StorageModel {
    return new StorageModel(MODEL_VERSION, this._settings);
  }

  /** Set storage model data. */
  set storageModel(other: StorageModel) {
    if (other.version !== MODEL_VERSION) {
      throw new SettingsError(`unsupported version: ${other.version}`);
    }
    this._settings = other.devices;
  }

  /** Call after saving to indicate settings have been saved. */
  updateHash(data: unknown): void {
    this._hash = dictHash(data);
  }

  /**
   * Return settings for a specific configuration (device).
   *
   * The returned Settings object is a reference to an object in the storage module.
   * Changes made can/will be written back to the storage in case "save" is called.
   */
  async getSettings(config: BaseConfig): Promise<Settings> {
    const identifiers = config.allIdentifiers;
    if (identifiers.length === 0) {
      throw new DeviceIdMissingError(`no identifier for device ${config.name}`);
    }

    // Find existing settings if we have it
    for (const settings of this._settings) {
      const p = settings.protocols;
      const ids = [p.airplay.identifier, p.companion.identifier, p.dmap.identifier, p.mrp.identifier, p.raop.identifier];
      if (ids.some((id) => id !== null && identifiers.includes(id))) return settings;
    }

    // If no settings were found, create new ones
    const settings = new Settings();
    AbstractStorage.updateSettingsFromConfig(config, settings);
    this._settings.push(settings);
    return settings;
  }

  /** Remove settings from storage. Returns true if settings were removed. */
  async removeSettings(settings: Settings): Promise<boolean> {
    const idx = this._settings.indexOf(settings);
    if (idx >= 0) {
      this._settings.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** Update settings based on config. */
  async updateSettings(config: BaseConfig): Promise<void> {
    const settings = await this.getSettings(config);
    AbstractStorage.updateSettingsFromConfig(config, settings);
  }

  protected static updateSettingsFromConfig(config: BaseConfig, settings: Settings): void {
    for (const service of config.services) {
      const update = service.settings();
      switch (service.protocol) {
        case Protocol.AirPlay:
          settings.protocols.airplay = copyWithServiceSettings(settings.protocols.airplay, update);
          settings.protocols.airplay.identifier = service.identifier;
          break;
        case Protocol.DMAP:
          settings.protocols.dmap = copyWithServiceSettings(settings.protocols.dmap, update);
          settings.protocols.dmap.identifier = service.identifier;
          break;
        case Protocol.Companion:
          settings.protocols.companion = copyWithServiceSettings(settings.protocols.companion, update);
          settings.protocols.companion.identifier = service.identifier;
          break;
        case Protocol.MRP:
          settings.protocols.mrp = copyWithServiceSettings(settings.protocols.mrp, update);
          settings.protocols.mrp.identifier = service.identifier;
          break;
        case Protocol.RAOP:
          settings.protocols.raop = copyWithServiceSettings(settings.protocols.raop, update);
          settings.protocols.raop.identifier = service.identifier;
          break;
      }
    }
  }

  /** Return stored data (equivalent of dict(storage) in Python). */
  toDict(): { version: number; devices: Record<string, unknown>[] } {
    // If settings are empty for a device (no settings overridden or credentials
    // saved), then the output will just be an empty dict. Filter those out.
    const dumped = this.storageModel.toDict({ excludeDefaults: true });
    dumped.devices = dumped.devices.filter((device) => Object.keys(device).length > 0);
    return dumped;
  }
}
