/** Smoke test for atvscript. */

import { expect, test } from "bun:test";
import { Protocol } from "../../src/const.ts";
import { AIRPLAY_ID, DMAP_ID, IP_1, IP_2, MRP_ID, useScriptEnv } from "./shared.ts";

const HASH = "ca496c14642c78af6dd4250191fe175f6dafd72b4c33bcbab43c454aae051da1";

const env = useScriptEnv();

function assertJsonOutput(output: string, expected: Record<string, unknown>): void {
  const actual = JSON.parse(output);

  // Hack for now: only check that datetime is present to work around issue with
  // different time zones.
  expect(actual).toHaveProperty("datetime");
  delete actual.datetime;

  expect(actual).toEqual(expected);
}

const sortBy = <T>(items: T[], key: (item: T) => string) => [...items].sort((a, b) => key(a).localeCompare(key(b)));

test("scan devices", async () => {
  const [stdout, , exitCode] = await env.run("atvscript", ["scan"]);

  // Order of devices, services and identifiers is not important (ignore_order in pyatv)
  const actual = JSON.parse(stdout);
  actual.devices = sortBy(actual.devices, (d: any) => d.name);
  for (const device of actual.devices) {
    device.all_identifiers.sort();
    device.services = sortBy(device.services, (s: any) => s.protocol);
  }

  assertJsonOutput(JSON.stringify(actual), {
    result: "success",
    devices: [
      {
        name: "Apple TV 1",
        address: IP_1,
        identifier: DMAP_ID,
        all_identifiers: [DMAP_ID],
        device_info: { mac: null, model: "Unknown", model_str: "Unknown", operating_system: "Legacy", version: null },
        services: [{ protocol: "dmap", port: 3689 }],
      },
      {
        name: "Apple TV 2",
        address: IP_2,
        identifier: MRP_ID,
        all_identifiers: [AIRPLAY_ID, MRP_ID],
        device_info: { mac: AIRPLAY_ID, model: "Unknown", model_str: "pyatv", operating_system: "TvOS", version: "14.7" },
        services: [
          { protocol: "airplay", port: env.fakeAtv.getPort(Protocol.AirPlay) },
          { protocol: "mrp", port: env.fakeAtv.getPort(Protocol.MRP) },
        ],
      },
    ],
  });
  expect(exitCode).toBe(0);
});

test("mrp idle", async () => {
  const [stdout, , exitCode] = await env.run("atvscript", ["--id", MRP_ID, "playing"]);
  assertJsonOutput(stdout, {
    result: "success",
    hash: HASH,
    media_type: "unknown",
    device_state: "idle",
    title: null,
    artist: null,
    album: null,
    genre: null,
    total_time: null,
    position: null,
    shuffle: "off",
    repeat: "off",
    app: null,
    app_id: null,
    series_name: null,
    season_number: null,
    episode_number: null,
    content_identifier: null,
    itunes_store_identifier: null,
  });
  expect(exitCode).toBe(0);
});
