/** Fake DMAP Apple TV device for tests. */

import { InputAction, Protocol, RepeatState, ShuffleState } from "../../src/const.ts";
import * as parser from "../../src/protocols/dmap/parser.ts";
import { lookupTag } from "../../src/protocols/dmap/tag_definitions.ts";
import * as tags from "../../src/protocols/dmap/tags.ts";
import { getLogger } from "../../src/support/logging.ts";
import type { ZeroconfStub } from "../zeroconf_stub.ts";
import { simpleGet } from "../utils.ts";
import { registerFake } from "./index.ts";
import { type FakeRequest, type FakeResponse, WebApp } from "./web.ts";

const LOGGER = getLogger("tests.fake_device.dmap");

export const EXPECTED_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip",
  "Client-DAAP-Version": "3.13",
  "Client-ATV-Sharing-Version": "1.2",
  "Client-iTunes-Sharing-Version": "3.15",
  "User-Agent": "Remote/1021",
  "Viewer-Only-Client": "1",
};

export interface LoginResponse {
  session: number;
  status: number;
}

export const DEVICE_IDENTIFIER = "75FBEEC773CFC563";
export const DEVICE_AUTH_KEY = "8F06696F2542D70DF59286C761695C485F815BE3D152849E1361282D46AB1493";
export const DEVICE_PIN = 2271;
export const DEVICE_CREDENTIALS = DEVICE_IDENTIFIER + ":" + DEVICE_AUTH_KEY;

export interface PlayingOptions {
  revision?: number;
  paused?: boolean | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  totalTime?: number | null;
  position?: number | null;
  mediakind?: number | null;
  playstatus?: number | null;
  repeat?: RepeatState | null;
  playbackRate?: number | null;
  shuffle?: ShuffleState | null;
  forceClose?: boolean;
  artwork?: Buffer | null;
  artworkStatus?: number | null;
}

/** Response returned by command playstatusupdate. */
export class PlayingResponse {
  paused: boolean | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  totalTime: number | null;
  position: number | null;
  mediakind: number | null;
  playstatus: number | null;
  repeat: RepeatState | null;
  playbackRate: number | null;
  revision: number;
  shuffle: ShuffleState | null;
  forceClose: boolean;
  artwork: Buffer | null;
  artworkStatus: number | null;

  constructor(options: PlayingOptions = {}) {
    this.paused = options.paused ?? null;
    this.title = options.title ?? null;
    this.artist = options.artist ?? null;
    this.album = options.album ?? null;
    this.genre = options.genre ?? null;
    this.totalTime = options.totalTime ?? null;
    this.position = options.position ?? null;
    this.mediakind = options.mediakind ?? null;
    this.playstatus = options.playstatus ?? null;
    this.repeat = options.repeat ?? null;
    this.playbackRate = options.playbackRate ?? null;
    this.revision = options.revision ?? 0;
    this.shuffle = options.shuffle ?? null;
    this.forceClose = options.forceClose ?? false;
    this.artwork = options.artwork ?? null;
    this.artworkStatus = options.artworkStatus ?? null;
  }
}

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export class FakeDmapState {
  device: unknown = null;
  loginResponse: LoginResponse;
  playing = new PlayingResponse();
  pairingResponses = new Map<string, string | number>(); // Remote name -> expected code
  session: number | null = null;
  volumeControls: boolean | null = false;
  lastButtonPressed: string | null = null;
  lastButtonAction: InputAction | null = null;
  buttonsPressCount = 0;
  lastArtworkWidth: number | null = null;
  lastArtworkHeight: number | null = null;

  constructor(
    readonly hsgid: string,
    readonly pairingGuid: string,
    readonly sessionId: number,
  ) {
    this.loginResponse = { session: sessionId, status: 200 };
  }

  /** Act upon available Bonjour services. */
  async triggerBonjour(stubbedZeroconf: ZeroconfStub): Promise<void> {
    // Add more services here when needed
    for (const service of stubbedZeroconf.registeredServices) {
      if (service.type !== "_touch-remote._tcp.local") continue;

      // Look for the response matching this remote (pyatv picks the first one)
      for (const [remoteName, expectedCode] of this.pairingResponses) {
        return this.performPairing(remoteName, expectedCode, service.port);
      }
    }
  }

  /**
   * Pair with a remote client.
   *
   * This will perform a GET-request to the specified port and hand over information to
   * the client (pyatv) so that the pairing process can be completed.
   */
  async performPairing(remoteName: string, expectedCode: string | number, port: number): Promise<void> {
    const url = `http://127.0.0.1:${port}/pair?pairingcode=${expectedCode}&servicename=test`;
    const [data] = await simpleGet(url);

    // Verify content returned in pairingresponse
    const parsed = parser.parse(data!, lookupTag);
    assert(parser.first(parsed, "cmpa", "cmpg") === 1);
    assert(parser.first(parsed, "cmpa", "cmnm") === remoteName);
    assert(parser.first(parsed, "cmpa", "cmty") === "iPhone");
  }
}

