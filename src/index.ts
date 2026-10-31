/** Main routines for interacting with an Apple TV. */

import { Protocol } from "./const.ts";
import { CoreStateDispatcher, createCore } from "./core/index.ts";
import { FacadeAppleTV } from "./core/facade.ts";
import { type BaseScanner, MulticastMdnsScanner, UnicastMdnsScanner } from "./core/scan.ts";
import { DeviceIdMissingError, NoServiceError } from "./exceptions.ts";
import type * as iface from "./interface.ts";
import "./protocols/register.ts";
import { sortedProtocols } from "./protocols/all.ts";
import { PROTOCOLS } from "./protocols/index.ts";
import { MemoryStorage } from "./storage/memory_storage.ts";
import { type ClientSession, createSession } from "./support/http.ts";
import { getLogger } from "./support/logging.ts";

const LOGGER = getLogger("pyatv");

export * as conf from "./conf.ts";
export * as const_ from "./const.ts";
export * as exceptions from "./exceptions.ts";
export * as interface_ from "./interface.ts";
export * from "./const.ts";

export interface ScanOptions {
  timeout?: number;
  identifier?: string | Set<string> | null;
  protocol?: Protocol | Set<Protocol> | null;
  hosts?: string[] | null;
  storage?: iface.Storage | null;
}

/** Scan for Apple TVs on network and return their configurations. */
export async function scan(options: ScanOptions = {}): Promise<iface.BaseConfig[]> {
  const timeout = options.timeout ?? 5;
  const identifier = options.identifier ?? null;
  const protocol = options.protocol ?? null;

  const shouldInclude = (atv: iface.BaseConfig): boolean => {
    if (!atv.ready) return false;
    if (identifier) {
      const target = identifier instanceof Set ? identifier : new Set([identifier]);
      return atv.allIdentifiers.some((id) => target.has(id));
    }
    return true;
  };

  const scanner: BaseScanner =
    options.hosts && options.hosts.length > 0
      ? new UnicastMdnsScanner(options.hosts)
      : new MulticastMdnsScanner(identifier);

  const protocols = new Set<Protocol>();
  if (protocol !== null) {
    for (const p of protocol instanceof Set ? protocol : [protocol]) protocols.add(p);
  }

  for (const [proto, protoMethods] of sortedProtocols()) {
    // If specific protocols was given, skip this one if it isn't listed
    if (protocol !== null && !protocols.has(proto)) continue;

    scanner.addServiceInfo(proto, protoMethods.serviceInfo);
    for (const [serviceType, handler] of Object.entries(protoMethods.scan())) {
      scanner.addService(serviceType, handler, protoMethods.deviceInfo as any);
    }
  }

  const storage = options.storage ?? new MemoryStorage();

  const devices = [...(await scanner.discover(timeout)).values()];
  const filteredDevices = devices.filter(shouldInclude);

  for (const device of filteredDevices) {
    const settings = await storage.getSettings(device);
    device.apply(settings);
  }
  return filteredDevices;
}

export interface ConnectOptions {
  protocol?: Protocol | null;
  session?: ClientSession | null;
  storage?: iface.Storage | null;
}

/** Connect to a device based on a configuration. */
export async function connect(config: iface.BaseConfig, options: ConnectOptions = {}): Promise<iface.AppleTV> {
  if (config.services.length === 0) throw new NoServiceError("no service to connect to");
  if (config.identifier === null) throw new DeviceIdMissingError("no device identifier");

  const storage = options.storage ?? new MemoryStorage();

  const configCopy = config.deepcopy();

  LOGGER.debug("Loading settings from %s", storage);
  const settings = await storage.getSettings(config);
  configCopy.apply(settings);

  const sessionManager = await createSession(options.session);
  const coreDispatcher = new CoreStateDispatcher();
  const atv = new FacadeAppleTV(configCopy, sessionManager, coreDispatcher, settings);

  try {
    for (const [proto, protoMethods] of sortedProtocols()) {
      const service = configCopy.getService(proto);
      if (service === null) continue;
      if (!service.enabled) {
        LOGGER.debug("Ignore %s as it is disabled", Protocol[proto]);
        continue;
      }

      // Lock protocol argument so protocol does not have to deal with that
      const takeoverMethod = (...interfaces: unknown[]) => atv.takeover(proto, ...interfaces);

      // Core provides core access with a protocol specific twist
      const core = await createCore(configCopy, service, {
        settings,
        deviceListener: atv,
        sessionManager,
        coreDispatcher,
        takeoverMethod,
      });

      for await (const setupData of protoMethods.setup(core)) {
        atv.addProtocol(setupData);
      }
    }

    await atv.connect();
  } catch (ex) {
    await sessionManager.close();
    throw ex;
  }
  return atv;
}

export interface PairOptions {
  session?: ClientSession | null;
  storage?: iface.Storage | null;
  [key: string]: unknown;
}

/** Pair a protocol for an Apple TV. */
export async function pair(
  config: iface.BaseConfig,
  protocol: Protocol,
  options: PairOptions = {},
): Promise<iface.PairingHandler> {
  const service = config.getService(protocol);
  if (!service) throw new NoServiceError(`no service available for ${Protocol[protocol]}`);

  const protoMethods = PROTOCOLS.get(protocol);
  if (!protoMethods) throw new Error(`missing implementation for ${Protocol[protocol]}`);

  const { session, storage: storageOption, ...kwargs } = options;
  const storage = storageOption ?? new MemoryStorage();

  const settings = await storage.getSettings(config);
  const sessionManager = await createSession(session);

  const core = await createCore(config.deepcopy(), service, { settings, sessionManager });

  try {
    return protoMethods.pair(core, kwargs);
  } catch (ex) {
    await sessionManager.close();
    throw ex;
  }
}
