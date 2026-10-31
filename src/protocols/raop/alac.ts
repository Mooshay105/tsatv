/**
 * Minimal ALAC "encoder" producing uncompressed (escape) ALAC frames.
 *
 * Some AirPlay 2 receivers (e.g. Sonos speakers) accept raw PCM in SETUP but play
 * silence, while ALAC is supported by all receivers. Uncompressed ALAC frames are
 * just PCM samples wrapped in a small bit-packed header, so no actual compression
 * is needed.
 */

// ALAC element tags
const ID_SCE = 0; // Single channel element
const ID_CPE = 1; // Channel pair element
const ID_END = 7;

/** Writes values MSB first into a byte buffer. */
class BitWriter {
  private readonly buffer: Buffer;
  private bitPosition = 0;

  constructor(sizeInBits: number) {
    this.buffer = Buffer.alloc(Math.ceil(sizeInBits / 8));
  }

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >>> i) & 1) this.buffer[this.bitPosition >> 3]! |= 0x80 >> (this.bitPosition & 7);
      this.bitPosition += 1;
    }
  }

  // Write whole bytes (fast path when samples are already in big endian order)
  writeBytes(data: Buffer): void {
    if ((this.bitPosition & 7) === 0) {
      data.copy(this.buffer, this.bitPosition >> 3);
      this.bitPosition += data.length * 8;
      return;
    }
    for (const byte of data) this.write(byte, 8);
  }

  get result(): Buffer {
    return this.buffer.subarray(0, Math.ceil(this.bitPosition / 8));
  }
}

/**
 * Wrap 16 bit big endian interleaved PCM samples in an uncompressed ALAC frame.
 *
 * Only one or two channels are supported (that is what AirPlay uses).
 */
export function encodeUncompressedAlac(samples: Buffer, channels: number): Buffer {
  if (channels !== 1 && channels !== 2) throw new RangeError(`unsupported channel count: ${channels}`);

  const frameSize = 2 * channels;
  const frames = Math.floor(samples.length / frameSize);
  const sampleData = samples.subarray(0, frames * frameSize);

  // Header: 3 (tag) + 4 (instance) + 12 (unused) + 1 (has size) + 2 (shift) +
  // 1 (uncompressed) + 32 (frame count) = 55 bits, then samples and end tag
  const writer = new BitWriter(55 + sampleData.length * 8 + 3);
  writer.write(channels === 2 ? ID_CPE : ID_SCE, 3);
  writer.write(0, 4); // Element instance tag
  writer.write(0, 12); // Unused header bits
  writer.write(1, 1); // Has explicit frame count
  writer.write(0, 2); // Uncompressed bytes ("shift"), none for 16 bit
  writer.write(1, 1); // Is not compressed (escape flag)
  writer.write(frames >>> 16, 16); // Frame count (32 bits)
  writer.write(frames & 0xffff, 16);
  writer.writeBytes(sampleData);
  writer.write(ID_END, 3);
  return writer.result;
}
