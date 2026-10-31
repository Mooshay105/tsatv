/**
 * Settings for configuring pyatv.
 *
 * Field names use snake_case to stay compatible with the storage format used by the
 * Python version of pyatv.
 */

import { randomBytes } from "node:crypto";
import { type FieldSpec, Model, ValidationError } from "./support/model.ts";

const MAC_REGEX = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}/;

export const DEFAULT_NAME = "pyatv";
export const DEFUALT_MAC = "02:70:79:61:74:76"; // Locally administrated (02) + "pyatv" in hex
export const DEFAULT_MAC = DEFUALT_MAC;
export const DEFAULT_DEVICE_ID = "FF:70:79:61:74:76"; // 0xFF + "pyatv"
export const DEFAULT_RP_ID = "cafecafecafe";
export const DEFAULT_MODEL = "iPhone10,6";
export const DEFAULT_OS_NAME = "iPhone OS";
export const DEFAULT_OS_BUILD = "18G82";
export const DEFAULT_OS_VERSION = "14.7.1";

/** AirPlay version to use. */
export enum AirPlayVersion {
  /** Automatically determine what version to use. */
  Auto = "auto",
  /** Use version 1 of AirPlay. */
  V1 = "1",
  /** Use version 2 of AirPlay. */
  V2 = "2",
}

/** Audio format used when streaming audio with AirPlay 2. */
export enum AirPlayAudioFormat {
  /** Uncompressed ALAC frames (supported by all receivers). */
  ALAC = "alac",
  /** Raw PCM (not played by some receivers, e.g. Sonos). */
  PCM = "pcm",
}

/** How MRP tunneling over AirPlay is handled. */
export enum MrpTunnel {
  /** Automatically set up MRP tunnel if supported by remote device. */
  Auto = "auto",
  /** Force set up of MRP tunnel even if remote device does not supports it. */
  Force = "force",
  /** Fully disable set up of MRP tunnel. */
  Disable = "disable",
}

/** Hooks replaceable in tests (equivalent of patching os.urandom). */
export const settingsHooks = {
  urandom: (size: number): Buffer => randomBytes(size),
};

const randomRpId = () => settingsHooks.urandom(6).toString("hex");

const str = (def: string, validate?: (v: string) => string): FieldSpec => ({
  type: { kind: "str", validate },
  default: () => def,
});
const optStr = (): FieldSpec => ({ type: { kind: "str", optional: true }, default: () => null });
const int = (def: number): FieldSpec => ({ type: { kind: "int" }, default: () => def });

function macValidator(mac: string): string {
  if (!MAC_REGEX.test(mac)) throw new ValidationError(`${mac} is not a valid MAC address`);
  return mac;
}

/** Information related settings. */
export class InfoSettings extends Model {
  declare name: string;
  declare mac: string;
  declare model: string;
  declare device_id: string;
  declare rp_id: string;
  declare os_name: string;
  declare os_build: string;
  declare os_version: string;

  static readonly SCHEMA: Record<string, FieldSpec> = {
    name: str(DEFAULT_NAME),
    mac: str(DEFUALT_MAC, macValidator),
    model: str(DEFAULT_MODEL),
    device_id: str(DEFAULT_DEVICE_ID),
    rp_id: {
      type: { kind: "str" },
      default: randomRpId,
      before: (v) => (v === null || v === undefined ? randomRpId() : v),
    },
    os_name: str(DEFAULT_OS_NAME),
    os_build: str(DEFAULT_OS_BUILD),
    os_version: str(DEFAULT_OS_VERSION),
  };

  constructor(data?: Partial<Record<keyof InfoSettings, unknown>>) {
    super();
    this.init(data as Record<string, unknown>);
  }

  get schema() {
    return InfoSettings.SCHEMA;
  }
}

/** Settings related to AirPlay. */
export class AirPlaySettings extends Model {
  declare identifier: string | null;
  declare credentials: string | null;
  declare password: string | null;
  declare mrp_tunnel: MrpTunnel;

