/** Shared test code for AirPlay test cases (equivalent of conftest.py). */

import { afterEach, beforeEach } from "bun:test";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { Protocol } from "../../../src/const.ts";
import { httpConnect, type HttpConnection } from "../../../src/support/http.ts";
import { FakeAppleTV } from "../../fake_device/index.ts";
import type { FakeAirPlayState, FakeAirPlayUseCases } from "../../fake_device/airplay.ts";
import "../../fake_device/airplay.ts";

export interface AirPlayFixture {
  device: FakeAppleTV;
  state: FakeAirPlayState;
  usecase: FakeAirPlayUseCases;
  port: number;
  properties: Record<string, string>;
  connection(): Promise<HttpConnection>;
  conf(properties?: Record<string, string>): AppleTV;
}

/** Set up a fake AirPlay device for each test in the current scope. */
export function useAirPlayDevice(properties: () => Record<string, string> = () => ({})): AirPlayFixture {
  const fixture = {} as AirPlayFixture;
  const connections: HttpConnection[] = [];

  beforeEach(async () => {
    const device = new FakeAppleTV(false);
    device.addService(Protocol.AirPlay);
    await device.start();
    fixture.device = device;
    fixture.state = device.getState(Protocol.AirPlay);
    fixture.usecase = device.getUsecase(Protocol.AirPlay);
    fixture.port = device.getPort(Protocol.AirPlay);
    fixture.properties = properties();
  });

  afterEach(async () => {
    for (const conn of connections.splice(0)) conn.close();
    await fixture.device.stop();
  });

  fixture.connection = async () => {
    const conn = await httpConnect("127.0.0.1", fixture.port);
    connections.push(conn);
    return conn;
  };

  fixture.conf = (props?: Record<string, string>) => {
    const service = new ManualService("airplay_id", Protocol.AirPlay, fixture.port, props ?? fixture.properties);
    const conf = new AppleTV("127.0.0.1", "Apple TV");
    conf.addService(service);
    return conf;
  };

  return fixture;
}
