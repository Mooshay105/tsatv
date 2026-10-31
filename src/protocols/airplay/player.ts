/** Play media on a device by sending an URL. */

import { AuthenticationError, ConnectionLostError, PlaybackError } from "../../exceptions.ts";
import { sleep } from "../../support/asyncio.ts";
import { decodeBplistFromBody } from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import type { RtspSession } from "../../support/rtsp.ts";
import { createDatagramEndpoint } from "../../support/transport.ts";
import { type StreamProtocol, TimingServer } from "../raop/protocols/index.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.player");

export const PLAY_RETRIES = 3;
export const WAIT_RETRIES = 5;

/** Run a function with a timing server set up. */
async function withTimingServer<T>(rtsp: RtspSession, fn: (server: TimingServer) => Promise<T>): Promise<T> {
  const [, server] = await createDatagramEndpoint(() => new TimingServer(), {
    localAddr: [rtsp.connection.localIp, 0],
  });
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

/** This class helps with playing media from an URL. */
export class AirPlayPlayer {
  constructor(
    readonly rtsp: RtspSession,
    readonly streamProtocol: StreamProtocol,
  ) {}

  /** Play media from an URL on the device. */
  async playUrl(url: string, position = 0): Promise<void> {
    let retry = 0;
    await withTimingServer(this.rtsp, async (server) => {
      while (retry < PLAY_RETRIES) {
        LOGGER.debug("Starting to play %s", url);

        const resp = await this.streamProtocol.playUrl(server.port, url, position);

        // Sometimes AirPlay fails with "Internal Server Error", we apply a "lets try
        // again"-approach to that
        if (resp.code === 500) {
          retry += 1;
          LOGGER.debug("Failed to stream %s, retry %d of %d", url, retry, PLAY_RETRIES);
          await sleep(1.0);
          continue;
        }

        // TODO: Should be more fine-grained
        if (resp.code >= 400 && resp.code < 600) throw new AuthenticationError(`status code: ${resp.code}`);

        await this._waitForMediaToEnd();
        return;
      }
      throw new PlaybackError("Max retries exceeded");
    });
  }

  // Poll playback-info to find out if something is playing. It might take some time
  // until the media starts playing, give it 5 seconds (attempts)
  private async _waitForMediaToEnd(): Promise<void> {
    let attempts = WAIT_RETRIES;
    let videoStarted = false;

    for (;;) {
      // In some cases this call will fail if video was stopped by the sender, e.g.
      // stopping video via remote control. Handle this gracefully.
      let resp;
      try {
        resp = await this.rtsp.connection.get("/playback-info");
      } catch (ex) {
        if (ex instanceof ConnectionLostError || (ex instanceof Error && ex.message.includes("not connected"))) {
          LOGGER.debug("Connection was lost, assuming video playback stopped");
          break;
        }
        throw ex;
      }

      LOGGER.debug("Playback-info: %s", resp);

      let parsed: Record<string, any> = {};
      if (resp.body && resp.body.length !== 0) {
        parsed = decodeBplistFromBody(resp);
      } else {
        LOGGER.debug("Got playback-info response without content");
      }

      // In case we got an error, abort with that here
      if ("error" in parsed) {
        const code = parsed.error?.code ?? "unknown";
        const domain = parsed.error?.domain ?? "unknown domain";
        throw new PlaybackError(`got error ${code} (${domain}) when playing video`);
      }

      // duration is only available if something is playing
      if ("duration" in parsed) {
        videoStarted = true;
        attempts = -1;
      } else {
        videoStarted = false;
        if (attempts >= 0) attempts -= 1;
      }

      if (!videoStarted && attempts < 0) {
        LOGGER.debug("media playback ended");
        break;
      }

      await sleep(1);
    }
  }
}
