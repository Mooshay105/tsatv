/** Unit tests for client and player management. */

import { beforeEach, expect, test } from "bun:test";
import * as messages from "../../../src/protocols/mrp/messages.ts";
import { COCOA_EPOCH_OFFSET, mrpHooks, PlayerStateManager } from "../../../src/protocols/mrp/player_state.ts";
import * as pb from "../../../src/protocols/mrp/protobuf/index.ts";
import type { MrpProtocol } from "../../../src/protocols/mrp/protocol.ts";
import { MrpProtocolMock } from "./protocol_mock.ts";

const CLIENT_ID_1 = "client_id_1";
const CLIENT_NAME_1 = "client_name_1";
const CLIENT_ID_2 = "client_id_2";
const PLAYER_ID_1 = "player_id_1";
const PLAYER_NAME_1 = "player_name_1";
const DEFAULT_PLAYER = "MediaRemote-DefaultPlayer";

function setPath(
  message: pb.ProtocolMessage,
  options: { clientId?: string; clientName?: string | null; playerId?: string; playerName?: string | null } = {},
): pb.ProtocolMessage {
  const inner = pb.extractInner(message);
  const client = inner.playerPath.client;
  client.bundleIdentifier = options.clientId ?? CLIENT_ID_1;
  const clientName = "clientName" in options ? options.clientName : CLIENT_NAME_1;
  if (clientName) client.displayName = clientName;

  const player = inner.playerPath.player;
  player.identifier = options.playerId ?? PLAYER_ID_1;
  const playerName = "playerName" in options ? options.playerName : PLAYER_NAME_1;
  if (playerName) player.displayName = playerName;
  return message;
}

function addMetadataItem(
  msg: pb.ProtocolMessage,
  options: { location?: number; identifier?: string } = {},
  metadataFields: Record<string, unknown> = {},
): pb.ProtocolMessage {
  const queue = (pb.extractInner(msg) as pb.SetStateMessage).playbackQueue;
  queue.location = options.location ?? 0;
  const item = queue.contentItems.add();
  if (options.identifier) item.identifier = options.identifier;
  for (const [key, value] of Object.entries(metadataFields)) (item.metadata as any)[key] = value;
  return msg;
}

class StubListener {
  callCount = 0;
  async stateUpdated(): Promise<void> {
    this.callCount += 1;
  }
}

let protocolMock: MrpProtocolMock;
let psm: PlayerStateManager;
let listener: StubListener;

beforeEach(() => {
  protocolMock = new MrpProtocolMock();
  psm = new PlayerStateManager(protocolMock as unknown as MrpProtocol);
});

const useListener = () => {
  listener = new StubListener();
  psm.listener = listener;
  return listener;
};

const setNowPlayingClient = (bundleIdentifier: string) => {
  const msg = messages.create(pb.SET_NOW_PLAYING_CLIENT_MESSAGE);
  (pb.extractInner(msg) as pb.SetNowPlayingClientMessage).client.bundleIdentifier = bundleIdentifier;
  return msg;
};

test("get client and player", async () => {
  const msg = setPath(messages.create(pb.SET_STATE_MESSAGE));
  await protocolMock.inject(msg);
  const inner = pb.extractInner(msg);
  const player = psm.getPlayer(inner.playerPath);
  expect(player.identifier).toBe(PLAYER_ID_1);
  expect(player.displayName).toBe(PLAYER_NAME_1);
  const client = psm.getClient(inner.playerPath.client);
  expect(client.bundleIdentifier).toBe(CLIENT_ID_1);
  expect(client.displayName).toBe(CLIENT_NAME_1);
});

test("no metadata", async () => {
  const msg = setPath(messages.create(pb.SET_STATE_MESSAGE));
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).metadata).toBeNull();
});

test("metadata single item", async () => {
  const msg = addMetadataItem(setPath(messages.create(pb.SET_STATE_MESSAGE)), {}, { title: "item" });
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).metadata!.title).toBe("item");
});

