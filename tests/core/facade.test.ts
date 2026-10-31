/** Unit tests for pyatv.core.facade. */

import { beforeEach, describe, expect, test } from "bun:test";
import { AppleTV as AppleTVConf } from "../../src/conf.ts";
import {
  DeviceState,
  FeatureName,
  FeatureState,
  KeyboardFocusState,
  MediaType,
  OperatingSystem,
  PowerState,
  Protocol,
} from "../../src/const.ts";
import {
  AbstractPushUpdater,
  CoreStateDispatcher,
  OutputDeviceState,
  ProtocolStateDispatcher,
  type SetupData,
  UpdatedState,
} from "../../src/core/index.ts";
import { FacadeAppleTV } from "../../src/core/facade.ts";
import {
  BlockedStateError,
  InvalidStateError,
  NoServiceError,
  NotSupportedError,
  ProtocolError,
} from "../../src/exceptions.ts";
import {
  Apps,
  Audio,
  type AudioListener,
  type DeviceListener,
  DeviceInfo,
  FeatureInfo,
  Features,
  Keyboard,
  type KeyboardListener,
  Metadata,
  OutputDevice,
  Playing,
  Power,
  type PushListener,
  PushUpdater,
  RemoteControl,
  Stream,
  TouchGestures,
  UserAccounts,
} from "../../src/interface.ts";
import { Settings } from "../../src/settings.ts";
import { Event } from "../../src/support/asyncio.ts";
import { type ClientSessionManager, createSession } from "../../src/support/http.ts";
import { SavingPowerListener } from "../shared_helpers.ts";
import { until } from "../utils.ts";

const TEST_URL = "http://test";

const INTERFACES = [Features, RemoteControl, Metadata, Power, PushUpdater, Stream, Apps, UserAccounts, Audio, Keyboard, TouchGestures];

let sessionManager: ClientSessionManager;
let coreDispatcher: CoreStateDispatcher;
let facadeDummy: FacadeAppleTV;
let mrpStateDispatcher: ProtocolStateDispatcher;
let dmapStateDispatcher: ProtocolStateDispatcher;
let companionStateDispatcher: ProtocolStateDispatcher;

beforeEach(async () => {
  sessionManager = await createSession();
  coreDispatcher = new CoreStateDispatcher();
  mrpStateDispatcher = new ProtocolStateDispatcher(Protocol.MRP, coreDispatcher);
  dmapStateDispatcher = new ProtocolStateDispatcher(Protocol.DMAP, coreDispatcher);
  companionStateDispatcher = new ProtocolStateDispatcher(Protocol.Companion, coreDispatcher);
  facadeDummy = new FacadeAppleTV(new AppleTVConf("127.0.0.1", "Test"), sessionManager, coreDispatcher, new Settings());
});

class SetupDataGenerator {
  connectCalled = false;
  closeCalled = false;
  closeCalls = 0;
  interfaces = new Map<unknown, unknown>();
  features: Set<FeatureName>;
  pendingTasks = new Set<Promise<unknown>>();
  connectSucceeded = true;
  deviceInfo: Record<string, unknown> = {};

  constructor(
    readonly protocol: Protocol,
    ...features: FeatureName[]
  ) {
    this.features = new Set(features);
  }

  async connect(): Promise<boolean> {
    this.connectCalled = true;
    return this.connectSucceeded;
  }

  close(): Set<Promise<unknown>> {
    this.closeCalled = true;
    this.closeCalls += 1;
    return this.pendingTasks;
  }

  getSetupData(): SetupData {
    return {
      protocol: this.protocol,
      connect: () => this.connect(),
      close: () => this.close(),
      deviceInfo: () => this.deviceInfo,
      interfaces: this.interfaces,
      features: this.features,
    };
  }
}

class DummyFeatures extends Features {
  constructor(
    readonly featureName: FeatureName,
    readonly featureState = FeatureState.Available,
  ) {
    super();
  }

