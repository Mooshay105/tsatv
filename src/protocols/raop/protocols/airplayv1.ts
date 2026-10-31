/** Implementation of AirPlay v1 protocol logic. */

import { ProtocolError } from "../../../exceptions.ts";
import { CancelledError, createTask, sleep, type Task } from "../../../support/asyncio.ts";
import type { HttpResponse } from "../../../support/http.ts";
import { getLogger } from "../../../support/logging.ts";
import * as plistlib from "../../../support/plistlib.ts";
import type { RtspSession } from "../../../support/rtsp.ts";
import type { DatagramTransport } from "../../../support/transport.ts";
import { uuid4 } from "../../../support/uuid.ts";
import { pairVerify } from "../../airplay/auth/index.ts";
import type { StreamContext, StreamProtocol } from "./index.ts";

const LOGGER = getLogger("pyatv.protocols.raop.protocols.airplayv1");

export const KEEP_ALIVE_INTERVAL = 25; // Seconds

const HEADERS = {
  "User-Agent": "MediaControl/1.0",
  "Content-Type": "application/x-apple-binary-plist",
};

/** Parse Transport header in SETUP response. */
export function parseTransport(transport: string): [string[], Record<string, string>] {
  const params: string[] = [];
  const options: Record<string, string> = {};
  for (const option of transport.split(";")) {
    const idx = option.indexOf("=");
    if (idx !== -1) options[option.slice(0, idx)] = option.slice(idx + 1);
    else params.push(option);
  }
  return [params, options];
}

/** Stream protocol used for AirPlay v1 support. */
export class AirPlayV1 implements StreamProtocol {
  private _keepAliveTask: Task<void> | null = null;

  constructor(
    readonly context: StreamContext,
    readonly rtsp: RtspSession,
  ) {}

  async setup(timingServerPort: number, controlClientPort: number): Promise<void> {
    const verifier = pairVerify(this.context.credentials, this.rtsp.connection);
    await verifier.verifyCredentials();

    await this.rtsp.announce(this.context.bytesPerChannel, this.context.channels, this.context.sampleRate, this.context.password);

    const resp = await this.rtsp.setup({
      headers: {
        Transport:
          "RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;" +
          `control_port=${controlClientPort};` +
          `timing_port=${timingServerPort}`,
      },
    });
    const [, options] = parseTransport(resp.headers.get("Transport") ?? "");
    this.context.timingPort = parseInt(options.timing_port ?? "0", 10);
    this.context.controlPort = parseInt(options.control_port!, 10);
    this.context.rtspSession = parseInt(resp.headers.get("Session")!, 10);
    this.context.serverPort = parseInt(options.server_port!, 10);

    LOGGER.debug(
      "Remote ports: control=%d, timing=%d, server=%d",
      this.context.controlPort,
      this.context.timingPort,
      this.context.serverPort,
    );
  }

  teardown(): void {
    this._keepAliveTask?.cancel();
    this._keepAliveTask = null;
  }

  async startFeedback(): Promise<void> {
    const feedback = await this.rtsp.feedback(true);
    if (feedback.code === 200) {
      this._keepAliveTask = createTask((signal) => this._sendKeepAlive(signal));
      this._keepAliveTask.promise.catch(() => undefined);
    } else {
      LOGGER.debug("Keep-alive not supported, not starting task");
    }
  }

  private async _sendKeepAlive(signal: AbortSignal): Promise<void> {
    LOGGER.debug("Starting keep-alive task");
    while (!signal.aborted) {
      try {
        await sleep(KEEP_ALIVE_INTERVAL);
        if (signal.aborted) break;
        LOGGER.debug("Sending keep-alive feedback");
        await this.rtsp.feedback();
      } catch (ex) {
        if (ex instanceof CancelledError) break;
        if (ex instanceof ProtocolError) LOGGER.error("feedback failed: %s", ex);
        else throw ex;
      }
    }
    LOGGER.debug("Feedback task finished");
  }

  async sendAudioPacket(transport: DatagramTransport, rtpHeader: Buffer, audio: Buffer): Promise<[number, Buffer]> {
    const packet = Buffer.concat([rtpHeader, audio]);
    transport.sendto(packet);
    return [this.context.rtpseq, packet];
  }

  async playUrl(_timingServerPort: number, url: string, position = 0.0): Promise<HttpResponse> {
    const verifier = pairVerify(this.context.credentials, this.rtsp.connection);
    await verifier.verifyCredentials();

    const body = {
      "Content-Location": url,
      "Start-Position": position,
      "X-Apple-Session-ID": uuid4(),
    };

    return this.rtsp.connection.post("/play", {
      headers: HEADERS,
      body: plistlib.dumps(body, plistlib.FMT_BINARY),
      allowError: true,
    });
  }
}
