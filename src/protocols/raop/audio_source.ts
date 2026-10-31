/** Audio sources that can provide raw PCM frames that pyatv can stream. */

import { NotSupportedError, OperationTimeoutError, ProtocolError } from "../../exceptions.ts";
import type { MediaMetadata, StreamSource as InterfaceStreamSource } from "../../interface.ts";
import { asyncTimeout } from "../../support/asyncio.ts";
import { decodeFile, type DecodedSoundFile, DecodeError, type OutputFormat, StreamDecoder } from "../../support/audio.ts";
import { getLogger } from "../../support/logging.ts";
import { emptyMetadata, getMetadata } from "../../support/metadata.ts";
import { StreamReader } from "../../support/transport.ts";

const LOGGER = getLogger("pyatv.protocols.raop.audio_source");

export const FRAMES_PER_PACKET = 352;

/** Timeout used when streaming from the Internet (seconds). */
export const DEFAULT_TIMEOUT = 10.0;

/** Max amount of data read from a stream before parsing metadata. */
export const HEADROOM_SIZE = 32 * 1024;

/**
 * Convert samples to the format expected by the receiver.
 *
 * pyatv byteswaps (16 bit) samples here on little endian systems, so do the same.
 */
function toAudioSamples(data: Buffer): Buffer {
  // TODO: This assumes s16 samples!
  const output = Buffer.from(data.subarray(0, data.length - (data.length % 2)));
  output.swap16();
  return output;
}

function outputFormat(sampleRate: number, channels: number, sampleSize: number): OutputFormat {
  if (![1, 2, 3, 4].includes(sampleSize)) throw new NotSupportedError(`unsupported sample size: ${sampleSize}`);
  return { sampleRate, channels, sampleSize };
}

/** Audio source that returns raw PCM frames. */
export abstract class AudioSource {
  static readonly NO_FRAMES = Buffer.alloc(0);

  /** Close underlying resources. */
  async close(): Promise<void> {}

  /**
   * Read number of frames and advance in stream.
   *
   * Frames are returned in the byte order AirPlay expects.
   */
  abstract readframes(nframes: number): Promise<Buffer>;

  /** Return media metadata if available and possible. */
  abstract getMetadata(): Promise<MediaMetadata>;

  /** Return sample rate. */
  abstract get sampleRate(): number;

  /** Return number of audio channels. */
  abstract get channels(): number;

  /** Return number of bytes per sample. */
  abstract get sampleSize(): number;

  /** Return duration in seconds. */
  abstract get duration(): number;
}

/** Source of audio data that can be streamed (anything but a file name/URL). */
export type StreamSource = Exclude<InterfaceStreamSource, string>;

function toAsyncIterator(source: StreamSource): AsyncIterator<Uint8Array> {
  if (source instanceof Uint8Array) {
    return (async function* () {
      yield source;
    })();
  }
  if (source instanceof StreamReader) {
    return (async function* () {
      for (;;) {
        const data = await source.read(64 * 1024);
        if (data.length === 0) break;
        yield data;
      }
    })();
  }
  if (Symbol.asyncIterator in (source as object)) {
    return (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  }
  const reader = source as { read(size?: number): Promise<Uint8Array> };
  return (async function* () {
    for (;;) {
      const data = await reader.read(64 * 1024);
      if (!data || data.length === 0) break;
      yield data;
    }
  })();
}

/** Read up to "size" bytes from the beginning of a stream (for metadata parsing). */
async function readHead(iterator: AsyncIterator<Uint8Array>, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < size) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
    total += next.value.length;
  }
  return Buffer.concat(chunks);
}

/** Read metadata from the head of a stream. Never throws. */
async function getStreamMetadata(head: Buffer): Promise<MediaMetadata> {
  try {
    return await getMetadata(head);
  } catch (ex) {
    LOGGER.debug("Failed to parse metadata: %s", ex);
  }
  return emptyMetadata();
}

/**
 * Audio source used to play from a stream (e.g. a buffer or a stream reader).
 *
 * Metadata is extracted from the beginning of the stream, so metadata located at the
 * end of a large file will not be found.
 */
export class BufferedIOBaseSource extends AudioSource {
  protected constructor(
    readonly decoder: StreamDecoder,
    readonly metadata: MediaMetadata,
    private readonly _sampleRate: number,
    private readonly _channels: number,
    private readonly _sampleSize: number,
  ) {
    super();
  }

