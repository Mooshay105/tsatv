/**
 * Audio decoding (replacement for miniaudio used by pyatv).
 *
 * WAV files are decoded natively. Other formats (MP3, FLAC, Ogg Vorbis, ...) are decoded
 * with ffmpeg, which must be installed on the system for these formats to work.
 *
 * All decoded audio is returned as interleaved PCM samples in little endian, converted
 * to the requested sample rate, number of channels and sample size.
 */

import { getLogger } from "./logging.ts";

const LOGGER = getLogger("pyatv.support.audio");

/** Thrown when audio cannot be decoded. */
export class DecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DecodeError";
  }
}

/** Desired output format. */
export interface OutputFormat {
  sampleRate: number;
  channels: number;
  /** Number of bytes per sample (1, 2, 3 or 4). */
  sampleSize: number;
}

/** Information about an audio file. */
export interface AudioFileInfo {
  name: string;
  fileFormat: string;
  sampleRate: number;
  channels: number;
  /** Number of bytes per sample. */
  sampleWidth: number;
  numFrames: number;
  /** Duration in seconds. */
  duration: number;
}

/** A completely decoded sound file. */
export interface DecodedSoundFile extends AudioFileInfo {
  samples: Buffer;
}

// --- WAV parsing ---------------------------------------------------------------------

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

interface WavFormat {
  format: number; // PCM or float
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}

interface WavHeader {
  fmt: WavFormat;
  dataOffset: number;
  dataSize: number;
}

/**
 * Parse WAV header from (beginning of) a file.
 *
 * Returns null if more data is needed to find the data chunk.
 */
function parseWavHeader(data: Buffer): WavHeader | null {
  if (data.length < 12) return null;
  if (data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WAVE") {
    throw new DecodeError("not a WAV file");
  }

  let fmt: WavFormat | null = null;
  let pos = 12;
  while (pos + 8 <= data.length) {
    const id = data.toString("latin1", pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    if (id === "data") {
      if (!fmt) throw new DecodeError("data chunk before fmt chunk");
      // Streamed WAV files might have size 0 or 0xFFFFFFFF, treat as "until end"
      const dataSize = size === 0xffffffff || (size === 0 && data.length > pos + 8) ? Number.POSITIVE_INFINITY : size;
      return { fmt, dataOffset: pos + 8, dataSize };
    }
    if (pos + 8 + size > data.length) return null;
    if (id === "fmt ") {
      let format = data.readUInt16LE(pos + 8);
      const channels = data.readUInt16LE(pos + 10);
      const sampleRate = data.readUInt32LE(pos + 12);
      const blockAlign = data.readUInt16LE(pos + 20);
      const bitsPerSample = data.readUInt16LE(pos + 22);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) format = data.readUInt16LE(pos + 32);
      if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_IEEE_FLOAT) {
        throw new DecodeError(`unsupported WAV format: ${format}`);
      }
      if (format === WAVE_FORMAT_PCM && ![8, 16, 24, 32].includes(bitsPerSample)) {
        throw new DecodeError(`unsupported bits per sample: ${bitsPerSample}`);
      }
      if (format === WAVE_FORMAT_IEEE_FLOAT && ![32, 64].includes(bitsPerSample)) {
        throw new DecodeError(`unsupported float size: ${bitsPerSample}`);
      }
      if (channels === 0 || sampleRate === 0) throw new DecodeError("invalid WAV format");
      fmt = { format, channels, sampleRate, bitsPerSample, blockAlign };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

// --- Sample conversion ---------------------------------------------------------------

/** Read sample i (in range [-1, 1]) from raw data in given format. */
function readSample(data: Buffer, offset: number, format: number, bits: number): number {
  if (format === WAVE_FORMAT_IEEE_FLOAT) {
    return bits === 32 ? data.readFloatLE(offset) : data.readDoubleLE(offset);
  }
  switch (bits) {
    case 8:
      return (data[offset]! - 128) / 128;
    case 16:
      return data.readInt16LE(offset) / 32768;
    case 24:
      return data.readIntLE(offset, 3) / 8388608;
    default:
      return data.readInt32LE(offset) / 2147483648;
  }
}

function writeSample(out: Buffer, offset: number, value: number, size: number): void {
  const v = Math.max(-1, Math.min(1, value));
  switch (size) {
    case 1:
      out[offset] = Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
      break;
    case 2:
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), offset);
      break;
    case 3:
      out.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608))), offset, 3);
      break;
    default:
      out.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483648))), offset);
  }
}