/** Implementation of a fake DMAP Apple TV. */
export class FakeDmapService {
  private ownApp = false;

  constructor(
    readonly state: FakeDmapState,
    readonly app: WebApp,
  ) {
    app.addGet("/login", (r) => this.handleLogin(r));
    app.addGet("/ctrl-int/1/playstatusupdate", (r) => this.handlePlaystatus(r));
    app.addPost("/ctrl-int/1/controlpromptentry", (r) => this.handleRemoteButton(r));
    app.addGet("/ctrl-int/1/nowplayingartwork", (r) => this.handleArtwork(r));
    app.addPost("/ctrl-int/1/setproperty", (r) => this.handleSetProperty(r));
    for (const button of ["play", "playpause", "pause", "stop", "nextitem", "previtem", "volumedown", "volumeup"]) {
      app.addPost("/ctrl-int/1/" + button, (r) => this.handlePlaybackButton(r));
    }
  }

  get port(): number {
    return this.app.port;
  }

  async start(startWebServer: boolean): Promise<void> {
    if (startWebServer) {
      this.ownApp = true;
      await this.app.start(0, "0.0.0.0");
    }
  }

  async cleanup(): Promise<void> {
    if (this.ownApp) await this.app.stop();
  }

  /** Handle login requests. */
  handleLogin(request: FakeRequest): FakeResponse {
    this.verifyHeaders(request);
    this.verifyAuthParameters(request, true, false);

    const mlid = tags.uint32Tag("mlid", this.state.loginResponse.session);
    const mlog = tags.containerTag("mlog", mlid);
    this.state.session = this.state.loginResponse.session;
    return { body: mlog, status: this.state.loginResponse.status };
  }

  /** Handle playback buttons. */
  handlePlaybackButton(request: FakeRequest): FakeResponse {
    this.verifyAuthParameters(request);
    this.state.lastButtonPressed = request.path.split("/").pop()!;
    this.state.lastButtonAction = null;
    this.state.buttonsPressCount += 1;
    return { status: 200 };
  }

  /** Handle remote control buttons. */
  handleRemoteButton(request: FakeRequest): FakeResponse {
    this.verifyAuthParameters(request);
    const parsed = parser.parse(request.body, lookupTag);
    this.state.lastButtonPressed = this.convertButton(parsed);
    this.state.lastButtonAction = InputAction.SingleTap;
    this.state.buttonsPressCount += 1;
    return { status: 200 };
  }

  private convertButton(data: parser.DmapData): string {
    const value = parser.first(data, "cmbe");

    // Consider navigation buttons if six commands have been received
    if (this.state.buttonsPressCount === 6) {
      if (value === "touchUp&time=6&point=20,250") return "up";
      if (value === "touchUp&time=6&point=20,275") return "down";
      if (value === "touchUp&time=7&point=50,100") return "left";
      if (value === "touchUp&time=7&point=75,100") return "right";
    }
    return value;
  }

  /** Handle artwork requests. */
  handleArtwork(request: FakeRequest): FakeResponse {
    this.verifyAuthParameters(request);
    if (request.query.has("mh")) this.state.lastArtworkHeight = parseInt(request.query.get("mh")!, 10);
    if (request.query.has("mw")) this.state.lastArtworkWidth = parseInt(request.query.get("mw")!, 10);
    return { body: this.state.playing.artwork, status: this.state.playing.artworkStatus ?? 200 };
  }

