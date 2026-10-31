/** Shared test code for Companion test cases (equivalent of conftest.py). */

import { afterEach, beforeEach } from "bun:test";
import { connect } from "../../../src/index.ts";
import { CLIENT_CREDENTIALS } from "../../../src/auth/server_auth.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import type * as iface from "../../../src/interface.ts";
import type { FakeCompanionState, FakeCompanionUseCases } from "../../fake_device/companion.ts";
import "../../fake_device/companion.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";

export interface CompanionFixture {
  device: FakeAppleTV;
  state: FakeCompanionState;
  usecase: FakeCompanionUseCases;
  conf: AppleTV;
  /** Connect a client (closed automatically after the test). */
  client(): Promise<iface.AppleTV>;
}

export function useCompanionDevice(): CompanionFixture {
  const fixture = {} as CompanionFixture;
  let clients: iface.AppleTV[] = [];

  beforeEach(async () => {
    clients = [];
    const device = new FakeAppleTV(false);
    device.addService(Protocol.Companion);
    await device.start();
    fixture.device = device;
    fixture.state = device.getState(Protocol.Companion);
    fixture.usecase = device.getUsecase(Protocol.Companion);

    const airplay = new ManualService("airplayid", Protocol.AirPlay, 0, {});
    const service = new ManualService(null, Protocol.Companion, device.getPort(Protocol.Companion), {}, {
      credentials: CLIENT_CREDENTIALS,
    });
    fixture.conf = new AppleTV("127.0.0.1", "Apple TV");
    fixture.conf.addService(service);
    fixture.conf.addService(airplay);
  });

  afterEach(async () => {
    for (const client of clients) await Promise.allSettled(client.close());
    await fixture.device.stop();
  });

  fixture.client = async () => {
    const atv = await connect(fixture.conf);
    clients.push(atv);
    return atv;
  };

  return fixture;
}