  override getFeature(featureName: FeatureName): FeatureInfo {
    return new FeatureInfo(featureName === this.featureName ? this.featureState : FeatureState.Unsupported);
  }
}

class DummyPower extends Power {
  currentState = PowerState.Off;
  turnOnCalled = false;
  turnOffCalled = false;

  override get powerState(): PowerState {
    return this.currentState;
  }

  override async turnOn(): Promise<void> {
    this.turnOnCalled = true;
  }

  override async turnOff(): Promise<void> {
    this.turnOffCalled = true;
  }
}

class DummyAudio extends Audio {
  constructor(private _vol: number) {
    super();
  }

  override get volume(): number {
    return this._vol;
  }

  override async setVolume(level: number): Promise<void> {
    this._vol = level;
  }
}

class DummyKeyboard extends Keyboard {
  constructor(private readonly _focusState: KeyboardFocusState) {
    super();
  }

  get focusState(): KeyboardFocusState {
    return this._focusState;
  }
}

class DummyDeviceListener implements DeviceListener {
  lostCalls = 0;
  closedCalls = 0;

  connectionLost(): void {
    this.lostCalls += 1;
  }

  connectionClosed(): void {
    this.closedCalls += 1;
  }
}

class DummyStream extends Stream {
  url: string | null = null;

  override async playUrl(url: string): Promise<void> {
    this.url = url;
  }
}

class DummyPushUpdater extends AbstractPushUpdater {
  private _active = false;

  get active(): boolean {
    return this._active;
  }

  start(): void {
    this._active = true;
  }

  stop(): void {
    this._active = false;
  }
}

class SavingPushListener implements PushListener {
  lastUpdate: Playing | null = null;
  noOfUpdates = 0;

  playstatusUpdate(_updater: PushUpdater, playstatus: Playing): void {
    this.lastUpdate = playstatus;
    this.noOfUpdates += 1;
  }

  playstatusError(): void {}
}

class SavingAudioListener implements AudioListener {
  lastUpdate: unknown = null;
  allUpdates: unknown[] = [];

  volumeUpdate(_old: number, newLevel: number): void {
    this.lastUpdate = newLevel;
    this.allUpdates.push(newLevel);
  }

  outputdevicesUpdate(_old: OutputDevice[], newDevices: OutputDevice[]): void {
    this.lastUpdate = newDevices;
    this.allUpdates.push(newDevices);
  }

  volumeDeviceUpdate(outputDevice: OutputDevice, _old: number, newLevel: number): void {
    this.lastUpdate = new OutputDeviceState(outputDevice.identifier, newLevel);
    this.allUpdates.push(outputDevice);
  }
}

class SavingKeyboardListener implements KeyboardListener {
  lastUpdate: KeyboardFocusState | null = null;
  allUpdates: KeyboardFocusState[] = [];

  focusstateUpdate(_old: KeyboardFocusState, newState: KeyboardFocusState): void {
    this.lastUpdate = newState;
    this.allUpdates.push(newState);
  }
}

function findInterface(instance: object): object {
  for (let proto = Object.getPrototypeOf(instance); proto; proto = Object.getPrototypeOf(proto)) {
    const cls = INTERFACES.find((c) => c.prototype === proto);
    if (cls) return cls;
  }
  throw new Error("no interface found");
}

function registerInterface<T extends object>(feature: FeatureName, instance: T, protocol: Protocol): [T, SetupDataGenerator] {
  const sdg = new SetupDataGenerator(protocol, feature);
  sdg.interfaces.set(findInterface(instance), instance);
  facadeDummy.addProtocol(sdg.getSetupData());
  return [instance, sdg];
}

test("connect with no protocol", async () => {
  await expect(facadeDummy.connect()).rejects.toBeInstanceOf(NoServiceError);
});

test("connect again raises", async () => {
  registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  await facadeDummy.connect();
  await expect(facadeDummy.connect()).rejects.toBeInstanceOf(InvalidStateError);
});