  static readonly SCHEMA: Record<string, FieldSpec> = {
    identifier: optStr(),
    credentials: optStr(),
    password: optStr(),
    mrp_tunnel: {
      type: { kind: "enum", name: "MrpTunnel", values: Object.values(MrpTunnel) },
      default: () => MrpTunnel.Auto,
    },
  };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return AirPlaySettings.SCHEMA;
  }
}

abstract class IdCredSettings extends Model {
  declare identifier: string | null;
  declare credentials: string | null;
}

/** Settings related to Companion. */
export class CompanionSettings extends IdCredSettings {
  static readonly SCHEMA: Record<string, FieldSpec> = { identifier: optStr(), credentials: optStr() };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return CompanionSettings.SCHEMA;
  }
}

/** Settings related to DMAP. */
export class DmapSettings extends IdCredSettings {
  static readonly SCHEMA: Record<string, FieldSpec> = { identifier: optStr(), credentials: optStr() };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return DmapSettings.SCHEMA;
  }
}

/** Settings related to MRP. */
export class MrpSettings extends IdCredSettings {
  static readonly SCHEMA: Record<string, FieldSpec> = { identifier: optStr(), credentials: optStr() };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return MrpSettings.SCHEMA;
  }
}

/** Settings related to RAOP. */
export class RaopSettings extends Model {
  declare identifier: string | null;
  declare credentials: string | null;
  declare password: string | null;
  /** Protocol version used (corresponds to AirPlay version). */
  declare protocol_version: AirPlayVersion;
  /** Server side (UDP) port used by timing server. Set to 0 to use random free port. */
  declare timing_port: number;
  /** Server side (UDP) port used by control server. Set to 0 to use random free port. */
  declare control_port: number;
  /** Audio format used when streaming with AirPlay 2. */
  declare audio_format: AirPlayAudioFormat;

  static readonly SCHEMA: Record<string, FieldSpec> = {
    identifier: optStr(),
    credentials: optStr(),
    password: optStr(),
    protocol_version: {
      type: { kind: "enum", name: "AirPlayVersion", values: Object.values(AirPlayVersion) },
      default: () => AirPlayVersion.Auto,
    },
    timing_port: int(0),
    control_port: int(0),
    audio_format: {
      type: { kind: "enum", name: "AirPlayAudioFormat", values: Object.values(AirPlayAudioFormat) },
      default: () => AirPlayAudioFormat.ALAC,
    },
  };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return RaopSettings.SCHEMA;
  }
}

/** Container for protocol specific settings. */
export class ProtocolSettings extends Model {
  declare airplay: AirPlaySettings;
  declare companion: CompanionSettings;
  declare dmap: DmapSettings;
  declare mrp: MrpSettings;
  declare raop: RaopSettings;

  static readonly SCHEMA: Record<string, FieldSpec> = {
    airplay: { type: { kind: "model", factory: () => new AirPlaySettings() }, default: () => new AirPlaySettings() },
    companion: {
      type: { kind: "model", factory: () => new CompanionSettings() },
      default: () => new CompanionSettings(),
    },
    dmap: { type: { kind: "model", factory: () => new DmapSettings() }, default: () => new DmapSettings() },
    mrp: { type: { kind: "model", factory: () => new MrpSettings() }, default: () => new MrpSettings() },
    raop: { type: { kind: "model", factory: () => new RaopSettings() }, default: () => new RaopSettings() },
  };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return ProtocolSettings.SCHEMA;
  }
}

/** Settings container class. */
export class Settings extends Model {
  declare info: InfoSettings;
  declare protocols: ProtocolSettings;

  static readonly SCHEMA: Record<string, FieldSpec> = {
    info: { type: { kind: "model", factory: () => new InfoSettings() }, default: () => new InfoSettings() },
    protocols: {
      type: { kind: "model", factory: () => new ProtocolSettings() },
      default: () => new ProtocolSettings(),
    },
  };

  constructor(data?: Record<string, unknown>) {
    super();
    this.init(data);
  }

  get schema() {
    return Settings.SCHEMA;
  }
}