test("metadata multiple items", async () => {
  let msg = addMetadataItem(setPath(messages.create(pb.SET_STATE_MESSAGE)), {}, { title: "item1" });
  msg = addMetadataItem(msg, { location: 1 }, { title: "item2" });
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).metadata!.title).toBe("item2");
});

test("metadata no item identifier", async () => {
  const msg = setPath(messages.create(pb.SET_STATE_MESSAGE));
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).itemIdentifier).toBeNull();
});

test("metadata item identifier", async () => {
  let msg = addMetadataItem(setPath(messages.create(pb.SET_STATE_MESSAGE)), { identifier: "id1" }, { title: "item1" });
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).itemIdentifier).toBe("id1");

  msg = addMetadataItem(msg, { location: 1, identifier: "id2" }, { title: "item2" });
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).itemIdentifier).toBe("id2");
});

test("get metadata field", async () => {
  const msg = addMetadataItem(setPath(messages.create(pb.SET_STATE_MESSAGE)), {}, { title: "item", playCount: 123 });
  await protocolMock.inject(msg);
  const player = psm.getPlayer(pb.extractInner(msg).playerPath);
  expect(player.metadataField("title")).toBe("item");
  expect(player.metadataField("playCount")).toBe(123);
});

test("content item update", async () => {
  let msg = addMetadataItem(setPath(messages.create(pb.SET_STATE_MESSAGE)), { identifier: "id" }, { title: "item", playCount: 123 });
  await protocolMock.inject(msg);

  msg = setPath(messages.create(pb.UPDATE_CONTENT_ITEM_MESSAGE));
  const item = (pb.extractInner(msg) as pb.UpdateContentItemMessage).contentItems.add();
  item.identifier = "id";
  item.metadata.title = "new title";
  item.metadata.playCount = 1111;
  await protocolMock.inject(msg);

  const player = psm.getPlayer(pb.extractInner(msg).playerPath);
  expect(player.metadataField("title")).toBe("new title");
  expect(player.metadataField("playCount")).toBe(1111);
});

test("get command info", async () => {
  const msg = setPath(messages.create(pb.SET_STATE_MESSAGE));
  const info = (pb.extractInner(msg) as pb.SetStateMessage).supportedCommands.supportedCommands.add();
  info.command = pb.Command.Pause;
  await protocolMock.inject(msg);
  const player = psm.getPlayer(pb.extractInner(msg).playerPath);
  expect(player.commandInfo(pb.Command.Play)).toBeNull();
  expect(player.commandInfo(pb.Command.Pause)).not.toBeNull();
});

test("playback state without rate", async () => {
  let msg = setPath(messages.create(pb.SET_STATE_MESSAGE));
  (pb.extractInner(msg) as pb.SetStateMessage).playbackState = pb.PlaybackState.Paused;
  msg = addMetadataItem(msg);
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).playbackState).toBe(pb.PlaybackState.Paused);

  (pb.extractInner(msg) as pb.SetStateMessage).playbackState = pb.PlaybackState.Playing;
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).playbackState).toBe(pb.PlaybackState.Playing);
});

test.each([
  [1.0, pb.PlaybackState.Playing],
  [2.0, pb.PlaybackState.Seeking],
  [0.0, pb.PlaybackState.Playing],
])("playback state playing with rate %p", async (rate, expected) => {
  const setState = setPath(messages.create(pb.SET_STATE_MESSAGE));
  (pb.extractInner(setState) as pb.SetStateMessage).playbackState = pb.PlaybackState.Playing;
  const msg = addMetadataItem(setState, {}, { playbackRate: rate });
  await protocolMock.inject(msg);
  expect(psm.getPlayer(pb.extractInner(msg).playerPath).playbackState).toBe(expected);
});

test("change listener", () => {
  const l = useListener();
  expect(psm.listener).toBe(l);
  psm.listener = null;
  expect(psm.listener).toBeNull();
});

test("set now playing client", async () => {
  const l = useListener();
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(1);
  expect(psm.client!.bundleIdentifier).toBe(CLIENT_ID_1);
});

