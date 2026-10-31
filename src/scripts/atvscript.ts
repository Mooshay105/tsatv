#!/usr/bin/env bun
/** Tool modelled to be used for scripting. */

import { connect, scan } from "../index.ts";
import {
  DeviceModel,
  DeviceState,
  FeatureName,
  FeatureState,
  KeyboardFocusState,
  MediaType,
  OperatingSystem,
  PowerState,
  RepeatState,
  ShuffleState,
} from "../const.ts";
import * as iface from "../interface.ts";
import { Semaphore } from "../support/asyncio.ts";
import { DEBUG, getLogger } from "../support/logging.ts";
import {
  ALL_PROTOCOLS,
  basicConfig,
  createCommonParser,
  formatException,
  getStorage,
  logCurrentVersion,
  type Namespace,
  protocolName,
  pyJsonDumps,
  SystemExit,
  toCamelCase,
  toSnakeCase,
  transformOutput,
  transformProtocol,
  verifyScanHosts,
} from "./index.ts";
import { getIO, print } from "./io.ts";

const LOGGER = getLogger("pyatv.scripts.atvscript");

type Formatter = (data: unknown) => string;
type Output = Record<string, unknown>;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** Current local time in ISO format with time zone (like datetime.isoformat()). */
function isoNow(): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const tz = `${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}000${tz}`
  );
}

/** Produce output in intermediate format before conversion. */
export function output(success: boolean, options: { error?: string | null; exception?: unknown; values?: Output | null } = {}): Output {
  const result: Output = { result: success ? "success" : "failure", datetime: isoNow() };
  if (options.error) result.error = options.error;
  if (options.exception) {
    result.exception = options.exception instanceof Error ? options.exception.message : String(options.exception);
    result.stacktrace = formatException(options.exception);
  }
  if (options.values) Object.assign(result, options.values);
  return result;
}

const PLAYING_ENUMS: Record<string, Record<string, string | number>> = {
  mediaType: MediaType,
  deviceState: DeviceState,
  shuffle: ShuffleState,
  repeat: RepeatState,
};

/** Produce output for what is currently playing. */
export function outputPlaying(playing: iface.Playing, app: iface.App | null): Output {
  const values: Output = {};
  for (const field of Object.keys(iface.retrieveCommands(iface.Playing))) {
    const value = (playing as any)[field];
    const enumType = PLAYING_ENUMS[field];
    if (enumType && typeof value === "number") values[toSnakeCase(field)] = String(enumType[value]).toLowerCase();
    else values[toSnakeCase(field)] = value ? value : null;
  }
  values.app = app ? app.name : null;
  values.app_id = app ? app.identifier : null;
  return output(true, { values });
}

/** Listen for push updates and print changes. */
class PushPrinter implements iface.PushListener {
  constructor(
    readonly formatter: Formatter,
    readonly atv: iface.AppleTV,
  ) {}

  playstatusUpdate(_updater: iface.PushUpdater, playstatus: iface.Playing): void {
    const app = !this.atv.features.inState(FeatureState.Unavailable, FeatureName.App) ? this.atv.metadata.app : null;
    print(this.formatter(outputPlaying(playstatus, app)));
  }

  playstatusError(_updater: iface.PushUpdater, exception: Error): void {
    print(this.formatter(output(false, { exception })));
  }
}

/** Listen for power updates and print changes. */
class PowerPrinter implements iface.PowerListener {
  constructor(readonly formatter: Formatter) {}

  powerstateUpdate(_oldState: PowerState, newState: PowerState): void {
    print(this.formatter(output(true, { values: { power_state: PowerState[newState]!.toLowerCase() } })));
  }
}

/** Listen for audio updates and print changes. */
class AudioPrinter implements iface.AudioListener {
  constructor(readonly formatter: Formatter) {}

  volumeUpdate(_oldLevel: number, newLevel: number): void {
    print(this.formatter(output(true, { values: { volume: newLevel } })));
  }

  outputdevicesUpdate(_oldDevices: iface.OutputDevice[], newDevices: iface.OutputDevice[]): void {
    print(
      this.formatter(
        output(true, {
          values: { output_devices: newDevices.map((device) => ({ name: device.name, identifier: device.identifier })) },
        }),
      ),
    );
  }

  volumeDeviceUpdate(outputDevice: iface.OutputDevice, oldLevel: number, newLevel: number): void {
    print(
      this.formatter(
        output(true, { values: { output_device_id: outputDevice.identifier, old_level: oldLevel, new_level: newLevel } }),
      ),
    );
  }
}

/** Listen for keyboard updates and print changes. */
class KeyboardPrinter implements iface.KeyboardListener {
  constructor(readonly formatter: Formatter) {}

  focusstateUpdate(_oldState: KeyboardFocusState, newState: KeyboardFocusState): void {
    print(this.formatter(output(true, { values: { focus_state: KeyboardFocusState[newState]!.toLowerCase() } })));
  }
}

/** Listen for generic device updates and print them. */
class DevicePrinter implements iface.DeviceListener {
  constructor(
    readonly formatter: Formatter,
    readonly abortSem: Semaphore,
  ) {}

  connectionLost(exception: Error): void {
    print(this.formatter(output(false, { exception, values: { connection: "lost" } })));
    this.abortSem.release();
  }

  connectionClosed(): void {
    print(this.formatter(output(true, { values: { connection: "closed" } })));
    this.abortSem.release();
  }
}