test("add after connect raises", async () => {
  const feat = facadeDummy.features;
  registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  expect(feat.getFeature(FeatureName.Play).state).toBe(FeatureState.Unsupported);
  await facadeDummy.connect();
  expect(feat.getFeature(FeatureName.Play).state).toBe(FeatureState.Available);
});

test("features multi instances", async () => {
  registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  registerInterface(FeatureName.Pause, new DummyFeatures(FeatureName.Pause), Protocol.MRP);
  await facadeDummy.connect();
  const feat = facadeDummy.features;
  expect(feat.getFeature(FeatureName.Pause).state).toBe(FeatureState.Available);
  expect(feat.getFeature(FeatureName.Play).state).toBe(FeatureState.Available);
  expect(feat.getFeature(FeatureName.PlayUrl).state).toBe(FeatureState.Unsupported);
});

test("ignore already connected protocol", async () => {
  registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  registerInterface(FeatureName.Pause, new DummyFeatures(FeatureName.Pause), Protocol.DMAP);
  await facadeDummy.connect();
  const feat = facadeDummy.features;
  expect(feat.getFeature(FeatureName.Play).state).toBe(FeatureState.Available);
  expect(feat.getFeature(FeatureName.Pause).state).toBe(FeatureState.Unsupported);
});

test("features feature overlap uses priority", async () => {
  registerInterface(FeatureName.Pause, new DummyFeatures(FeatureName.Pause, FeatureState.Unavailable), Protocol.MRP);
  registerInterface(FeatureName.Pause, new DummyFeatures(FeatureName.Pause), Protocol.DMAP);
  await facadeDummy.connect();
  expect(facadeDummy.features.getFeature(FeatureName.Pause).state).toBe(FeatureState.Unavailable);
});

test("features push updates", async () => {
  const feat = facadeDummy.features;
  expect(feat.getFeature(FeatureName.PushUpdates).state).toBe(FeatureState.Unsupported);
  registerInterface(FeatureName.PushUpdates, new DummyPushUpdater(mrpStateDispatcher), Protocol.MRP);
  await facadeDummy.connect();
  expect(feat.getFeature(FeatureName.PushUpdates).state).toBe(FeatureState.Available);
});

test.each([-0.1, 100.1])("audio get volume out of range %p", async (volume) => {
  registerInterface(FeatureName.Volume, new DummyAudio(volume), Protocol.RAOP);
  await facadeDummy.connect();
  expect(() => facadeDummy.audio.volume).toThrow(ProtocolError);
});

test.each([-0.1, 100.1])("audio set volume out of range %p", async (volume) => {
  registerInterface(FeatureName.Volume, new DummyAudio(volume), Protocol.RAOP);
  await expect(facadeDummy.audio.setVolume(volume)).rejects.toBeInstanceOf(ProtocolError);
});

test("close pending tasks", async () => {
  let called = false;
  facadeDummy.addProtocol({
    protocol: Protocol.DMAP,
    connect: async () => true,
    close: () =>
      new Set([
        (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          called = true;
        })(),
      ]),
    deviceInfo: () => ({}),
    interfaces: new Map([[Power, new DummyPower()]]),
    features: new Set([FeatureName.Play]),
  });

  await facadeDummy.connect();

  // close will return remaining tasks but not run them
  const tasks = facadeDummy.close();
  expect(called).toBe(false);

  // Let remaining tasks run and verify they have finished
  await Promise.all(tasks);
  expect(called).toBe(true);
  expect(sessionManager.session.closed).toBe(true);
});

test("only one device update", () => {
  const listener = new DummyDeviceListener();
  facadeDummy.listener = listener;
  facadeDummy.listener.connectionLost(new Error());
  expect(listener.lostCalls).toBe(1);
  expect(listener.closedCalls).toBe(0);
  facadeDummy.listener.connectionClosed();
  expect(listener.lostCalls).toBe(1);
  expect(listener.closedCalls).toBe(0);
});

