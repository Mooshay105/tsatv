/** Module responsible for keeping track of media player states. */

import { getLogger } from "../../support/logging.ts";
import * as pb from "./protobuf/index.ts";
import type { MrpProtocol } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.mrp.player_state");

export const DEFAULT_PLAYER_ID = "MediaRemote-DefaultPlayer";

// Seconds between 1970-01-01 and 2001-01-01 (cocoa reference date)
export const COCOA_EPOCH_OFFSET = 978307200;

/** Hooks used by MRP (replaceable in tests). */
export const mrpHooks = {
  /** Current time in seconds since epoch. */
  now: (): number => Date.now() / 1000,
};

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/** Represent what is currently playing on a device. */
export class PlayerState {
  private _playbackState: number | null = null;
  supportedCommands: pb.CommandInfo[] = [];
  items: pb.ContentItem[] = [];
  location = 0;
  identifier: string | null;
  displayName: string | null = null;

  constructor(
    public parent: Client | null,
    player: pb.NowPlayingPlayer,
  ) {
    this.identifier = player.identifier;
    this.update(player);
  }

  /** Return if player has a valid identifier. */
  get isValid(): boolean {
    return this.identifier !== null && this.identifier !== "";
  }

  /** Update player metadata. */
  update(player: pb.NowPlayingPlayer): void {
    this.displayName = player.displayName || this.displayName;
  }

  /** Playback state of device. */
  get playbackState(): number | null {
    // if playback state has not been received, assume player is not playing anything
    if (this._playbackState === null) return null;

    // If player is considered paused, no content is playing
    if (this._playbackState === pb.PlaybackState.Paused) {
      // ...unless something is in the queue...
      if (this.metadata !== null) return pb.PlaybackState.Paused;
      return null;
    }

    // All other states than playing (and paused) should pass through
    if (this._playbackState !== pb.PlaybackState.Playing) return this._playbackState;

    const playbackRate = this.metadataField("playbackRate") as number | null;
    if (playbackRate === null) return this._playbackState;

    if (isClose(playbackRate, 0.0)) {
      if (this._playbackState === pb.PlaybackState.Playing) return pb.PlaybackState.Playing;
      return pb.PlaybackState.Paused;
    }
    if (isClose(playbackRate, 1.0)) return pb.PlaybackState.Playing;
    return pb.PlaybackState.Seeking;
  }

  /** Metadata of currently playing item. */
  get metadata(): pb.ContentItemMetadata | null {
    if (this.items.length >= this.location + 1) return this.items[this.location]!.metadata;
    return null;
  }

  /** Return identifier of current item in queue. */
  get itemIdentifier(): string | null {
    if (this.items.length >= this.location + 1) return this.items[this.location]!.identifier;
    return null;
  }

  /** Return a specific metadata field or null if missing. */
  metadataField(field: string): any {
    const metadata = this.metadata;
    if (metadata && metadata.hasField(field)) return (metadata as any)[field];
    return null;
  }

  /** Return supported command info. */
  commandInfo(command: number): pb.CommandInfo | null {
    for (const cmd of [...this.supportedCommands, ...(this.parent?.supportedCommands ?? [])]) {
      if (cmd.command === command) return cmd;
    }
    return null;
  }

  // Rate saved when position was frozen on pause (see _compensateForStaleTiming)
  private _frozenPlaybackRate: number | null = null;

  private _timing(): [unknown, unknown, unknown] {
    return [this.metadataField("elapsedTime"), this.metadataField("elapsedTimeTimestamp"), this.metadataField("playbackRate")];
  }

  /**
   * Keep position correct when playback state changes without updated timing.
   *
   * Some apps change between playing and paused without sending a new elapsed time.
   * Position would then jump back to the old elapsed time when pausing and forward by
   * the paused duration when resuming. Freeze the position when pausing and restart
   * the clock when resuming.
   */
  private _compensateForStaleTiming(previousState: number | null, timingBefore: [unknown, unknown, unknown]): void {
    const state = this._playbackState;
    const metadata = this.metadata;
    if (previousState === state || metadata === null) return;

    const timingAfter = this._timing();
    if (!timingAfter.every((value, i) => value === timingBefore[i])) {
      // Device sent new timing, trust it
      this._frozenPlaybackRate = null;
      return;
    }

    const [elapsedTime, timestamp, rate] = timingAfter as [number | null, number | null, number | null];
    if (!timestamp) return;

    if (previousState === pb.PlaybackState.Playing && state === pb.PlaybackState.Paused) {
      if (!rate) return; // Position is not extrapolated anyway
      const now = mrpHooks.now() - COCOA_EPOCH_OFFSET;
      metadata.elapsedTime = (elapsedTime ?? 0) + (now - timestamp) * rate;
      metadata.elapsedTimeTimestamp = now;
      metadata.playbackRate = 0;
      this._frozenPlaybackRate = rate;
      LOGGER.debug("Paused without new timing, freezing position at %f", metadata.elapsedTime);
    } else if (previousState === pb.PlaybackState.Paused && state === pb.PlaybackState.Playing) {
      if (this._frozenPlaybackRate === null) return;
      metadata.elapsedTimeTimestamp = mrpHooks.now() - COCOA_EPOCH_OFFSET;
      metadata.playbackRate = this._frozenPlaybackRate;
      this._frozenPlaybackRate = null;
      LOGGER.debug("Resumed without new timing, continuing from %f", elapsedTime);
    }
  }