  /** Handle playstatus (currently playing) requests. */
  handlePlaystatus(request: FakeRequest): FakeResponse | null {
    this.verifyAuthParameters(request);

    const body: Buffer[] = [];
    const playing = this.state.playing;

    // Check if connection should be closed to trigger error on client side
    if (playing.forceClose) {
      request.socket.destroy();
      return null;
    }

    // Make sure revision matches
    const revision = parseInt(request.query.get("revision-number")!, 10);
    if (playing.revision !== revision) {
      // Not a valid response as a real device, just to make tests fail
      return { status: 500 };
    }

    if (playing.playbackRate !== null) {
      // TODO : Magic constants
      let playstatus: number;
      if (isClose(playing.playbackRate, 0.0)) playstatus = 3;
      else if (isClose(playing.playbackRate, 1.0)) playstatus = 4;
      else if (playing.playbackRate > 0.0) playstatus = 6;
      else playstatus = 5;
      body.push(tags.uint32Tag("caps", playstatus));
    } else if (playing.paused !== null) {
      body.push(tags.uint32Tag("caps", playing.paused ? 3 : 4));
    } else if (playing.playstatus !== null) {
      body.push(tags.uint32Tag("caps", playing.playstatus));
    }

    if (playing.title !== null) body.push(tags.stringTag("cann", playing.title));
    if (playing.artist !== null) body.push(tags.stringTag("cana", playing.artist));
    if (playing.album !== null) body.push(tags.stringTag("canl", playing.album));
    if (playing.genre !== null) body.push(tags.stringTag("cang", playing.genre));

    if (playing.totalTime !== null) {
      body.push(tags.uint32Tag("cast", playing.totalTime * 1000)); // sec -> ms
      if (playing.position !== null) {
        const pos = playing.totalTime - playing.position;
        body.push(tags.uint32Tag("cant", pos * 1000)); // sec -> ms
      }
    }

    if (playing.mediakind !== null) body.push(tags.uint32Tag("cmmk", playing.mediakind));
    if (playing.repeat !== null) body.push(tags.uint8Tag("carp", playing.repeat));
    if (playing.shuffle !== null) body.push(tags.uint8Tag("cash", playing.shuffle));
    if (this.state.volumeControls !== null) body.push(tags.uint8Tag("cavc", this.state.volumeControls));
    body.push(tags.uint32Tag("cmsr", playing.revision + 1));

    return { body: tags.containerTag("cmst", Buffer.concat(body)), status: 200 };
  }

  /** Handle property changes. */
  handleSetProperty(request: FakeRequest): FakeResponse {
    this.verifyAuthParameters(request);
    const query = request.query;
    if (query.has("dacp.playingtime")) {
      const playtime = parseInt(query.get("dacp.playingtime")!, 10);
      this.state.playing.position = Math.trunc(playtime / 1000);
    } else if (query.has("dacp.shufflestate")) {
      const shuffle = parseInt(query.get("dacp.shufflestate")!, 10);
      this.state.playing.shuffle = shuffle === 1 ? ShuffleState.Songs : ShuffleState.Off;
    } else if (query.has("dacp.repeatstate")) {
      this.state.playing.repeat = parseInt(query.get("dacp.repeatstate")!, 10) as RepeatState;
    }
    return { body: Buffer.alloc(0), status: 200 };
  }

  // Verifies that all needed headers are included in the request. Should be checked
  // in all requests, but that seems a bit too much and not that necessary.
  private verifyHeaders(request: FakeRequest): void {
    for (const [header, value] of Object.entries(EXPECTED_HEADERS)) {
      const actual = request.headers[header.toLowerCase()];
      assert(actual === value, `header ${header} mismatch: ${actual} != ${value}`);
    }
  }