test("device update disconnect protocols", async () => {
  const [, dmapSdg] = registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  const [, mrpSdg] = registerInterface(FeatureName.Pause, new DummyFeatures(FeatureName.Pause), Protocol.MRP);
  await facadeDummy.connect();
  facadeDummy.listener.connectionClosed();
  expect(dmapSdg.closeCalled).toBe(true);
  expect(mrpSdg.closeCalled).toBe(true);
});

test("close only once", async () => {
  const [, sdg] = registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  await facadeDummy.connect();
  facadeDummy.close();
  expect(sdg.closeCalls).toBe(1);
  facadeDummy.close();
  expect(sdg.closeCalls).toBe(1);
});

test("close returns pending tasks from previous close", async () => {
  const [, sdg] = registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  await facadeDummy.connect();
  const task = Promise.resolve();
  sdg.pendingTasks.add(task);
  facadeDummy.close();
  const pendingTasks = facadeDummy.close();
  expect(pendingTasks.size).toBe(2);
  expect(pendingTasks.has(task)).toBe(true);
});

test("device info from single protocol", async () => {
  const [, sdg] = registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  Object.assign(sdg.deviceInfo, { [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS, [DeviceInfo.VERSION]: "1.0" });
  await facadeDummy.connect();
  const devInfo = facadeDummy.deviceInfo;
  expect(devInfo.operatingSystem).toBe(OperatingSystem.TvOS);
  expect(devInfo.version).toBe("1.0");
});

test("device info from multiple protocols", async () => {
  const [, sdgDmap] = registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  const [, sdgMrp] = registerInterface(FeatureName.Pause, new DummyFeatures(FeatureName.Pause), Protocol.MRP);
  Object.assign(sdgDmap.deviceInfo, {
    [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.TvOS,
    [DeviceInfo.VERSION]: "1.0",
  });
  Object.assign(sdgMrp.deviceInfo, {
    [DeviceInfo.OPERATING_SYSTEM]: OperatingSystem.Legacy,
    [DeviceInfo.VERSION]: "3.0",
    [DeviceInfo.BUILD_NUMBER]: "ABC",
  });
  await facadeDummy.connect();
  const devInfo = facadeDummy.deviceInfo;
  expect(devInfo.operatingSystem).toBe(OperatingSystem.TvOS);
  expect(devInfo.version).toBe("1.0");
  expect(devInfo.buildNumber).toBe("ABC");
});

test("stream play url not available", async () => {
  registerInterface(FeatureName.Volume, new DummyStream(), Protocol.RAOP);
  await facadeDummy.connect();
  await expect(facadeDummy.stream.playUrl(TEST_URL)).rejects.toBeInstanceOf(NotSupportedError);
});

test("stream play url available", async () => {
  const [stream] = registerInterface(FeatureName.PlayUrl, new DummyStream(), Protocol.RAOP);
  registerInterface(FeatureName.PlayUrl, new DummyFeatures(FeatureName.PlayUrl), Protocol.DMAP);
  await facadeDummy.connect();
  await facadeDummy.stream.playUrl(TEST_URL);
  expect(stream.url).toBe(TEST_URL);
});

test("takeover and release", async () => {
  registerInterface(FeatureName.Volume, new DummyAudio(100.0), Protocol.RAOP);
  registerInterface(FeatureName.Volume, new DummyAudio(0.0), Protocol.MRP);
  await facadeDummy.connect();
  const audio = facadeDummy.audio;
  expect(audio.volume).toBeCloseTo(0.0);
  const takeoverRelease = facadeDummy.takeover(Protocol.RAOP, Audio);
  expect(audio.volume).toBeCloseTo(100.0);
  takeoverRelease();
  expect(audio.volume).toBeCloseTo(0.0);
});

function registerBasicInterfaces(protocol: Protocol): SetupDataGenerator {
  const [, sdg] = registerInterface(FeatureName.PlayUrl, new DummyFeatures(FeatureName.PlayUrl), protocol);
  sdg.interfaces.set(Audio, new DummyAudio(0.0));
  sdg.interfaces.set(Keyboard, new DummyKeyboard(KeyboardFocusState.Unfocused));
  sdg.interfaces.set(Stream, new DummyStream());
  return sdg;
}

test("takeover failure restores", async () => {
  registerBasicInterfaces(Protocol.RAOP);
  registerBasicInterfaces(Protocol.DMAP);
  const sdgMrp = registerBasicInterfaces(Protocol.MRP);
  await facadeDummy.connect();

  facadeDummy.takeover(Protocol.RAOP, Audio);
  expect(() => facadeDummy.takeover(Protocol.DMAP, Stream, Audio)).toThrow(InvalidStateError);

  await facadeDummy.stream.playUrl("test");
  expect((sdgMrp.interfaces.get(Stream) as DummyStream).url).toBe("test");
});

test("takeover push updates", async () => {
  const listener = new SavingPushListener();
  const dmapPusher = new DummyPushUpdater(dmapStateDispatcher);
  const mrpPusher = new DummyPushUpdater(mrpStateDispatcher);

  const performUpdate = async (expectedUpdates: number, expectedProtocol: string) => {
    dmapPusher.postUpdate(new Playing({ mediaType: MediaType.Music, deviceState: DeviceState.Idle, title: `dmap_${expectedUpdates}` }));
    mrpPusher.postUpdate(new Playing({ mediaType: MediaType.Music, deviceState: DeviceState.Idle, title: `mrp_${expectedUpdates}` }));
    await until(() => listener.noOfUpdates === expectedUpdates);
    expect(listener.lastUpdate!.title).toBe(`${expectedProtocol}_${expectedUpdates}`);
  };

  registerInterface(FeatureName.PushUpdates, dmapPusher, Protocol.DMAP);
  registerInterface(FeatureName.PushUpdates, mrpPusher, Protocol.MRP);
  await facadeDummy.connect();
  const pushUpdater = facadeDummy.pushUpdater;
  pushUpdater.listener = listener;
  pushUpdater.start();

  await performUpdate(1, "mrp");
  const takeoverRelease = facadeDummy.takeover(Protocol.DMAP, PushUpdater);
  await performUpdate(2, "dmap");
  takeoverRelease();
  await performUpdate(3, "mrp");
});

test("start stop all push updaters", async () => {
  const dmapPusher = new DummyPushUpdater(dmapStateDispatcher);
  const mrpPusher = new DummyPushUpdater(mrpStateDispatcher);
  registerInterface(FeatureName.PushUpdates, dmapPusher, Protocol.DMAP);
  registerInterface(FeatureName.PushUpdates, mrpPusher, Protocol.MRP);
  await facadeDummy.connect();
  const pushUpdater = facadeDummy.pushUpdater;
  expect(dmapPusher.active).toBe(false);
  expect(mrpPusher.active).toBe(false);
  pushUpdater.start();
  expect(dmapPusher.active).toBe(true);
  expect(mrpPusher.active).toBe(true);
  pushUpdater.stop();
  expect(dmapPusher.active).toBe(false);
  expect(mrpPusher.active).toBe(false);
});

test("push updaters stop on close", async () => {
  const dmapPusher = new DummyPushUpdater(dmapStateDispatcher);
  const mrpPusher = new DummyPushUpdater(mrpStateDispatcher);
  registerInterface(FeatureName.PushUpdates, dmapPusher, Protocol.DMAP);
  registerInterface(FeatureName.PushUpdates, mrpPusher, Protocol.MRP);
  await facadeDummy.connect();
  facadeDummy.pushUpdater.start();
  facadeDummy.close();
  expect(dmapPusher.active).toBe(false);
  expect(mrpPusher.active).toBe(false);
});

// POWER RELATED TESTS

test.each([
  [FeatureName.TurnOn, "turnOn"],
  [FeatureName.TurnOff, "turnOff"],
] as const)("power prefer companion %p", async (feature, func) => {
  const [powerMrp] = registerInterface(feature, new DummyPower(), Protocol.MRP);
  const [powerComp] = registerInterface(feature, new DummyPower(), Protocol.Companion);
  await facadeDummy.connect();
  await facadeDummy.power[func]();
  expect((powerMrp as any)[`${func}Called`]).toBe(false);
  expect((powerComp as any)[`${func}Called`]).toBe(true);
});

async function dispatchAndWait(dispatcher: ProtocolStateDispatcher, state: UpdatedState, value: unknown): Promise<void> {
  const event = new Event();
  // Add a listener last and make it set an event. That way we can synchronize and
  // know that all other listeners have been called.
  dispatcher.listenTo(state, () => event.set());
  dispatcher.dispatch(state, value);
  await event.wait();
}

describe("power", () => {
  let powerInstance: DummyPower;
  let listener: SavingPowerListener;

  const powerSetup = async () => {
    powerInstance = new DummyPower();
    listener = new SavingPowerListener();
    registerInterface(FeatureName.PowerState, powerInstance, Protocol.MRP);
    await facadeDummy.connect();
    facadeDummy.power.listener = listener;
    return facadeDummy.power;
  };

  test("power state defaults to derived power state from on", async () => {
    const power = await powerSetup();
    powerInstance.currentState = PowerState.On;
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Playing, new Playing({ deviceState: DeviceState.Playing }));
    expect(listener.lastUpdate).toBeNull();
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Playing, new Playing({ deviceState: DeviceState.Idle }));
    expect(power.powerState).toBe(PowerState.On);
    expect(listener.lastUpdate).toBeNull();
  });

  test("power play state no listener duplicates", async () => {
    const power = (await powerSetup()) as any;
    expect(power.powerState).toBe(PowerState.Off);
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Playing, new Playing({ deviceState: DeviceState.Playing }));
    power.powerstateUpdate(PowerState.Off, PowerState.On);
    expect(listener.allUpdates.length).toBe(1);
    expect(listener.lastUpdate).toBe(PowerState.On);
  });

  test("power no updates without power instance", async () => {
    const saving = new SavingPowerListener();
    registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
    await facadeDummy.connect();
    facadeDummy.power.listener = saving;
    expect(() => facadeDummy.power.powerState).toThrow(NotSupportedError);
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Playing, new Playing({ deviceState: DeviceState.Playing }));
    expect(saving.lastUpdate).toBeNull();
  });
});

