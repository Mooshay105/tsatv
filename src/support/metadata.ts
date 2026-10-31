/**
 * Convenience methods for extracting metadata from an audio file.
 *
 * pyatv uses tinytag for this. Here metadata is parsed natively from WAV files (RIFF
 * INFO and embedded ID3 chunks) and ID3v2 tags (e.g. MP3). Other formats fall back to
 * ffprobe (if installed on the system).
 */

import { MediaMetadata } from "../interface.ts";
import { getLogger } from "./logging.ts";

const LOGGER = getLogger("pyatv.support.metadata");

export { MediaMetadata };

/** Metadata with no fields set. Do not modify, use emptyMetadata() for a copy. */
export const EMPTY_METADATA: Readonly<MediaMetadata> = Object.freeze(new MediaMetadata());

/** Return a new metadata instance with no fields set. */
export function emptyMetadata(): MediaMetadata {
  return new MediaMetadata();
}

/** Return if two metadata instances contain the same values. */
export function metadataEquals(a: MediaMetadata, b: MediaMetadata): boolean {
  return MediaMetadata.FIELDS.every((field) => {
    const x = a[field];
    const y = b[field];
    if (Buffer.isBuffer(x) && Buffer.isBuffer(y)) return x.equals(y);
    return x === y;
  });
}

interface Tags {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}

// --- ID3v2 ---------------------------------------------------------------------------

const ID3_FRAMES: Record<string, keyof Tags> = {
  TIT2: "title",
  TT2: "title",
  TPE1: "artist",
  TP1: "artist",
  TALB: "album",
  TAL: "album",
};

function synchsafe(data: Buffer, offset: number): number {
  return ((data[offset]! & 0x7f) << 21) | ((data[offset + 1]! & 0x7f) << 14) | ((data[offset + 2]! & 0x7f) << 7) | (data[offset + 3]! & 0x7f);
}

function removeUnsynchronization(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    out.push(data[i]!);
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
}

function decodeId3Text(data: Buffer): string {
  if (data.length === 0) return "";
  const encoding = data[0];
  const content = data.subarray(1);
  let text: string;
  if (encoding === 1 || encoding === 2) {
    let body = content;
    let littleEndian = encoding === 1;
    if (encoding === 1 && body.length >= 2) {
      if (body[0] === 0xfe && body[1] === 0xff) littleEndian = false;
      if ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) body = body.subarray(2);
    }
    const even = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    if (!littleEndian) even.swap16();
    text = even.toString("utf16le");
  } else if (encoding === 3) {
    text = content.toString("utf-8");
  } else {
    text = content.toString("latin1");
  }
  // Multiple values are separated by null, use the first one (like tinytag)
  return text.split("\0")[0]!;
}

/** Parse an ID3v2 tag starting at offset 0 in data. */
export function parseId3v2(data: Buffer): Tags {
  const tags: Tags = {};
  if (data.length < 10 || data.toString("latin1", 0, 3) !== "ID3") return tags;

  const major = data[3]!;
  const flags = data[5]!;
  const size = synchsafe(data, 6);
  let body = data.subarray(10, Math.min(data.length, 10 + size));
  if (flags & 0x80 && major < 4) body = removeUnsynchronization(body);

  let pos = 0;
  // Skip extended header
  if (flags & 0x40) {
    if (major === 3) pos = 4 + body.readUInt32BE(0);
    else if (major === 4) pos = synchsafe(body, 0);
  }

  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  while (pos + headerLength <= body.length) {
    const frameId = body.toString("latin1", pos, pos + idLength);
    if (!/^[A-Z0-9]+$/.test(frameId)) break; // Padding

    let frameSize: number;
    if (major === 2) frameSize = body.readUIntBE(pos + 3, 3);
    else if (major === 4) frameSize = synchsafe(body, pos + 4);
    else frameSize = body.readUInt32BE(pos + 4);

    const frameData = body.subarray(pos + headerLength, pos + headerLength + frameSize);
    const field = ID3_FRAMES[frameId];
    if (field && tags[field] === undefined) {
      (tags as Record<string, unknown>)[field] = decodeId3Text(frameData);
    }
    pos += headerLength + frameSize;
  }
  return tags;
}

// --- WAV -----------------------------------------------------------------------------

const RIFF_INFO: Record<string, keyof Tags> = { INAM: "title", IART: "artist", IPRD: "album" };