test("set now playing player when no client", async () => {
  const l = useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  expect(l.callCount).toBe(0);
  expect(psm.playing.identifier).toBeFalsy();
  expect(psm.playing.displayName).toBeFalsy();
});

test("set now playing player for active client", async () => {
  const l = useListener();
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  expect(l.callCount).toBe(2);
  expect(psm.playing.identifier).toBe(PLAYER_ID_1);
  expect(psm.playing.displayName).toBe(PLAYER_NAME_1);
});

test("default player when only client set", async () => {
  useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE)));
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE), { playerId: DEFAULT_PLAYER, playerName: "Default Name" }));
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(psm.playing.identifier).toBe(DEFAULT_PLAYER);
  expect(psm.playing.displayName).toBe("Default Name");
});

test("set state calls active listener", async () => {
  const l = useListener();
  const setState = setPath(messages.create(pb.SET_STATE_MESSAGE));
  await protocolMock.inject(setState);
  expect(l.callCount).toBe(1);

  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(2);

  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  expect(l.callCount).toBe(3);

  await protocolMock.inject(setState);
  expect(l.callCount).toBe(4);
});

test("content item update calls active listener", async () => {
  const l = useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE)));
  expect(l.callCount).toBe(1);

  const updateItem = setPath(messages.create(pb.UPDATE_CONTENT_ITEM_MESSAGE));
  (pb.extractInner(updateItem) as pb.UpdateContentItemMessage).contentItems.add();
  await protocolMock.inject(updateItem);
  expect(l.callCount).toBe(2);

  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(3);

  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  expect(l.callCount).toBe(4);

  await protocolMock.inject(updateItem);
  expect(l.callCount).toBe(5);
});

test("update client", async () => {
  const l = useListener();
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(1);
  expect(psm.client!.displayName).toBeNull();

  const update = messages.create(pb.UPDATE_CLIENT_MESSAGE);
  const client = (pb.extractInner(update) as pb.UpdateClientMessage).client;
  client.bundleIdentifier = CLIENT_ID_1;
  client.displayName = CLIENT_NAME_1;
  await protocolMock.inject(update);

  expect(l.callCount).toBe(2);
  expect(psm.client!.displayName).toBe(CLIENT_NAME_1);
});

test("remove active client", async () => {
  const l = useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE)));
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(2);
  expect(psm.client!.bundleIdentifier).toBe(CLIENT_ID_1);

  const remove = messages.create(pb.REMOVE_CLIENT_MESSAGE);
  (pb.extractInner(remove) as pb.RemoveClientMessage).client.bundleIdentifier = CLIENT_ID_1;
  await protocolMock.inject(remove);

  expect(l.callCount).toBe(3);
  expect(psm.client).toBeNull();
});

test("remove not active client", async () => {
  const l = useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE)));
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(2);

  const remove = messages.create(pb.REMOVE_CLIENT_MESSAGE);
  (pb.extractInner(remove) as pb.RemoveClientMessage).client.bundleIdentifier = CLIENT_ID_2;
  await protocolMock.inject(remove);

  expect(l.callCount).toBe(2);
  expect(psm.client!.bundleIdentifier).toBe(CLIENT_ID_1);
});

test("remove active player", async () => {
  const l = useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE)));
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  expect(psm.playing.identifier).toBe(PLAYER_ID_1);

  await protocolMock.inject(setPath(messages.create(pb.REMOVE_PLAYER_MESSAGE)));
  expect(l.callCount).toBe(4);
  expect(psm.playing.isValid).toBe(false);
});

test("remove active player reverts to default", async () => {
  const l = useListener();
  await protocolMock.inject(setPath(messages.create(pb.SET_STATE_MESSAGE), { playerId: DEFAULT_PLAYER }));
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  expect(l.callCount).toBe(2);
  expect(psm.playing.identifier).toBe(PLAYER_ID_1);

  await protocolMock.inject(setPath(messages.create(pb.REMOVE_PLAYER_MESSAGE)));
  expect(l.callCount).toBe(3);
  expect(psm.playing.identifier).toBe(DEFAULT_PLAYER);
});

