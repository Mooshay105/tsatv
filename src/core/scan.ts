/** Implementation of device scanning routines. */

import { AppleTV } from "../conf.ts";
import { DeviceModel, Protocol } from "../const.ts";
import { getUniqueId } from "../helpers.ts";
import { type BaseConfig, type BaseService, DeviceInfo } from "../interface.ts";
import { TimeoutError } from "../support/asyncio.ts";
import { dictMerge } from "../support/collections.ts";
import { lookupInternalName } from "../support/device_info.ts";
import { getEnv } from "../support/env.ts";
import * as knock from "../support/knock.ts";
import { getLogger } from "../support/logging.ts";
import type { MutableService } from "./index.ts";
import * as mdns from "./mdns.ts";

const LOGGER = getLogger("pyatv.core.scan");

export type ScanHandlerReturn = [string, MutableService];
export type ScanHandler = (service: mdns.Service, response: mdns.Response) => ScanHandlerReturn | null | undefined;
export type DeviceInfoNameFromShortName = (name: string) => string | null;
export type ScanHandlerDeviceInfoName = [ScanHandler, DeviceInfoNameFromShortName];
export type ScanMethod = () => Record<string, ScanHandlerDeviceInfoName>;

export type DevInfoExtractor = (serviceType: string, properties: mdns.Service["properties"]) => Record<string, unknown>;
export type ServiceInfoMethod = (
  service: MutableService,
  devinfo: DeviceInfo,
  services: Map<Protocol, BaseService>,
) => Promise<void>;

export const DEVICE_INFO = "_device-info._tcp.local";
export const SLEEP_PROXY = "_sleep-proxy._udp.local";

// These ports have been "arbitrarily" chosen (see issue #580) because a device normally
// listen on them (more or less). They are used as best-effort when for unicast scanning
// to try to wake up a device.
export const KNOCK_PORTS = [3689, 7000, 49152, 32498];

/** Represent a device found during scanning. */
export interface FoundDevice {
  name: string;
  address: string;
  deepSleep: boolean;
  model: DeviceModel;
  services: MutableService[];
}

/** Return the service name for device info when it is unique. */
export function deviceInfoNameFromUniqueShortName(serviceName: string): string {
  return serviceName;
}

function sleepProxyDeviceInfoNameFromShortName(serviceName: string): string {
  const idx = serviceName.indexOf(" ");
  return serviceName.slice(idx + 1);
}

/** Return all unique identifiers for a response. */
export function* getUniqueIdentifiers(response: mdns.Response): Generator<string> {
  for (const service of response.services) {
    const uniqueId = scanHooks.getUniqueId(service.type, service.name, service.properties as any);
    if (uniqueId) yield uniqueId;
  }
}

/** Hooks replaceable in tests. */
export const scanHooks = {
  getUniqueId,
};

const emptyHandler: ScanHandler = () => null;
const emptyExtractor: DevInfoExtractor = () => ({});

/** Base scanner for service discovery. */
export abstract class BaseScanner {
  protected readonly _services = new Map<string, [ScanHandler, DevInfoExtractor]>([
    [DEVICE_INFO, [emptyHandler, emptyExtractor]],
    [SLEEP_PROXY, [emptyHandler, emptyExtractor]],
  ]);
  protected readonly _deviceInfoName = new Map<string, DeviceInfoNameFromShortName>([
    [SLEEP_PROXY, sleepProxyDeviceInfoNameFromShortName],
  ]);
  protected readonly _serviceInfos = new Map<Protocol, ServiceInfoMethod>();
  protected readonly _foundDevices = new Map<string, FoundDevice>();
  protected readonly _properties = new Map<string, Record<string, mdns.Service["properties"]>>();

  /** Add service type to discover. */
  addService(serviceType: string, handlerDeviceInfoName: ScanHandlerDeviceInfoName, extractor: DevInfoExtractor): void {
    const [handler, deviceInfoName] = handlerDeviceInfoName;
    this._deviceInfoName.set(serviceType, deviceInfoName);
    this._services.set(serviceType, [handler, extractor]);
  }

  /** Add service info updater method. */
  addServiceInfo(protocol: Protocol, serviceInfo: ServiceInfoMethod): void {
    this._serviceInfos.set(protocol, serviceInfo);
  }

  /** Return list of service types to scan for. */
  get services(): string[] {
    return [...this._services.keys()];
  }