// AUDIO RELATED TESTS

describe("audio", () => {
  let listener: SavingAudioListener;

  beforeEach(async () => {
    listener = new SavingAudioListener();
    registerBasicInterfaces(Protocol.MRP);
    await facadeDummy.connect();
    facadeDummy.audio.listener = listener;
  });

  const ATV = () => new OutputDevice("Apple TV", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  const HOMEPOD = () => new OutputDevice("HomePod", "FFFFFFFF-GGGG-HHHH-IIII-JJJJJJJJJJJJ");

  test("listener volume updates", async () => {
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Volume, 10.0);
    expect(listener.lastUpdate).toBe(10.0);
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Volume, 20.0);
    expect(listener.lastUpdate).toBe(20.0);
  });

  test("no listener volume duplicates", async () => {
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Volume, 10.0);
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.Volume, 10.0);
    expect(listener.allUpdates.length).toBe(1);
    expect(listener.lastUpdate).toBe(10.0);
  });

  test("listener output devices updates", async () => {
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.OutputDevices, [ATV()]);
    expect(listener.lastUpdate).toEqual([ATV()]);
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.OutputDevices, [ATV(), HOMEPOD()]);
    expect(listener.lastUpdate).toEqual([ATV(), HOMEPOD()]);
  });

  test("no listener output devices duplicates", async () => {
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.OutputDevices, [ATV()]);
    await dispatchAndWait(mrpStateDispatcher, UpdatedState.OutputDevices, [ATV()]);
    expect(listener.allUpdates.length).toBe(1);
    expect(listener.lastUpdate).toEqual([ATV()]);
  });

  test("listener volume device updates", async () => {
    await dispatchAndWait(
      mrpStateDispatcher,
      UpdatedState.OutputDeviceVolume,
      new OutputDeviceState("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", 10.0),
    );
    expect(listener.lastUpdate).toEqual(new OutputDeviceState("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", 10.0));
  });
});