  /** Update current state with new data from SetStateMessage. */
  handleSetState(setstate: pb.SetStateMessage): void {
    const previousState = this._playbackState;
    const timingBefore = this._timing();
    this._applySetState(setstate);
    this._compensateForStaleTiming(previousState, timingBefore);
  }

  private _applySetState(setstate: pb.SetStateMessage): void {
    if (setstate.hasField("playbackState")) this._playbackState = setstate.playbackState;

    if (setstate.hasField("supportedCommands")) {
      this.supportedCommands = [...setstate.supportedCommands.supportedCommands];
    }

    if (setstate.hasField("playbackQueue")) {
      const queue = setstate.playbackQueue;
      this.items = [...queue.contentItems];
      this.location = queue.location;
    }
  }

  /** Update current state with new data from ContentItemUpdate. */
  handleContentItemUpdate(itemUpdate: pb.UpdateContentItemMessage): void {
    for (const updatedItem of itemUpdate.contentItems) {
      for (const existing of this.items) {
        if (updatedItem.identifier === existing.identifier) {
          // Other parts of the ContentItem should be merged as well, but those are
          // not used right now so will do that when needed.
          //
          // NB: mergeFrom will append repeated fields (which is likely not what is
          // expected)!
          existing.metadata.mergeFrom(updatedItem.metadata);
        }
      }
    }
  }

  /** Compare if instance is equal to other instance. */
  equals(other: PlayerState | null | undefined): boolean {
    return Boolean(other) && this.identifier === other!.identifier;
  }
}

/** Represent an MRP media player client. */
export class Client {
  readonly bundleIdentifier: string;
  displayName: string | null = null;
  private _activePlayer: PlayerState | null = null;
  readonly players = new Map<string, PlayerState>();
  supportedCommands: pb.CommandInfo[] = [];

  constructor(client: pb.NowPlayingClient) {
    this.bundleIdentifier = client.bundleIdentifier;
    this.update(client);
  }

  /** Return currently active player. */
  get activePlayer(): PlayerState {
    if (this._activePlayer === null) {
      const defaultPlayer = this.players.get(DEFAULT_PLAYER_ID);
      if (defaultPlayer) return defaultPlayer;
      return new PlayerState(this, new pb.NowPlayingPlayer());
    }
    return this._activePlayer;
  }

  /** Change active player for client. */
  set activePlayer(other: PlayerState | null) {
    this._activePlayer = other;
  }

  /** Get state for a player. */
  getPlayer(player: pb.NowPlayingPlayer): PlayerState {
    let state = this.players.get(player.identifier);
    if (!state) {
      state = new PlayerState(this, player);
      this.players.set(player.identifier, state);
    }
    return state;
  }

  /** Update default supported commands for client. */
  handleSetDefaultSupportedCommands(supportedCommands: pb.SetDefaultSupportedCommandsMessage): void {
    this.supportedCommands = [...supportedCommands.supportedCommands.supportedCommands];
  }

  /** Handle change of now playing player. */
  handleSetNowPlayingPlayer(player: pb.NowPlayingPlayer): void {
    this.activePlayer = this.getPlayer(player);

    if (this.activePlayer.isValid) {
      LOGGER.debug("Active player is now %s (%s)", this.activePlayer.identifier, this.activePlayer.displayName);
    } else {
      LOGGER.debug("Active player no longer set");
    }
  }

  /** Update client metadata. */
  update(client: pb.NowPlayingClient): void {
    this.displayName = client.displayName || this.displayName;
  }
}

/** Listener notified when state of active player changes. */
export interface PlayerStateListener {
  stateUpdated(): Promise<void> | void;
}

/** Manage state of all media players. */
export class PlayerStateManager {
  volumeControlsAvailable: boolean | null = null;
  private _activeClient: Client | null = null;
  private readonly _clients = new Map<string, Client>();
  private _listener: WeakRef<PlayerStateListener> | null = null;

  constructor(readonly protocol: MrpProtocol) {
    this._addListeners();
  }

  private _addListeners(): void {
    const listeners: Array<[number, (message: pb.ProtocolMessage) => Promise<void>]> = [
      [pb.SET_STATE_MESSAGE, (m) => this._handleSetState(m)],
      [pb.UPDATE_CONTENT_ITEM_MESSAGE, (m) => this._handleContentItemUpdate(m)],
      [pb.SET_NOW_PLAYING_CLIENT_MESSAGE, (m) => this._handleSetNowPlayingClient(m)],
      [pb.SET_NOW_PLAYING_PLAYER_MESSAGE, (m) => this._handleSetNowPlayingPlayer(m)],
      [pb.UPDATE_CLIENT_MESSAGE, (m) => this._handleUpdateClient(m)],
      [pb.REMOVE_CLIENT_MESSAGE, (m) => this._handleRemoveClient(m)],
      [pb.REMOVE_PLAYER_MESSAGE, (m) => this._handleRemovePlayer(m)],
      [pb.SET_DEFAULT_SUPPORTED_COMMANDS_MESSAGE, (m) => this._handleSetDefaultSupportedCommands(m)],
    ];
    for (const [message, handler] of listeners) this.protocol.listenTo(message, handler);
  }

