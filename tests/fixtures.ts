/** Shared test fixtures (equivalent of fixtures in conftest.py). */

import { afterEach, beforeEach, spyOn } from "bun:test";
import * as pyatv from "../src/index.ts";
import type { Protocol } from "../src/const.ts";
import type { BaseConfig, Storage } from "../src/interface.ts";
import * as knock from "../src/support/knock.ts";
import { FakeUdns, stubMulticast } from "./fake_udns.ts";

export interface UdnsFixture {
  server: FakeUdns;
  knockInfo: { ports: Set<number>; knockCount: number };
  multicastScan(options?: { timeout?: number; identifier?: string | Set<string> | null; protocol?: Protocol | Set<Protocol> | null }): Promise<BaseConfig[]>;
  unicastScan(options?: {
    timeout?: number;
    identifier?: string | Set<string> | null;
    protocol?: Protocol | Set<Protocol> | null;
    storage?: Storage | null;
  }): Promise<BaseConfig[]>;
}

/** Register before/after hooks providing a fake UDNS server and scan helpers. */
export function useUdnsServer(): UdnsFixture {
  const fixture = {} as UdnsFixture;
  let knockSpy: { mockRestore(): void } | null = null;

  beforeEach(async () => {
    fixture.knockInfo = { ports: new Set(), knockCount: 0 };
    // Make sure all UDNS tests uses a stubbed knock server
    knockSpy = spyOn(knock, "knock").mockImplementation(async (_address: string, ports: number[]) => {
      for (const port of ports) fixture.knockInfo.ports.add(port);
      fixture.knockInfo.knockCount += 1;
    });
    fixture.server = new FakeUdns();
    await fixture.server.start();
  });

  afterEach(() => {
    knockSpy?.mockRestore();
    fixture.server.close();
  });

  fixture.multicastScan = async (options = {}) => {
    const stub = stubMulticast(fixture.server);
    try {
      return await pyatv.scan({
        timeout: options.timeout ?? 1,
        identifier: options.identifier,
        protocol: options.protocol,
      });
    } finally {
      stub.mockRestore();
    }
  };

  fixture.unicastScan = async (options = {}) => {
    const previous = process.env.PYATV_UDNS_PORT;
    process.env.PYATV_UDNS_PORT = String(fixture.server.port);
    try {
      return await pyatv.scan({
        hosts: ["127.0.0.1"],
        timeout: options.timeout ?? 1,
        identifier: options.identifier,
        protocol: options.protocol,
        storage: options.storage,
      });
    } finally {
      if (previous === undefined) delete process.env.PYATV_UDNS_PORT;
      else process.env.PYATV_UDNS_PORT = previous;
    }
  };

  return fixture;
}
