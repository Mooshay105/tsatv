/** Smoke test for atvremote. */

import { expect, test } from "bun:test";
import { parseCredentials } from "../../src/auth/hap_pairing.ts";
import { CLIENT_CREDENTIALS } from "../../src/auth/server_auth.ts";
import { Protocol } from "../../src/const.ts";
import { DEVICE_AUTH_KEY, DEVICE_CREDENTIALS, DEVICE_PIN } from "../fake_device/airplay.ts";
import { allIn } from "../utils.ts";
import { AIRPLAY_ID, DMAP_ID, IP_1, IP_2, MRP_ID, useScriptEnv } from "./shared.ts";

const env = useScriptEnv();

const expectAllIn = (text: string, ...strings: string[]) => {
  if (!allIn(text, ...strings)) throw new Error(`expected all of ${JSON.stringify(strings)} in output:\n${text}`);
};

test("scan devices", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["scan"]);
  expectAllIn(stdout, "Apple TV 1", "Apple TV 2", IP_1, IP_2, MRP_ID, AIRPLAY_ID, DMAP_ID);
  expect(exitCode).toBe(0);
});

test("scan hosts", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--scan-hosts", "127.0.0.1", "scan"]);
  expectAllIn(stdout, "Apple TV 2", IP_2, MRP_ID, AIRPLAY_ID);
  expect(exitCode).toBe(0);
});

test("scan single identifier", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--id", MRP_ID, "scan"]);
  expectAllIn(stdout, "Apple TV 2", IP_2, MRP_ID, AIRPLAY_ID);
  expect(exitCode).toBe(0);
});

test("scan multiple identifier", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--id", `bad_id,${DMAP_ID}`, "scan"]);
  expectAllIn(stdout, "Apple TV 1", IP_1, DMAP_ID);
  expect(exitCode).toBe(0);
});

test("pair airplay", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--address", IP_2, "--protocol", "airplay", "--id", MRP_ID, "pair"], {
    inputs: [String(DEVICE_PIN)],
  });
  expectAllIn(stdout, "Enter PIN", "seems to have succeeded", String(parseCredentials(DEVICE_CREDENTIALS)));
  expect(exitCode).toBe(0);
});

test("airplay play url", async () => {
  const [, , exitCode] = await env.run("atvremote", ["--id", MRP_ID, "--airplay-credentials", DEVICE_CREDENTIALS, "play_url=http://fake"], {
    inputs: [String(DEVICE_PIN)],
  });
  expect(exitCode).toBe(0);
});

test("mrp idle", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--id", MRP_ID, "playing"]);
  expectAllIn(stdout, "Media type: Unknown", "Device state: Idle");
  expect(exitCode).toBe(0);
});

test("device info", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--id", MRP_ID, "device_info"]);
  expectAllIn(stdout, "tvOS", AIRPLAY_ID);
  expect(exitCode).toBe(0);
});

test("mrp auth", async () => {
  const [stdout, , exitCode] = await env.run("atvremote", ["--id", MRP_ID, "--mrp-credentials", CLIENT_CREDENTIALS, "playing"]);
  expect(env.fakeAtv.getState(Protocol.MRP).hasAuthenticated).toBe(true);
  expectAllIn(stdout, "Device state: Idle");
  expect(exitCode).toBe(0);
});

test("mrp auth error", async () => {
  const [, stderr, exitCode] = await env.run("atvremote", ["--id", MRP_ID, "--mrp-credentials", "30:31:32:33", "playing"]);
  expect(env.fakeAtv.getState(Protocol.MRP).hasAuthenticated).toBe(false);
  expectAllIn(stderr, "AuthenticationError");
  expect(exitCode).toBe(1);
});

test("manual connect", async () => {
  const [stdout, , exitCode] = await env.run(
    "atvremote",
    ["--address", IP_2, "--protocol", "mrp", "--port", String(env.fakeAtv.getPort(Protocol.MRP)), "--id", MRP_ID, "--manual", "playing"],
    { inputs: [String(DEVICE_PIN)] },
  );
  expectAllIn(stdout, "Media type: Unknown", "Device state: Idle");
  expect(exitCode).toBe(0);
});

test("settings", async () => {
  const run = (...args: string[]) => env.run("atvremote", ["--id", MRP_ID, ...args], { persistentStorage: true });

  // Check setting has default value (None)
  let [stdout, , exitCode] = await run("print_settings");
  expectAllIn(stdout, "protocols.raop.password = None");
  expect(exitCode).toBe(0);

  // Change value of protocols.raop.password
  [, , exitCode] = await run("change_setting=protocols.raop.password,foo");
  expect(exitCode).toBe(0);

  // Check value was updated
  [stdout, , exitCode] = await run("print_settings");
  expectAllIn(stdout, "protocols.raop.password = foo");
  expect(exitCode).toBe(0);

  // Unset value of protocols.raop.password (to None)
  [, , exitCode] = await run("unset_setting=protocols.raop.password");
  expect(exitCode).toBe(0);

  // Check value was updated
  [stdout, , exitCode] = await run("print_settings");
  expectAllIn(stdout, "protocols.raop.password = None");
  expect(exitCode).toBe(0);
});

test("wizard", async () => {
  // Run the wizard but limit scanning to a single device since scanning order might
  // become unpredictable otherwise
  let [stdout, , exitCode] = await env.run("atvremote", ["-s", IP_2, "wizard"], {
    inputs: ["1", String(DEVICE_PIN)],
    persistentStorage: true,
  });
  expectAllIn(stdout, "MRP is disabled", "Pairing finished", "Currently playing");
  expect(exitCode).toBe(0);

  // Check that credentials was saved to storage
  [stdout, , exitCode] = await env.run("atvremote", ["-s", IP_2, "print_settings"], { persistentStorage: true });
  expectAllIn(stdout, DEVICE_AUTH_KEY.toLowerCase());
  expect(exitCode).toBe(0);
});
