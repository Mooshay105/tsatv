/** Functional tests using the API with a fake Apple TV. */

import { expect, test } from "bun:test";
import { connect } from "../../../src/index.ts";
import { AppleTV, ManualService } from "../../../src/conf.ts";
import { FeatureName, FeatureState, InputAction, KeyboardFocusState, PowerState, Protocol, TouchAction } from "../../../src/const.ts";
import { DeviceIdMissingError } from "../../../src/exceptions.ts";
import { App, type RemoteControl, UserAccount } from "../../../src/interface.ts";
import { SystemStatus } from "../../../src/protocols/companion/api.ts";
import {
  CompanionServiceFlags,
  INITIAL_RTI_TEXT,
  INITIAL_VOLUME,
  VOLUME_STEP,
} from "../../fake_device/companion.ts";
import { SavingPowerListener } from "../../shared_helpers.ts";
import { until } from "../../utils.ts";
import { useCompanionDevice } from "./shared.ts";

const TEST_APP = "com.test.Test";
const TEST_APP_NAME = "Test";
const TEST_APP_URL = "com.test.Test://test/url?param0=value0";
const TEST_APP2 = "com.test.Test2";
const TEST_APP_NAME2 = "Test2";
const TEST_ACCOUNT = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const TEST_ACCOUNT_NAME = "Alice";
const TEST_ACCOUNT2 = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const TEST_ACCOUNT_NAME2 = "Bob";

const MEDIA_CONTROL_FEATURES = [
  FeatureName.Play,
  FeatureName.Pause,
  FeatureName.Next,
  FeatureName.Previous,
  FeatureName.SkipForward,
  FeatureName.SkipBackward,
  FeatureName.Volume,
  FeatureName.SetVolume,
];

const ALWAYS_PRESENT_FEATURES = [
  FeatureName.TurnOn,
  FeatureName.TurnOff,
  FeatureName.Screensaver,
  FeatureName.AccountList,
  FeatureName.SwitchAccount,
  FeatureName.TextFocusState,
  FeatureName.TextGet,
  FeatureName.TextClear,
  FeatureName.TextAppend,
  FeatureName.TextSet,
];

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) || a === b;

const companion = useCompanionDevice();

test("connect only companion", async () => {
  const service = new ManualService(null, Protocol.Companion, 0, {}); // connect never happens
  const conf = new AppleTV("127.0.0.1", "Apple TV");
  conf.addService(service);
  await expect(connect(conf)).rejects.toThrow(DeviceIdMissingError);
});

test("subscribe unsubscribe media control", async () => {
  const client = await companion.client();
  await until(() => companion.state.interests.has("_iMC"));
  await Promise.all(client.close());
  await until(() => !companion.state.interests.has("_iMC"));
});

test("launch app", async () => {
  const client = await companion.client();
  await client.apps.launchApp(TEST_APP);
  await until(() => companion.state.activeApp === TEST_APP);
});

test("launch app with url", async () => {
  const client = await companion.client();
  await client.apps.launchApp(TEST_APP_URL);
  await until(() => companion.state.openUrl === TEST_APP_URL);
});

test("app list", async () => {
  const client = await companion.client();
  companion.usecase.setInstalledApps({ [TEST_APP]: TEST_APP_NAME, [TEST_APP2]: TEST_APP_NAME2 });

  const apps = await client.apps.appList();
  const expected = [new App(TEST_APP_NAME, TEST_APP), new App(TEST_APP_NAME2, TEST_APP2)];
  expect(apps.length).toBe(expected.length);
  apps.forEach((app, i) => expect(app.equals(expected[i])).toBe(true));
});

test("switch account", async () => {
  const client = await companion.client();
  await client.userAccounts.switchAccount(TEST_ACCOUNT);
  await until(() => companion.state.activeAccount === TEST_ACCOUNT);
});

test("account list", async () => {
  const client = await companion.client();
  companion.usecase.setAvailableAccounts({ [TEST_ACCOUNT]: TEST_ACCOUNT_NAME, [TEST_ACCOUNT2]: TEST_ACCOUNT_NAME2 });

  const accounts = await client.userAccounts.accountList();
  const expected = [new UserAccount(TEST_ACCOUNT_NAME, TEST_ACCOUNT), new UserAccount(TEST_ACCOUNT_NAME2, TEST_ACCOUNT2)];
  expect(accounts.length).toBe(expected.length);
  accounts.forEach((account, i) => expect(account.equals(expected[i])).toBe(true));
});

test("app features", async () => {
  const client = await companion.client();
  expect(client.features.getFeature(FeatureName.LaunchApp).state).toBe(FeatureState.Available);
  expect(client.features.getFeature(FeatureName.AppList).state).toBe(FeatureState.Available);
});

