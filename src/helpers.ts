/** Various helper methods. */

import { PairingRequirement } from "./const.ts";
import type { AppleTV as AppleTVInterface, BaseConfig } from "./interface.ts";

export const HOMESHARING_SERVICE = "_appletv-v2._tcp.local";
export const DEVICE_SERVICE = "_touch-able._tcp.local";
export const MEDIAREMOTE_SERVICE = "_mediaremotetv._tcp.local";
export const AIRPLAY_SERVICE = "_airplay._tcp.local";
export const COMPANION_SERVICE = "_companion-link._tcp.local";
export const RAOP_SERVICE = "_raop._tcp.local";
export const HSCP_SERVICE = "_hscp._tcp.local";

type PropertyMap = Map<string, string> | Record<string, string>;

function getProp(properties: PropertyMap, key: string): string | null {
  if (properties instanceof Map) return properties.get(key) ?? null;
  return Object.prototype.hasOwnProperty.call(properties, key) ? (properties[key] ?? null) : null;
}

/** Hooks used by helper functions (replaceable in tests). */
export const helperHooks = {
  scan: async (options: { timeout?: number }): Promise<BaseConfig[]> => {
    const pyatv = await import("./index.ts");
    return pyatv.scan(options);
  },
  connect: async (config: BaseConfig): Promise<AppleTVInterface> => {
    const pyatv = await import("./index.ts");
    return pyatv.connect(config);
  },
};

/**
 * Connect to first discovered device.
 *
 * This is a convenience method that auto discovers devices, picks the first device
 * found, connects to it and passes it to a user provided handler. An optional error
 * handler can be provided that is called when no device was found.
 */
export async function autoConnect(
  handler: (atv: AppleTVInterface) => Promise<void> | void,
  options: { timeout?: number; notFound?: (() => Promise<void> | void) | null } = {},
): Promise<void> {
  const atvs = await helperHooks.scan({ timeout: options.timeout ?? 5 });

  // Take the first device found
  if (atvs.length > 0) {
    const atv = await helperHooks.connect(atvs[0]!);
    try {
      await handler(atv);
    } finally {
      atv.close();
    }
  } else if (options.notFound) {
    await options.notFound();
  }
}

/**
 * Return unique identifier from a Zeroconf service.
 *
 * `serviceType` is the Zeroconf service type (e.g. _mediaremotetv._tcp.local),
 * `serviceName` name of the service (e.g. Office or Living Room) and `properties` all
 * key-value properties belonging to the service.
 *
 * The unique identifier is returned if available, otherwise null is returned.
 */
export function getUniqueId(serviceType: string, serviceName: string, properties: PropertyMap): string | null {
  if (serviceType === DEVICE_SERVICE || serviceType === HOMESHARING_SERVICE) {
    return serviceName.split("_")[0]!;
  }
  if (serviceType === HSCP_SERVICE) return getProp(properties, "Machine ID");
  if (serviceType === MEDIAREMOTE_SERVICE) return getProp(properties, "UniqueIdentifier");
  if (serviceType === AIRPLAY_SERVICE) return getProp(properties, "deviceid");
  if (serviceType === COMPANION_SERVICE) {
    // Apple TV devices on tvOS 16 (maybe earlier) have a static rpMRtID identifier.
    return getProp(properties, "rpmrtid");
  }
  if (serviceType === RAOP_SERVICE) {
    const idx = serviceName.indexOf("@");

    // Normally a RAOP devices announces with "id@name" as zeroconf name. But some
    // devices seems to break from this behavior and just use "name", thus leaving
    // out the id. Some of these devices however have the public key ("pk")
    // available as an attribute so that can be used as an identifier in that case.
    if (idx !== -1) return serviceName.slice(0, idx);
    return getProp(properties, "pk");
  }
  return null;
}

/**
 * Return if a file is streamable by pyatv.
 *
 * This method will return if the file format of the given file is supported and
 * streamable by pyatv. It will never raise an exception, e.g. because the file is
 * missing or lack of permissions.
 */
export async function isStreamable(filename: string): Promise<boolean> {
  try {
    const audio = await import("./support/audio.ts");
    await audio.getFileInfo(filename);
  } catch {
    return false;
  }
  return true;
}

/**
 * Return if pyatv supports this device.
 *
 * Returns false if all of its services are either PairingRequirement.Unsupported or
 * PairingRequirement.Disabled. In all other cases it will return true.
 */
export function isDeviceSupported(conf: BaseConfig): boolean {
  const devRequirements = new Set(conf.services.map((service) => service.pairing));
  devRequirements.delete(PairingRequirement.Unsupported);
  devRequirements.delete(PairingRequirement.Disabled);
  return devRequirements.size > 0;
}
