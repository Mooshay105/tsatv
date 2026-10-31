/** Simulated environment for functional script testing (equivalent of conftest.py). */

import { afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Protocol } from "../../src/const.ts";
import { CapturedIO, setIO } from "../../src/scripts/io.ts";
import * as knock from "../../src/support/knock.ts";
import "../fake_device/airplay.ts";
import { FakeAppleTV } from "../fake_device/index.ts";
import "../fake_device/mrp.ts";
import * as fakeUdns from "../fake_udns.ts";
import { faketime } from "../utils.ts";

export const IP_1 = "10.0.0.1";
export const IP_2 = "127.0.0.1";
export const DMAP_ID = "dmapid";
export const MRP_ID = "mrp_id";
export const AIRPLAY_ID = "AA:BB:CC:DD:EE:FF";

type AppStart = (argv: string[]) => Promise<number>;

export interface ScriptEnv {
  fakeAtv: FakeAppleTV;
  udns: fakeUdns.FakeUdns;
  run(
    script: "atvremote" | "atvscript",
    args: string[],
    options?: { inputs?: string[]; persistentStorage?: boolean },
  ): Promise<[string, string, number]>;
}

export function useScriptEnv(): ScriptEnv {
  const env = {} as ScriptEnv;
  let tmpDir = "";

  beforeEach(async () => {
    env.fakeAtv = new FakeAppleTV();
    env.fakeAtv.addService(Protocol.MRP);
    env.fakeAtv.addService(Protocol.AirPlay);
    await env.fakeAtv.start();

    const udns = new fakeUdns.FakeUdns();
    udns.ipFilter = IP_2;
    await udns.start();
    udns.addService(fakeUdns.homesharingService(DMAP_ID, "Apple TV 1", "aaaa", { addresses: [IP_1] }));
    udns.addService(
      fakeUdns.mrpService("DDDD", "Apple TV 2", MRP_ID, { addresses: [IP_2], port: env.fakeAtv.getPort(Protocol.MRP) }),
    );
    udns.addService(
      fakeUdns.airplayService("Apple TV 2", AIRPLAY_ID, {
        addresses: [IP_2],
        port: env.fakeAtv.getPort(Protocol.AirPlay),
        model: "pyatv",
      }),
    );
    env.udns = udns;

    const airplayUsecase = env.fakeAtv.getUsecase(Protocol.AirPlay);
    airplayUsecase.airplayPlaybackPlaying();
    airplayUsecase.airplayPlaybackIdle();

    // Replaces pyfakefs (mockfs) with a temporary directory
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "pyatv-scripts-"));
  });

  afterEach(async () => {
    env.udns.close();
    await env.fakeAtv.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  env.run = async (script, args, options = {}) => {
    const module = (await import(`../../src/scripts/${script}.ts`)) as { appstart: AppStart };

    let argv: string[];
    if (options.persistentStorage) argv = ["--storage", "file", "--storage-file", path.join(tmpDir, "pyatv.conf")];
    else argv = ["--storage", "none"];
    argv.push(...args);

    const io = new CapturedIO((options.inputs ?? []).join("\n") + "\n");
    const previousIO = setIO(io);
    const previousPort = process.env.PYATV_UDNS_PORT;
    process.env.PYATV_UDNS_PORT = String(env.udns.port);
    const multicast = fakeUdns.stubMulticast(env.udns);
    // Stub away port knocking and ignore result (not tested here)
    const knockSpy = spyOn(knock, "knock").mockImplementation(async () => {});
    try {
      const exitCode = await faketime([0], () => module.appstart(argv));
      return [io.out, io.err, exitCode];
    } finally {
      knockSpy.mockRestore();
      multicast.mockRestore();
      if (previousPort === undefined) delete process.env.PYATV_UDNS_PORT;
      else process.env.PYATV_UDNS_PORT = previousPort;
      setIO(previousIO);
    }
  };

  return env;
}