/** Wait for user input (enter) or abort signal. */
async function waitForInput(abortSem: Semaphore): Promise<void> {
  await Promise.race([getIO().readline(), abortSem.acquire()]);
}

async function scanDevices(storage: iface.Storage, hosts: string[] | null): Promise<Output> {
  const atvs: Output[] = [];
  for (const atv of await scan({ hosts, storage })) {
    atvs.push({
      name: atv.name,
      address: String(atv.address),
      identifier: atv.identifier,
      all_identifiers: atv.allIdentifiers,
      device_info: {
        mac: atv.deviceInfo.mac,
        model: DeviceModel[atv.deviceInfo.model],
        model_str: atv.deviceInfo.modelStr,
        operating_system: OperatingSystem[atv.deviceInfo.operatingSystem],
        version: atv.deviceInfo.version,
      },
      services: atv.services.map((service) => ({ protocol: protocolName(service.protocol), port: service.port })),
    });
  }
  return output(true, { values: { devices: atvs } });
}

async function autodiscoverDevice(args: Namespace, storage: iface.Storage): Promise<iface.BaseConfig | null> {
  const atvs = await scan({ identifier: args.id, protocol: args.protocol, hosts: args.scan_hosts ?? undefined, storage });
  if (atvs.length === 0) return null;

  const appleTv = atvs[0]!;
  for (const proto of ALL_PROTOCOLS) {
    const service = appleTv.getService(proto);
    if (service) service.credentials = service.credentials || args[`${protocolName(proto)}_credentials`];
  }
  return appleTv;
}

async function handleCommand(args: Namespace, abortSem: Semaphore, storage: iface.Storage): Promise<Output> {
  if (args.command === "scan") return scanDevices(storage, args.scan_hosts);

  const config = await autodiscoverDevice(args, storage);
  if (!config) return output(false, { error: "device_not_found" });

  const atv = await connect(config, { storage });
  try {
    return await runCommand(atv, args, abortSem);
  } finally {
    await Promise.allSettled(atv.close());
  }
}

async function runCommand(atv: iface.AppleTV, args: Namespace, abortSem: Semaphore): Promise<Output> {
  if (args.command === "playing") {
    return outputPlaying(
      await atv.metadata.playing(),
      atv.features.inState(FeatureState.Available, FeatureName.App) ? atv.metadata.app : null,
    );
  }

  if (args.command === "push_updates") {
    const audioListener = new AudioPrinter(args.output);
    atv.power.listener = new PowerPrinter(args.output);
    atv.audio.listener = audioListener;
    atv.keyboard.listener = new KeyboardPrinter(args.output);
    atv.listener = new DevicePrinter(args.output, abortSem);
    atv.pushUpdater.listener = new PushPrinter(args.output, atv);
    atv.pushUpdater.start();
    print(args.output(output(true, { values: { power_state: PowerState[atv.power.powerState]!.toLowerCase() } })));
    audioListener.outputdevicesUpdate([], atv.audio.outputDevices);
    await waitForInput(abortSem);
    return output(true, { values: { push_updates: "finished" } });
  }

  const command = toCamelCase(args.command);
  if (command in iface.retrieveCommands(iface.RemoteControl)) {
    await (atv.remoteControl as any)[command]();
    return output(true, { values: { command: args.command } });
  }

  return output(false, { error: "unsupported_command" });
}

/** Run the application and return exit code. */
export async function appstart(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parser = createCommonParser("atvscript");
  parser.addArgument("command", { help: "command to run" });
  parser.addArgument("-i", "--id", { help: "device identifier", dest: "id", default: null });
  parser.addArgument("--protocol", { action: transformProtocol, help: "protocol to use (values: dmap, mrp)", dest: "protocol", default: null });
  parser.addArgument("-s", "--scan-hosts", { help: "scan specific hosts", dest: "scan_hosts", default: null, action: verifyScanHosts });
  parser.addArgument("--output", { help: "output format (values: json)", dest: "output", default: pyJsonDumps, action: transformOutput });
  parser.addArgument("--debug", { help: "save debug log to atvscript.log", action: "store_true", dest: "debug" });

  const creds = parser.addArgumentGroup("credentials");
  for (const prot of ALL_PROTOCOLS) {
    creds.addArgument(`--${protocolName(prot)}-credentials`, {
      help: `credentials for ${protocolName(prot)}`,
      dest: `${protocolName(prot)}_credentials`,
      default: null,
    });
  }

  let args: Namespace;
  try {
    args = parser.parseArgs(argv);
  } catch (ex) {
    if (ex instanceof SystemExit) return ex.code;
    throw ex;
  }
  const abortSem = new Semaphore(0);

  // Only allow saving to file to make sure output always has the specified format
  const removeHandler = args.debug ? basicConfig(DEBUG, { filename: "atvscript.log" }) : null;

  try {
    logCurrentVersion();
    LOGGER.debug("Started atvscript");

    const storage = getStorage(args);
    await storage.load();

    try {
      print(args.output(await handleCommand(args, abortSem, storage)));
    } catch (ex) {
      print(args.output(output(false, { exception: ex })));
    }
  } finally {
    removeHandler?.();
  }

  return 0;
}

if (import.meta.main) {
  // Report unhandled errors in the same output format (like the asyncio exception
  // handler in pyatv)
  process.on("unhandledRejection", (reason) => {
    print(pyJsonDumps(output(false, { error: String(reason), exception: reason })));
  });
  process.exit(await appstart());
}