  /** Start discovery of devices and services. */
  async discover(timeout: number): Promise<Map<string, BaseConfig>> {
    await this.process(timeout);

    const devices = new Map<string, BaseConfig>();
    for (const [address, foundDevice] of this._foundDevices) {
      const deviceInfo = this._getDeviceInfo(foundDevice);

      const config = new AppleTV(address, foundDevice.name, {
        deepSleep: foundDevice.deepSleep,
        properties: this._properties.get(address) as any,
        deviceInfo,
      });
      devices.set(address, config);

      for (const service of foundDevice.services) config.addService(service);

      const propertiesMap = new Map<Protocol, BaseService>(config.services.map((s) => [s.protocol, s]));

      for (const deviceService of config.services) {
        // Apply service_info after adding all services in case a merge happens.
        const serviceInfo = this._serviceInfos.get(deviceService.protocol);
        if (serviceInfo) await serviceInfo(deviceService as MutableService, deviceInfo, propertiesMap);
      }
    }
    return devices;
  }

  /** Start to process devices and services. */
  abstract process(timeout: number): Promise<void>;

  /** Call when an MDNS response was received. */
  handleResponse(response: mdns.Response): void {
    for (const service of response.services) {
      if (!this._services.has(service.type)) {
        LOGGER.warning("Discovered unsupported service %s for device %s", service.name, service.type);
        continue;
      }
      try {
        this._serviceDiscovered(service, response);
      } catch (ex) {
        LOGGER.error("Failed to parse service: %s (%s)", service.name, ex);
      }
    }
  }

  private _serviceDiscovered(service: mdns.Service, response: mdns.Response): void {
    if (service.address === null || service.port === 0) return;

    const result = this._services.get(service.type)![0](service, response);
    if (result) {
      const [name, baseService] = result;
      LOGGER.debug(
        "Auto-discovered %s at %s:%d via %s (%s)",
        service.name,
        service.address,
        service.port,
        Protocol[baseService.protocol],
        service.properties,
      );

      let found = this._foundDevices.get(service.address);
      if (!found) {
        found = {
          name,
          address: service.address,
          deepSleep: response.deepSleep,
          model: lookupInternalName(response.model),
          services: [],
        };
        this._foundDevices.set(service.address, found);
      }
      found.services.push(baseService);
    }

    // Save properties for all services belonging to a device/address
    let properties = this._properties.get(service.address);
    if (!properties) {
      properties = {};
      this._properties.set(service.address, properties);
    }
    properties[service.type] = service.properties;
  }

  private _getDeviceInfo(device: FoundDevice): DeviceInfo {
    const deviceInfo: Record<string, unknown> = {};

    // Extract device info from all service responses
    const deviceProperties = this._properties.get(device.address) ?? {};
    for (const [serviceName, serviceProperties] of Object.entries(deviceProperties)) {
      const serviceInfo = this._services.get(serviceName);
      if (serviceInfo) {
        const [, extractor] = serviceInfo;
        dictMerge(deviceInfo, extractor(serviceName, serviceProperties));
      }
    }

    // If model was discovered via _device-info._tcp.local, manually add that to the
    // device info
    if (device.model !== DeviceModel.Unknown) {
      dictMerge(deviceInfo, { [DeviceInfo.MODEL]: device.model });
    }

    return new DeviceInfo(deviceInfo);
  }
}

/** Service discovery based on unicast MDNS. */
export class UnicastMdnsScanner extends BaseScanner {
  constructor(readonly hosts: string[]) {
    super();
  }

  async process(timeout: number): Promise<void> {
    const responses = await Promise.all(this.hosts.map((host) => this._getServices(host, timeout)));
    for (const response of responses) this.handleResponse(response);
  }

  private async _getServices(host: string, timeout: number): Promise<mdns.Response> {
    const port = parseInt(getEnv("PYATV_UDNS_PORT") ?? "5353", 10); // For testing purposes
    try {
      void knock.knocker(host, KNOCK_PORTS, timeout);
      return await mdns.unicast(host, this.services, port, timeout);
    } catch (ex) {
      if (ex instanceof TimeoutError) return { services: [], deepSleep: false, model: null };
      throw ex;
    }
  }
}

/** Service discovery based on multicast MDNS. */
export class MulticastMdnsScanner extends BaseScanner {
  readonly identifier: Set<string> | null;

  constructor(identifier: string | Set<string> | null = null) {
    super();
    this.identifier = typeof identifier === "string" ? new Set([identifier]) : identifier;
  }

  async process(timeout: number): Promise<void> {
    const responses = await mdns.multicast(this.services, {
      timeout,
      endCondition: this.identifier ? (r) => this._endIfIdentifierFound(r) : null,
    });
    for (const response of responses) this.handleResponse(response);
  }

  private _endIfIdentifierFound(response: mdns.Response): boolean {
    if (!this.identifier) return false;
    for (const id of getUniqueIdentifiers(response)) {
      if (this.identifier.has(id)) return true;
    }
    return false;
  }
}