test.each([
  [0x0000, FeatureState.Unavailable],
  [0xffff, FeatureState.Available],
] as Array<[number, FeatureState]>)("media control features 0x%s", async (features, expectedState) => {
  companion.usecase.setControlFlags(features);
  const atv = await companion.client();
  for (const feature of MEDIA_CONTROL_FEATURES) {
    await until(() => atv.features.getFeature(feature).state === expectedState);
  }
});

test("always present features", async () => {
  const atv = await companion.client();
  for (const feature of ALWAYS_PRESENT_FEATURES) {
    expect(atv.features.getFeature(feature).state).toBe(FeatureState.Available);
  }
});

test("power functions", async () => {
  const client = await companion.client();
  expect(companion.state.poweredOn).toBe(true);

  await client.power.turnOff();
  expect(companion.state.poweredOn).toBe(false);

  await client.power.turnOn();
  expect(companion.state.poweredOn).toBe(true);
});

test("session start and stop", async () => {
  const client = await companion.client();
  expect(companion.state.sid).not.toBe(0);
  expect(companion.state.serviceType).toBe("com.apple.tvremoteservices");

  await Promise.all(client.close());
  expect(companion.state.sid).toBe(0);
});

test("tv rc session start", async () => {
  await companion.client();
  expect(companion.state.tvRcProtocolVersion).toBe("1.2");
});

test("system info includes identifier", async () => {
  await companion.client();
  expect(companion.state.systemInfo).not.toBeNull();
  expect(companion.state.systemInfo!._i).toBeTruthy();
});

const BUTTONS: Array<[string, keyof RemoteControl]> = [
  // HID
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["select", "select"],
  ["menu", "menu"],
  ["home", "home"],
  ["volume_down", "volumeDown"],
  ["volume_up", "volumeUp"],
  ["play_pause", "playPause"],
  ["channel_up", "channelUp"],
  ["channel_down", "channelDown"],
  ["guide", "guide"],
  ["control_center", "controlCenter"],
  // Media Control
  ["play", "play"],
  ["pause", "pause"],
  ["next", "next"],
  ["previous", "previous"],
  // Others
  ["screensaver", "screensaver"],
];

test.each(BUTTONS)("remote control buttons %s", async (button, method) => {
  const client = await companion.client();
  await (client.remoteControl[method] as () => Promise<void>).call(client.remoteControl);
  expect(companion.state.latestButton).toBe(button);
});

// TODO: This test does not verify that actual input action (e.g. hold). Fake service
// must be extended to support this.
const ACTIONS: Array<[string, InputAction]> = [];
for (const button of ["up", "down", "left", "right", "select", "menu", "home"]) {
  ACTIONS.push([button, InputAction.DoubleTap], [button, InputAction.Hold]);
}

test.each(ACTIONS)("button actions %s %p", async (button, action) => {
  const client = await companion.client();
  await (client.remoteControl[button as "up"] as (action: InputAction) => Promise<void>).call(client.remoteControl, action);
  expect(companion.state.latestButton).toBe(button);
});

test("remote control skip forward backward", async () => {
  const client = await companion.client();

  let duration = companion.state.duration;
  await client.remoteControl.skipForward();
  await until(() => isClose(companion.state.duration, duration + 10));

  duration = companion.state.duration;
  await client.remoteControl.skipBackward();
  await until(() => isClose(companion.state.duration, duration - 10));

  duration = companion.state.duration;
  await client.remoteControl.skipForward(10.5);
  await until(() => isClose(companion.state.duration, duration + 10.5));

  duration = companion.state.duration;
  await client.remoteControl.skipBackward(7.3);
  await until(() => isClose(companion.state.duration, duration - 7.3));

  // "From beginning"
  await client.remoteControl.skipBackward(9999999.0);
  await until(() => isClose(companion.state.duration, 0));
});

test("audio set volume", async () => {
  const client = await companion.client();
  await until(() => client.audio.volume === INITIAL_VOLUME);

  await client.audio.setVolume(INITIAL_VOLUME + 1.0);
  await until(() => isClose(client.audio.volume, INITIAL_VOLUME + 1.0));
  expect(companion.state.volume).toBeCloseTo(INITIAL_VOLUME + 1.0);
});

test("audio volume up", async () => {
  const client = await companion.client();
  await until(() => client.audio.volume === INITIAL_VOLUME);

  await client.audio.volumeUp();
  await until(() => client.audio.volume === INITIAL_VOLUME + VOLUME_STEP);
  expect(companion.state.latestButton).toBe("volume_up");
});

test("audio volume down", async () => {
  const client = await companion.client();
  await until(() => client.audio.volume === INITIAL_VOLUME);

  await client.audio.volumeDown();
  await until(() => client.audio.volume === INITIAL_VOLUME - VOLUME_STEP);
  expect(companion.state.latestButton).toBe("volume_down");
});