function parseRiffInfo(data: Buffer, tags: Tags): void {
  let pos = 4; // Skip "INFO"
  while (pos + 8 <= data.length) {
    const id = data.toString("latin1", pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    const field = RIFF_INFO[id];
    if (field && tags[field] === undefined) {
      (tags as Record<string, unknown>)[field] = data
        .subarray(pos + 8, pos + 8 + size)
        .toString("utf-8")
        .replace(/\0+$/, "");
    }
    pos += 8 + size + (size % 2);
  }
}

/** Return if data looks like a WAV file. */
export function isWav(data: Buffer): boolean {
  return data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WAVE";
}

/**
 * Parse metadata from a (possibly partial) WAV file.
 *
 * Chunks that are not entirely in data are ignored, except for the data chunk where
 * only the size is used.
 */
export function parseWavTags(data: Buffer): Tags {
  const tags: Tags = {};
  let byteRate = 0;
  let dataSize: number | null = null;
  let pos = 12;
  while (pos + 8 <= data.length) {
    const id = data.toString("latin1", pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    const chunk = data.subarray(pos + 8, pos + 8 + size);
    if (id === "fmt " && chunk.length >= 12) {
      byteRate = chunk.readUInt32LE(8);
    } else if (id === "data") {
      dataSize = size;
    } else if (id === "LIST" && chunk.toString("latin1", 0, 4) === "INFO") {
      parseRiffInfo(chunk, tags);
    } else if (id.toLowerCase() === "id3 ") {
      const id3 = parseId3v2(chunk);
      for (const [key, value] of Object.entries(id3)) {
        if ((tags as Record<string, unknown>)[key] === undefined) (tags as Record<string, unknown>)[key] = value;
      }
    }
    pos += 8 + size + (size % 2);
  }
  if (byteRate > 0 && dataSize !== null) tags.duration = dataSize / byteRate;
  return tags;
}

// --- ffprobe -------------------------------------------------------------------------

async function ffprobeTags(input: string | Buffer): Promise<Tags> {
  const fromFile = typeof input === "string";
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", fromFile ? input : "pipe:0"],
    { stdin: fromFile ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore" },
  );
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("ffprobe failed to parse file");

  const parsed = JSON.parse(output);
  const allTags: Record<string, string> = {};
  for (const source of [parsed.format?.tags, ...(parsed.streams ?? []).map((s: any) => s.tags)]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (allTags[key.toLowerCase()] === undefined) allTags[key.toLowerCase()] = String(value);
    }
  }
  const duration = parseFloat(parsed.format?.duration ?? parsed.streams?.[0]?.duration);
  return {
    title: allTags.title ?? null,
    artist: allTags.artist ?? null,
    album: allTags.album ?? null,
    duration: Number.isFinite(duration) ? duration : null,
  };
}

/** Extract tags from file content (or a prefix of it). */
async function extractTags(data: Buffer, filename: string | null): Promise<Tags> {
  if (isWav(data)) return parseWavTags(data);

  // Use ffprobe for everything else if available, otherwise only ID3 is supported
  try {
    return await ffprobeTags(filename ?? data);
  } catch (ex) {
    LOGGER.debug("ffprobe failed (%s), trying ID3", ex);
  }
  if (data.toString("latin1", 0, 3) === "ID3") return parseId3v2(data);
  throw new Error("unsupported file format");
}

/**
 * Extract metadata from a file and return it.
 *
 * A file name or the file content (or a prefix of it, in case of streaming) can be
 * provided.
 */
export async function getMetadata(file: string | Uint8Array): Promise<MediaMetadata> {
  let tags: Tags;
  if (typeof file === "string") {
    const data = Buffer.from(await Bun.file(file).arrayBuffer());
    tags = await extractTags(data, file);
  } else {
    tags = await extractTags(Buffer.from(file), null);
  }

  return new MediaMetadata({
    title: tags.title ?? null,
    artist: tags.artist ?? null,
    album: tags.album ?? null,
    duration: tags.duration ?? null,
  });
}

/**
 * Merge missing fields into base metadata.
 *
 * Updates all fields with a null value in "base" with corresponding values from
 * "newMetadata". Returns "base" again.
 */
export function mergeInto(base: MediaMetadata, newMetadata: MediaMetadata): MediaMetadata {
  for (const field of MediaMetadata.FIELDS) {
    if (base[field] === null) (base as any)[field] = newMetadata[field];
  }
  return base;
}