  /** Return a new AudioSource instance playing from the provided source. */
  static async open(source: StreamSource, sampleRate: number, channels: number, sampleSize: number): Promise<BufferedIOBaseSource> {
    const format = outputFormat(sampleRate, channels, sampleSize);
    const iterator = toAsyncIterator(source);
    const head = await readHead(iterator, HEADROOM_SIZE);
    const metadata = await getStreamMetadata(head);
    const decoder = await StreamDecoder.create(head, iterator, format);
    return new BufferedIOBaseSource(decoder, metadata, sampleRate, channels, sampleSize);
  }

  override async close(): Promise<void> {
    this.decoder.close();
  }

  async readframes(nframes: number): Promise<Buffer> {
    const data = await this.decoder.read(nframes * this._sampleSize * this._channels);
    return toAudioSamples(data);
  }

  async getMetadata(): Promise<MediaMetadata> {
    return this.metadata;
  }

  get sampleRate(): number {
    return this._sampleRate;
  }

  get channels(): number {
    return this._channels;
  }

  get sampleSize(): number {
    return this._sampleSize;
  }

  get duration(): number {
    return 0; // We don't know the duration
  }
}

/** Audio source used to stream from an Internet source (HTTP). */
export class InternetSource extends BufferedIOBaseSource {
  /** Return a new AudioSource instance playing from the provided URL. */
  static async openUrl(url: string, sampleRate: number, channels: number, sampleSize: number): Promise<InternetSource> {
    const format = outputFormat(sampleRate, channels, sampleSize);
    const controller = new AbortController();

    let response: Response;
    try {
      response = await asyncTimeout(DEFAULT_TIMEOUT, () => fetch(url, { signal: controller.signal }));
    } catch (ex) {
      if (ex instanceof Error && ex.name === "TimeoutError") throw new OperationTimeoutError("timed out reading from stream");
      throw new ProtocolError(`Failed to stream from ${url}: ${ex}`, { cause: ex });
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new ProtocolError(`Got status ${response.status} with message: ${response.statusText}`);
    }

    const iterator = toAsyncIterator(response.body);
    const head = await readHead(iterator, HEADROOM_SIZE);
    const metadata = await getStreamMetadata(head);

    let decoder: StreamDecoder;
    try {
      decoder = await StreamDecoder.create(head, iterator, format);
    } catch (ex) {
      controller.abort();
      if (ex instanceof DecodeError) throw new ProtocolError(`Failed to stream from ${url}: ${ex.message}`, { cause: ex });
      throw ex;
    }

    const source = new InternetSource(decoder, metadata, sampleRate, channels, sampleSize);
    source.controller = controller;
    return source;
  }

  private controller: AbortController | null = null;

  override async close(): Promise<void> {
    await super.close();
    this.controller?.abort();
  }

  override get duration(): number {
    return Math.ceil(this.metadata.duration ?? 0);
  }
}

/** Audio source used to play a local audio file. */
export class FileSource extends AudioSource {
  private pos = 0;

  private constructor(readonly src: DecodedSoundFile) {
    super();
  }

  /** Return a new AudioSource instance playing from the provided file. */
  static async open(filename: string, sampleRate: number, channels: number, sampleSize: number): Promise<FileSource> {
    return new FileSource(await decodeFile(filename, outputFormat(sampleRate, channels, sampleSize)));
  }

  async readframes(nframes: number): Promise<Buffer> {
    const samples = this.src.samples;
    if (this.pos >= samples.length) return AudioSource.NO_FRAMES;

    const bytesToRead = this.sampleSize * this.channels * nframes;
    const data = samples.subarray(this.pos, Math.min(samples.length, this.pos + bytesToRead));
    this.pos += bytesToRead;
    return toAudioSamples(data);
  }

  async getMetadata(): Promise<MediaMetadata> {
    try {
      return await getMetadata(this.src.name);
    } catch (ex) {
      LOGGER.warning("Failed to load metadata from %s: %s", this.src.name, ex);
    }
    return emptyMetadata();
  }

  get sampleRate(): number {
    return this.src.sampleRate;
  }

  get channels(): number {
    return this.src.channels;
  }

  get sampleSize(): number {
    return this.src.sampleWidth;
  }

  get duration(): number {
    return Math.round(this.src.duration);
  }
}

/** Create an AudioSource from given input source. */
export async function openSource(
  source: string | StreamSource,
  sampleRate: number,
  channels: number,
  sampleSize: number,
): Promise<AudioSource> {
  if (typeof source === "string") {
    if (/^http(|s):\/\//.test(source)) return InternetSource.openUrl(source, sampleRate, channels, sampleSize);
    return FileSource.open(source, sampleRate, channels, sampleSize);
  }
  return BufferedIOBaseSource.open(source, sampleRate, channels, sampleSize);
}