// KEYBOARD RELATED TESTS

describe("keyboard", () => {
  let listener: SavingKeyboardListener;

  beforeEach(async () => {
    listener = new SavingKeyboardListener();
    registerBasicInterfaces(Protocol.Companion);
    await facadeDummy.connect();
    facadeDummy.keyboard.listener = listener;
  });

  test("listener updates", async () => {
    await dispatchAndWait(companionStateDispatcher, UpdatedState.KeyboardFocus, KeyboardFocusState.Focused);
    expect(listener.lastUpdate).toBe(KeyboardFocusState.Focused);
    await dispatchAndWait(companionStateDispatcher, UpdatedState.KeyboardFocus, KeyboardFocusState.Unfocused);
    expect(listener.lastUpdate).toBe(KeyboardFocusState.Unfocused);
  });

  test("no listener duplicates", async () => {
    await dispatchAndWait(companionStateDispatcher, UpdatedState.KeyboardFocus, KeyboardFocusState.Focused);
    await dispatchAndWait(companionStateDispatcher, UpdatedState.KeyboardFocus, KeyboardFocusState.Focused);
    expect(listener.allUpdates.length).toBe(1);
    expect(listener.lastUpdate).toBe(KeyboardFocusState.Focused);
  });
});

// GUARD CALLS AFTER CLOSE

