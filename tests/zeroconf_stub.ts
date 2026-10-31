/** Stub for the zeroconf responder (records registered services). */

import type { ServiceInfo, ZeroconfLike } from "../src/support/zeroconf.ts";

export class ZeroconfStub implements ZeroconfLike {
  readonly registeredServices: ServiceInfo[] = [];

  constructor(readonly services: ServiceInfo[] = []) {}

  registerService(service: ServiceInfo): void {
    this.registeredServices.push(service);
  }

  unregisterService(_service: ServiceInfo): void {}

  close(): void {}
}