test("set default supported commands", async () => {
  const l = useListener();
  const msg = messages.create(pb.SET_DEFAULT_SUPPORTED_COMMANDS_MESSAGE);
  const inner = pb.extractInner(msg) as pb.SetDefaultSupportedCommandsMessage;
  inner.supportedCommands.supportedCommands.add().command = pb.Command.Play;
  inner.playerPath.client.bundleIdentifier = CLIENT_ID_1;
  await protocolMock.inject(msg);

  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));

  // Default commands are set on client, so any player belonging to that client should
  // have the supported command
  const playerPath = new pb.PlayerPath();
  playerPath.client.bundleIdentifier = CLIENT_ID_1;
  playerPath.player.identifier = PLAYER_ID_1;
  const player = psm.getPlayer(playerPath);

  expect(player.commandInfo(pb.Command.Play)).toBeTruthy();
  expect(l.callCount).toBe(2);
});

// --- Pause/resume without new timing (pyatv #1875, #1934) --------------------

const NOW = 1_700_000_000;
const COCOA_NOW = NOW - COCOA_EPOCH_OFFSET;

function setState(playbackState: number, metadata: Record<string, unknown> | null = null): pb.ProtocolMessage {
  const msg = setPath(messages.create(pb.SET_STATE_MESSAGE));
  (pb.extractInner(msg) as pb.SetStateMessage).playbackState = playbackState;
  if (metadata) addMetadataItem(msg, {}, metadata);
  return msg;
}

async function withNow<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const original = mrpHooks.now;
  mrpHooks.now = () => now;
  try {
    return await fn();
  } finally {
    mrpHooks.now = original;
  }
}

test("pause without timing freezes position", async () => {
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  await protocolMock.inject(
    setState(pb.PlaybackState.Playing, { elapsedTime: 10, elapsedTimeTimestamp: COCOA_NOW, playbackRate: 1 }),
  );
  await withNow(NOW + 30, () => protocolMock.inject(setState(pb.PlaybackState.Paused)));

  const metadata = psm.playing.metadata!;
  expect(metadata.elapsedTime).toBeCloseTo(40);
  expect(metadata.playbackRate).toBe(0);
  expect(metadata.elapsedTimeTimestamp).toBeCloseTo(COCOA_NOW + 30);
});

test("resume without timing continues from frozen position", async () => {
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  await protocolMock.inject(
    setState(pb.PlaybackState.Playing, { elapsedTime: 10, elapsedTimeTimestamp: COCOA_NOW, playbackRate: 1 }),
  );
  await withNow(NOW + 30, () => protocolMock.inject(setState(pb.PlaybackState.Paused)));
  await withNow(NOW + 150, () => protocolMock.inject(setState(pb.PlaybackState.Playing)));

  const metadata = psm.playing.metadata!;
  expect(metadata.elapsedTime).toBeCloseTo(40);
  expect(metadata.playbackRate).toBe(1);
  expect(metadata.elapsedTimeTimestamp).toBeCloseTo(COCOA_NOW + 150);
});

test("pause with new timing from device is not changed", async () => {
  await protocolMock.inject(setNowPlayingClient(CLIENT_ID_1));
  await protocolMock.inject(setPath(messages.create(pb.SET_NOW_PLAYING_PLAYER_MESSAGE)));
  await protocolMock.inject(
    setState(pb.PlaybackState.Playing, { elapsedTime: 10, elapsedTimeTimestamp: COCOA_NOW, playbackRate: 1 }),
  );
  await withNow(NOW + 30, () =>
    protocolMock.inject(
      setState(pb.PlaybackState.Paused, { elapsedTime: 38, elapsedTimeTimestamp: COCOA_NOW + 29, playbackRate: 0 }),
    ),
  );

  const metadata = psm.playing.metadata!;
  expect(metadata.elapsedTime).toBe(38);
  expect(metadata.elapsedTimeTimestamp).toBe(COCOA_NOW + 29);
});