/**
 * Converts PCM data in one format into another (sample size, channels and rate).
 *
 * Data can be fed incrementally, conversion state (e.g. for resampling) is kept
 * between calls.
 */
class PcmConverter {
  private readonly inFrameSize: number;
  private readonly outFrameSize: number;
  private readonly passthrough: boolean;
  private remainder: Buffer = Buffer.alloc(0);
  // Resampling state
  private readonly step: number;
  private position = 0; // Position (in input frames) of next output frame
  private previous: number[] | null = null; // Last frame from previous chunk

  constructor(
    private readonly input: WavFormat,
    private readonly output: OutputFormat,
  ) {
    this.inFrameSize = (input.bitsPerSample / 8) * input.channels;
    this.outFrameSize = output.sampleSize * output.channels;
    this.passthrough =
      input.format === WAVE_FORMAT_PCM &&
      input.bitsPerSample / 8 === output.sampleSize &&
      input.channels === output.channels &&
      input.sampleRate === output.sampleRate;
    this.step = input.sampleRate / output.sampleRate;
  }

  convert(chunk: Buffer, final = false): Buffer {
    let data = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;
    const usable = data.length - (data.length % this.inFrameSize);
    this.remainder = Buffer.from(data.subarray(usable));
    data = data.subarray(0, usable);
    if (final && this.remainder.length > 0) {
      LOGGER.debug("Dropping %d bytes of incomplete audio frame", this.remainder.length);
      this.remainder = Buffer.alloc(0);
    }

    if (this.passthrough) return Buffer.from(data);

    // Decode and remix channels
    const frames: number[][] = [];
    const sampleBytes = this.input.bitsPerSample / 8;
    for (let off = 0; off < data.length; off += this.inFrameSize) {
      const samples: number[] = [];
      for (let ch = 0; ch < this.input.channels; ch++) {
        samples.push(readSample(data, off + ch * sampleBytes, this.input.format, this.input.bitsPerSample));
      }
      frames.push(this.remix(samples));
    }

    // Resample (linear interpolation)
    const resampled = this.input.sampleRate === this.output.sampleRate ? frames : this.resample(frames, final);

    const out = Buffer.alloc(resampled.length * this.outFrameSize);
    let offset = 0;
    for (const frame of resampled) {
      for (const sample of frame) {
        writeSample(out, offset, sample, this.output.sampleSize);
        offset += this.output.sampleSize;
      }
    }
    return out;
  }

  private remix(samples: number[]): number[] {
    const outChannels = this.output.channels;
    if (samples.length === outChannels) return samples;
    if (samples.length === 1) return new Array(outChannels).fill(samples[0]);
    if (outChannels === 1) return [samples.reduce((a, b) => a + b, 0) / samples.length];
    const out: number[] = [];
    for (let ch = 0; ch < outChannels; ch++) out.push(samples[ch % samples.length]!);
    return out;
  }

  private resample(frames: number[][], final: boolean): number[][] {
    // Frames available for interpolation: previous last frame (index -1) + new frames
    const source = this.previous ? [this.previous, ...frames] : frames;
    const base = this.previous ? -1 : 0;
    const out: number[][] = [];
    const lastIndex = frames.length - 1;

    for (;;) {
      const idx = Math.floor(this.position);
      const frac = this.position - idx;
      if (idx + 1 > lastIndex && !(final && idx <= lastIndex)) break;
      const a = source[idx - base]!;
      const b = source[Math.min(idx + 1, lastIndex) - base] ?? a;
      out.push(a.map((s, ch) => s + (b[ch]! - s) * frac));
      this.position += this.step;
    }

    if (frames.length > 0) {
      this.previous = frames[lastIndex]!;
      this.position -= frames.length;
    }
    return out;
  }
}

// --- ffmpeg --------------------------------------------------------------------------

const FFMPEG_FORMATS: Record<number, string> = { 1: "u8", 2: "s16le", 3: "s24le", 4: "s32le" };