function getInterfaceMembers(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype).filter((name) => name !== "constructor" && !name.startsWith("_"));
}

async function assertInterfaceGuarded(obj: any, members: string[], exclude: Set<string> = new Set()) {
  for (const name of members.filter((m) => !exclude.has(m))) {
    let blocked = false;
    try {
      const value = obj[name];
      if (typeof value === "function") await value.call(obj);
    } catch (ex) {
      if (ex instanceof BlockedStateError) blocked = true;
      else throw new Error(`method ${name} raised ${ex}`);
    }
    if (!blocked) throw new Error(`method ${name} is not guarded`);
  }
}

const APPLE_TV_MEMBERS = [
  "connect",
  "settings",
  "deviceInfo",
  "service",
  "remoteControl",
  "metadata",
  "pushUpdater",
  "stream",
  "power",
  "features",
  "apps",
  "userAccounts",
  "audio",
  "keyboard",
  "touch",
];

test("base methods guarded after close", async () => {
  registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  await facadeDummy.connect();
  facadeDummy.close();
  await assertInterfaceGuarded(facadeDummy, APPLE_TV_MEMBERS);
});

test.each([
  [RemoteControl, "remoteControl", []],
  [Metadata, "metadata", []],
  [PushUpdater, "pushUpdater", []],
  [Stream, "stream", []],
  [Power, "power", []],
  // inState is not abstract but uses getFeature, which will raise
  [Features, "features", ["inState", "allFeatures"]],
  [Apps, "apps", []],
  [Audio, "audio", []],
  [UserAccounts, "userAccounts", []],
  [Keyboard, "keyboard", []],
  [TouchGestures, "touch", []],
] as Array<[any, string, string[]]>)("interface methods guarded after close %#", async (ifaceClass, member, exclude) => {
  registerInterface(FeatureName.Play, new DummyFeatures(FeatureName.Play), Protocol.DMAP);
  await facadeDummy.connect();
  const instance = (facadeDummy as any)[member];
  facadeDummy.close();
  const members = ifaceClass === PushUpdater ? ["active", "start", "stop"] : getInterfaceMembers(ifaceClass);
  await assertInterfaceGuarded(instance, members, new Set(exclude));
});
