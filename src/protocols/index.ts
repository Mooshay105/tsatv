/** Module containing all protocol logic. */

import { Protocol } from "../const.ts";
import type { Core, MutableService, SetupData } from "../core/index.ts";
import type { ScanMethod } from "../core/scan.ts";
import type { BaseService, DeviceInfo, PairingHandler } from "../interface.ts";

export type SetupMethod = (core: Core) => Iterable<SetupData> | AsyncIterable<SetupData>;
export type PairMethod = (core: Core, options?: Record<string, unknown>) => PairingHandler;
export type DeviceInfoMethod = (serviceType: string, properties: Record<string, string> | Map<string, string>) => Record<string, unknown>;
export type ServiceInfoMethod = (
  service: MutableService,
  devinfo: DeviceInfo,
  services: Map<Protocol, BaseService>,
) => Promise<void>;

/** Represent implementation of a protocol. */
export interface ProtocolMethods {
  setup: SetupMethod;
  scan: ScanMethod;
  pair: PairMethod;
  deviceInfo: DeviceInfoMethod;
  serviceInfo: ServiceInfoMethod;
}

/** All protocol implementations (in priority order used when scanning/connecting). */
export const PROTOCOLS = new Map<Protocol, ProtocolMethods>();

/** Register a protocol implementation. */
export function registerProtocol(protocol: Protocol, methods: ProtocolMethods): void {
  PROTOCOLS.set(protocol, methods);
}