function ffmpegArgs(input: string, output: OutputFormat): string[] {
  const format = FFMPEG_FORMATS[output.sampleSize];
  if (!format) throw new DecodeError(`unsupported sample size: ${output.sampleSize}`);
  return [
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-i",
    input,
    "-f",
    format,
    "-ar",
    String(output.sampleRate),
    "-ac",
    String(output.channels),
    "pipe:1",
  ];
}

function spawnFfmpeg(args: string[], stdin: "ignore" | "pipe") {
  try {
    if (stdin === "pipe") {
      // -nostdin must not be used when reading from stdin
      args = args.filter((arg) => arg !== "-nostdin");
    }
    return Bun.spawn(args, { stdin, stdout: "pipe", stderr: "pipe" });
  } catch (ex) {
    throw new DecodeError("ffmpeg is required to decode this format", { cause: ex });
  }
}

async function ffprobeInfo(filename: string): Promise<AudioFileInfo> {
  let proc;
  try {
    proc = Bun.spawn(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", filename], {
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (ex) {
    throw new DecodeError("ffprobe is required to decode this format", { cause: ex });
  }
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new DecodeError(`failed to decode ${filename}`);
  const parsed = JSON.parse(output);
  const stream = (parsed.streams ?? []).find((s: any) => s.codec_type === "audio");
  if (!stream) throw new DecodeError(`no audio stream in ${filename}`);

  const sampleRate = parseInt(stream.sample_rate, 10);
  const duration = parseFloat(stream.duration ?? parsed.format?.duration ?? "0");
  const bits = parseInt(stream.bits_per_raw_sample ?? stream.bits_per_sample ?? "0", 10);
  return {
    name: filename,
    fileFormat: parsed.format?.format_name ?? "unknown",
    sampleRate,
    channels: stream.channels,
    sampleWidth: bits > 0 ? Math.ceil(bits / 8) : 2,
    numFrames: Math.round(duration * sampleRate),
    duration,
  };
}

// --- Public API ----------------------------------------------------------------------

/** Return information about an audio file. Throws if format is not supported. */
export async function getFileInfo(filename: string): Promise<AudioFileInfo> {
  const file = Bun.file(filename);
  if (!(await file.exists())) throw new DecodeError(`file not found: ${filename}`);

  const head = Buffer.from(await file.slice(0, 12).arrayBuffer());
  if (head.toString("latin1", 0, 4) === "RIFF") {
    const data = Buffer.from(await file.arrayBuffer());
    const header = parseWavHeader(data);
    if (!header) throw new DecodeError("incomplete WAV file");
    const dataSize = Math.min(header.dataSize, data.length - header.dataOffset);
    const numFrames = Math.floor(dataSize / header.fmt.blockAlign);
    return {
      name: filename,
      fileFormat: "wav",
      sampleRate: header.fmt.sampleRate,
      channels: header.fmt.channels,
      sampleWidth: header.fmt.bitsPerSample / 8,
      numFrames,
      duration: numFrames / header.fmt.sampleRate,
    };
  }

  return ffprobeInfo(filename);
}

/** Decode an entire file into PCM samples in the requested format. */
export async function decodeFile(filename: string, output: OutputFormat): Promise<DecodedSoundFile> {
  const file = Bun.file(filename);
  if (!(await file.exists())) throw new DecodeError(`file not found: ${filename}`);
  const data = Buffer.from(await file.arrayBuffer());

  let samples: Buffer;
  let fileFormat = "wav";
  if (data.toString("latin1", 0, 4) === "RIFF") {
    const header = parseWavHeader(data);
    if (!header) throw new DecodeError("incomplete WAV file");
    const end = Math.min(data.length, header.dataOffset + header.dataSize);
    samples = new PcmConverter(header.fmt, output).convert(data.subarray(header.dataOffset, end), true);
  } else {
    const info = await ffprobeInfo(filename);
    fileFormat = info.fileFormat;
    const proc = spawnFfmpeg(ffmpegArgs(filename, output), "ignore");
    samples = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    if ((await proc.exited) !== 0) {
      throw new DecodeError(`failed to decode ${filename}: ${await new Response(proc.stderr).text()}`);
    }
  }

  const numFrames = Math.floor(samples.length / (output.sampleSize * output.channels));
  return {
    name: filename,
    fileFormat,
    sampleRate: output.sampleRate,
    channels: output.channels,
    sampleWidth: output.sampleSize,
    numFrames,
    duration: numFrames / output.sampleRate,
    samples,
  };
}

/** Source of encoded audio data used when streaming. */
export type ByteSource = AsyncIterable<Uint8Array>;

/**
 * Decoder for streamed audio data.
 *
 * Encoded data is read from a source and converted into PCM samples on demand.
 */
export class StreamDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private finished = false;
  private readonly iterator: AsyncIterator<Buffer>;
  private closeFn: () => void = () => {};

  private constructor(iterator: AsyncIterator<Buffer>) {
    this.iterator = iterator;
  }

  /**
   * Create a new decoder from a source.
   *
   * The first chunk of data must be provided in "head" (already read from the source,
   * e.g. for extracting metadata), "rest" is the remaining data.
   */
  static async create(head: Buffer, rest: AsyncIterator<Uint8Array>, output: OutputFormat): Promise<StreamDecoder> {
    if (head.toString("latin1", 0, 4) === "RIFF") return StreamDecoder.createWav(head, rest, output);
    return StreamDecoder.createFfmpeg(head, rest, output);
  }

  private static async createWav(head: Buffer, rest: AsyncIterator<Uint8Array>, output: OutputFormat): Promise<StreamDecoder> {
    // Read until entire header (up until data chunk) is available
    let buffer = head;
    let header = parseWavHeader(buffer);
    let sourceDone = false;
    while (!header) {
      const next = await rest.next();
      if (next.done) {
        sourceDone = true;
        break;
      }
      buffer = Buffer.concat([buffer, next.value]);
      header = parseWavHeader(buffer);
    }
    if (!header) throw new DecodeError("incomplete WAV header");

    const converter = new PcmConverter(header.fmt, output);
    let remaining = header.dataSize;
    const initial = buffer.subarray(header.dataOffset);

    async function* generate(): AsyncGenerator<Buffer> {
      const take = (chunk: Buffer): Buffer => {
        const used = chunk.subarray(0, Math.min(chunk.length, remaining));
        remaining -= used.length;
        return used;
      };

      if (initial.length > 0) yield converter.convert(take(Buffer.from(initial)));
      while (!sourceDone && remaining > 0) {
        const next = await rest.next();
        if (next.done) break;
        yield converter.convert(take(Buffer.from(next.value)));
      }
      yield converter.convert(Buffer.alloc(0), true);
    }

    return new StreamDecoder(generate());
  }

  private static async createFfmpeg(head: Buffer, rest: AsyncIterator<Uint8Array>, output: OutputFormat): Promise<StreamDecoder> {
    const proc = spawnFfmpeg(ffmpegArgs("pipe:0", output), "pipe");
    const stdin = proc.stdin!;
    let aborted = false;

    // Feed source data to ffmpeg in the background
    const feeder = (async () => {
      try {
        stdin.write(head);
        await stdin.flush();
        for (;;) {
          if (aborted) break;
          const next = await rest.next();
          if (next.done) break;
          stdin.write(next.value);
          await stdin.flush();
        }
      } catch (ex) {
        LOGGER.debug("Failed to feed data to ffmpeg: %s", ex);
      } finally {
        try {
          await stdin.end();
        } catch {
          // Process already gone
        }
      }
    })();

    async function* generate(): AsyncGenerator<Buffer> {
      let produced = false;
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        produced = true;
        yield Buffer.from(chunk);
      }
      await feeder;
      const code = await proc.exited;
      if (code !== 0 && !produced) {
        throw new DecodeError(`failed to decode stream: ${await new Response(proc.stderr).text()}`);
      }
    }

    const decoder = new StreamDecoder(generate());
    decoder.closeFn = () => {
      aborted = true;
      proc.kill();
    };
    return decoder;
  }

  /** Read up to "size" bytes of PCM data. Less is only returned at end of stream. */
  async read(size: number): Promise<Buffer> {
    while (this.pending.length < size && !this.finished) {
      const next = await this.iterator.next();
      if (next.done) {
        this.finished = true;
        break;
      }
      this.pending = this.pending.length === 0 ? next.value : Buffer.concat([this.pending, next.value]);
    }
    const data = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(data.length);
    return Buffer.from(data);
  }

  /** Stop decoding and free resources. */
  close(): void {
    this.finished = true;
    this.closeFn();
    void this.iterator.return?.(undefined);
  }
}
