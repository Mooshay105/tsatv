/** Shared test code for RAOP test cases (equivalent of conftest.py). */

import { afterEach, beforeEach } from "bun:test";
import { connect } from "../../../src/index.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import type * as iface from "../../../src/interface.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import type { FakeRaopState, FakeRaopUseCases } from "../../fake_device/raop.ts";
import "../../fake_device/raop.ts";

export interface RaopFixture {
  device: FakeAppleTV;
  state: FakeRaopState;
  usecase: FakeRaopUseCases;
  /** Create configuration for fake device with specified properties. */
  conf(properties: Record<string, string>): AppleTV;
  /** Connect a client (closed automatically after the test). */
  client(properties: Record<string, string>): Promise<iface.AppleTV>;
  /** Register a client for automatic closing. */
  track(atv: iface.AppleTV): void;
}

export function useRaopDevice(): RaopFixture {
  const fixture = {} as RaopFixture;
  let clients: iface.AppleTV[] = [];

  beforeEach(async () => {
    clients = [];
    const device = new FakeAppleTV(false);
    device.addService(Protocol.RAOP);
    await device.start();
    fixture.device = device;
    fixture.state = device.getState(Protocol.RAOP);
    fixture.usecase = device.getUsecase(Protocol.RAOP);
  });

  afterEach(async () => {
    for (const client of clients) await Promise.allSettled(client.close());
    await fixture.device.stop();
  });

  fixture.conf = (properties) => {
    const service = new ManualService("raop_id", Protocol.RAOP, fixture.device.getPort(Protocol.RAOP), properties);
    const conf = new AppleTV("127.0.0.1", "Apple TV");
    conf.addService(service);
    return conf;
  };

  fixture.track = (atv) => {
    clients.push(atv);
  };

  fixture.client = async (properties) => {
    const atv = await connect(fixture.conf(properties));
    clients.push(atv);
    return atv;
  };

  return fixture;
}