test("text input text focus state", async () => {
  const client = await companion.client();
  expect(client.keyboard.textFocusState).toBe(KeyboardFocusState.Focused);

  companion.usecase.setRtiFocusState(KeyboardFocusState.Unfocused);
  await until(() => client.keyboard.textFocusState === KeyboardFocusState.Unfocused);

  companion.usecase.setRtiFocusState(KeyboardFocusState.Focused);
  await until(() => client.keyboard.textFocusState === KeyboardFocusState.Focused);
});

test("text input text get", async () => {
  const client = await companion.client();
  expect(await client.keyboard.textGet()).toBe(INITIAL_RTI_TEXT);

  companion.usecase.setRtiText("test");
  expect(await client.keyboard.textGet()).toBe("test");
});

test("text input text get when no keyboard", async () => {
  const client = await companion.client();
  companion.usecase.setRtiFocusState(KeyboardFocusState.Unfocused);
  expect(await client.keyboard.textGet()).toBeNull();
});

test("text input text clear", async () => {
  const client = await companion.client();
  await client.keyboard.textClear();
  await until(() => companion.state.rtiText === "");
});

test("text input text append", async () => {
  const client = await companion.client();
  await client.keyboard.textAppend("test");
  await until(() => companion.state.rtiText === INITIAL_RTI_TEXT + "test");
});

test("text input text set", async () => {
  const client = await companion.client();
  await client.keyboard.textSet("test");
  await until(() => companion.state.rtiText === "test");
});

test("power state changes", async () => {
  const client = await companion.client();
  const listener = new SavingPowerListener();
  client.power.listener = listener;

  // Fake device default state should be "on"
  await until(() => client.power.powerState === PowerState.On);

  companion.usecase.setSystemStatus(SystemStatus.Asleep);
  await until(() => listener.lastUpdate === PowerState.Off);

  companion.usecase.setSystemStatus(SystemStatus.Screensaver);
  await until(() => listener.lastUpdate === PowerState.On);

  companion.usecase.setSystemStatus(SystemStatus.Asleep);
  await until(() => listener.lastUpdate === PowerState.Off);

  companion.usecase.setSystemStatus(SystemStatus.Awake);
  await until(() => listener.lastUpdate === PowerState.On);
});

test.each([
  [true, FeatureState.Available, PowerState.On],
  [false, FeatureState.Unsupported, PowerState.Unknown],
] as Array<[boolean, FeatureState, PowerState]>)(
  "power state availability (supported=%p)",
  async (systemStatusSupported, expectedFeatureState, expectedPowerState) => {
    companion.state.setFlagState(CompanionServiceFlags.SYSTEM_STATUS_SUPPORTED, systemStatusSupported);

    const atv = await companion.client();
    await until(() => atv.features.inState(expectedFeatureState, FeatureName.PowerState));
    expect(atv.power.powerState).toBe(expectedPowerState);
  },
);

test("text input is started before TV remote session (pyatv #2853)", async () => {
  await companion.client();
  const commands = companion.state.receivedCommands;
  expect(commands).toContain("_tiStart");
  expect(commands).toContain("TVRCSessionStart");
  expect(commands.indexOf("_tiStart")).toBeLessThan(commands.indexOf("TVRCSessionStart"));
});

test("touch", async () => {
  const client = await companion.client();
  await client.touch.swipe(0, 0, 800, 800, 200);
  await until(
    () =>
      companion.state.action !== null &&
      companion.state.action.x === 800 &&
      companion.state.action.y === 800 &&
      companion.state.action.pressMode === TouchAction.Release,
  );
});

test("touch click", async () => {
  const client = await companion.client();
  await client.touch.click(InputAction.SingleTap);
  expect(companion.state.latestButton).toBe("select");
});

test("touch hold", async () => {
  const client = await companion.client();
  await client.touch.click(InputAction.Hold);
  expect(companion.state.latestButton).toBe("select");
});

test("text input focus state listener is called", async () => {
  const client = await companion.client();
  const updates: Array<[KeyboardFocusState, KeyboardFocusState]> = [];
  client.keyboard.listener = {
    focusstateUpdate(oldState: KeyboardFocusState, newState: KeyboardFocusState) {
      updates.push([oldState, newState]);
    },
  };

  companion.usecase.setRtiFocusState(KeyboardFocusState.Unfocused);
  await until(() => updates.length >= 1);
  companion.usecase.setRtiFocusState(KeyboardFocusState.Focused);
  await until(() => updates.length >= 2);

  expect(updates.map(([, newState]) => newState)).toEqual([KeyboardFocusState.Unfocused, KeyboardFocusState.Focused]);
});