  // This method makes sure that the correct login id and/or session id is included in
  // the GET-parameters. As this is extremely important for anything to work, this
  // should be verified in all requests.
  private verifyAuthParameters(request: FakeRequest, checkLoginId = false, checkSession = true): void {
    const params = request.query;

    // Either hsgid or pairing-guid should be present
    if (checkLoginId) {
      if (params.has("hsgid")) assert(params.get("hsgid") === this.state.hsgid, "hsgid does not match");
      else if (params.has("pairing-guid")) assert(params.get("pairing-guid") === this.state.pairingGuid, "pairing-guid does not match");
      else assert(false, "hsgid or pairing-guid not found");
    }

    if (checkSession) {
      assert(parseInt(params.get("session-id") ?? "", 10) === this.state.session, "session id does not match");
    }
  }
}

/**
 * Wrapper for altering behavior of a FakeAppleTV instance.
 *
 * Extend and use this class to alter behavior of a fake Apple TV device.
 */
export class FakeDmapUseCases {
  constructor(readonly state: FakeDmapState) {}

  /** Change volume control availability. */
  changeVolumeControl(available: boolean): void {
    this.state.volumeControls = available;
  }

  /** Call this method to change current session id. */
  forceRelogin(session: number): void {
    this.state.loginResponse = { session, status: 200 };
  }

  /** Call this method to make login fail with response 503. */
  makeLoginFail(): void {
    this.state.loginResponse = { session: 0, status: 503 };
  }

  /** Call this method to change artwork response. */
  changeArtwork(artwork: Buffer, _mimetype: string, _identifier?: string | null, _width?: number | null, _height?: number | null): void {
    this.state.playing.artwork = artwork;
    this.state.playing.artworkStatus = 200;
  }

  /**
   * Make artwork fail with no permission.
   *
   * This corresponds to have been logged out for some reason.
   */
  artworkNoPermission(): void {
    this.state.playing.artwork = null;
    this.state.playing.artworkStatus = 403;
  }

  /** Call this method to put device in idle state. */
  nothingPlaying(): void {
    this.state.playing = new PlayingResponse();
  }

  /** Call this method to force server to close connection on request. */
  serverClosesConnection(): void {
    this.state.playing = new PlayingResponse({ forceClose: true });
  }

  /** Play some example video. */
  exampleVideo(options: PlayingOptions = {}): void {
    this.videoPlaying({ title: "dummy", paused: true, ...options, totalTime: 123, position: 3 });
  }

  /** Call this method to change what is currently playing to video. */
  videoPlaying(options: PlayingOptions): void {
    this.state.playing = new PlayingResponse({
      revision: options.revision ?? 0,
      paused: options.paused,
      title: options.title,
      totalTime: options.totalTime,
      position: options.position,
      mediakind: 3,
      shuffle: options.shuffle ?? null,
      repeat: options.repeat ?? null,
      playbackRate: options.playbackRate ?? null,
    });
  }

  /** Play some example music. */
  exampleMusic(options: PlayingOptions = {}): void {
    this.musicPlaying({
      paused: true,
      title: "music",
      artist: "artist",
      album: "album",
      totalTime: 49,
      position: 22,
      genre: "genre",
      ...options,
    });
  }

  /** Call this method to change what is currently playing to music. */
  musicPlaying(options: PlayingOptions): void {
    this.state.playing = new PlayingResponse({ ...options, mediakind: 2 });
  }

  /** Call this method to put device in a loading state. */
  mediaIsLoading(): void {
    this.state.playing = new PlayingResponse({ playstatus: 1 });
  }

  /** Response when a pairing request is made. */
  pairingResponse(remoteName: string, expectedPairingCode: string | number): void {
    this.state.pairingResponses.set(remoteName, expectedPairingCode);
  }

  /**
   * Act on available Bonjour services.
   *
   * This will make the device look at published services and perform actions base on
   * these. Most important for the pairing process.
   */
  async actOnBonjourServices(stubbedZeroconf: ZeroconfStub): Promise<void> {
    await this.state.triggerBonjour(stubbedZeroconf);
  }
}

registerFake(
  Protocol.DMAP,
  (state, app) => new FakeDmapService(state, app),
  (options) => new FakeDmapState(options.hsgid, options.pairingGuid, options.sessionId),
  (state) => new FakeDmapUseCases(state),
);

void LOGGER;