  /** Return client based on player path. */
  getClient(client: pb.NowPlayingClient): Client {
    const bundle = client.bundleIdentifier;
    let state = this._clients.get(bundle);
    if (!state) {
      state = new Client(client);
      this._clients.set(bundle, state);
    }
    return state;
  }

  /** Return player based on a player path. */
  getPlayer(playerPath: pb.PlayerPath): PlayerState {
    return this.getClient(playerPath.client).getPlayer(playerPath.player);
  }

  /** Return current listener. */
  get listener(): PlayerStateListener | null {
    return this._listener?.deref() ?? null;
  }

  /** Change current listener. */
  set listener(newListener: PlayerStateListener | null) {
    this._listener = newListener ? new WeakRef(newListener) : null;
  }

  /** Return currently active client. */
  get client(): Client | null {
    return this._activeClient;
  }

  /** Player state for active media player. */
  get playing(): PlayerState {
    if (this._activeClient) return this._activeClient.activePlayer;
    return new PlayerState(new Client(new pb.NowPlayingClient()), new pb.NowPlayingPlayer());
  }

  private async _handleSetState(message: pb.ProtocolMessage): Promise<void> {
    const setstate = pb.extractInner(message) as pb.SetStateMessage;
    const player = this.getPlayer(setstate.playerPath);
    player.handleSetState(setstate);
    await this._stateUpdated({ player });
  }

  private async _handleContentItemUpdate(message: pb.ProtocolMessage): Promise<void> {
    const itemUpdate = pb.extractInner(message) as pb.UpdateContentItemMessage;
    const player = this.getPlayer(itemUpdate.playerPath);
    player.handleContentItemUpdate(itemUpdate);
    await this._stateUpdated({ player });
  }

  private async _handleSetNowPlayingClient(message: pb.ProtocolMessage): Promise<void> {
    this._activeClient = this.getClient((pb.extractInner(message) as pb.SetNowPlayingClientMessage).client);
    LOGGER.debug("Active client is now %s", this._activeClient.bundleIdentifier);
    await this._stateUpdated();
  }

  private async _handleSetNowPlayingPlayer(message: pb.ProtocolMessage): Promise<void> {
    const setNowPlaying = pb.extractInner(message) as pb.SetNowPlayingPlayerMessage;
    const client = this.getClient(setNowPlaying.playerPath.client);
    client.handleSetNowPlayingPlayer(setNowPlaying.playerPath.player);
    await this._stateUpdated({ client });
  }

  private async _handleRemoveClient(message: pb.ProtocolMessage): Promise<void> {
    const clientToRemove = (pb.extractInner(message) as pb.RemoveClientMessage).client;
    const client = this._clients.get(clientToRemove.bundleIdentifier);
    if (client) {
      this._clients.delete(clientToRemove.bundleIdentifier);
      if (client === this._activeClient) {
        this._activeClient = null;
        await this._stateUpdated();
      }
    }
  }

  private async _handleRemovePlayer(message: pb.ProtocolMessage): Promise<void> {
    const playerToRemove = (pb.extractInner(message) as pb.RemovePlayerMessage).playerPath;
    const player = this.getPlayer(playerToRemove);
    if (player.isValid) {
      const client = this.getClient(playerToRemove.client);
      client.players.delete(player.identifier!);
      player.parent = null;

      if (player.equals(client.activePlayer)) {
        client.activePlayer = null;
        await this._stateUpdated({ client });
      }
    }
  }

  private async _handleSetDefaultSupportedCommands(message: pb.ProtocolMessage): Promise<void> {
    const supportedCommands = pb.extractInner(message) as pb.SetDefaultSupportedCommandsMessage;
    const client = this.getClient(supportedCommands.playerPath.client);
    client.handleSetDefaultSupportedCommands(supportedCommands);
    await this._stateUpdated();
  }

  private async _handleUpdateClient(message: pb.ProtocolMessage): Promise<void> {
    const updateClient = pb.extractInner(message) as pb.UpdateClientMessage;
    const client = this.getClient(updateClient.client);
    client.update(updateClient.client);
    await this._stateUpdated({ client });
  }

  private async _stateUpdated(options: { client?: Client; player?: PlayerState } = {}): Promise<void> {
    const client = options.client ?? null;
    const player = options.player ?? null;
    const isActiveClient = client === this.client;
    const isActivePlayer = player !== null ? player.equals(this.playing) : this.playing === null;
    const isAlways = client === null && player === null;

    if (isActiveClient || isActivePlayer || isAlways) {
      const listener = this.listener;
      if (listener) await listener.stateUpdated();
    }
  }
}
