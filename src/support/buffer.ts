/** Classes and functions for data buffering. */

import { InvalidStateError } from "../exceptions.ts";

// Default values for buffer
export const BUFFER_SIZE = 8192;
export const HEADROOM_SIZE = 1024;

/**
 * Implementation of a "semi-seekable" buffer.
 *
 * A semi-seekable buffer in this context is a buffer that allows seeking, but with
 * restrictions. The buffer shall be thought of more like a stream, where data is read
 * in a stream like fashion but added similarly to like a buffer. The buffer has a
 * fixed size internally, but an absolute "position" is maintained based on all data
 * read from the buffer.
 *
 * To allow seeking, a "headroom" (with adjustable size) is kept in the beginning of
 * the buffer. Data in the headroom is kept (internally) until the last byte of the
 * headroom is read, after which is discarded from the internal buffer (and new data
 * can be added again, in case buffer was full). As long as headroom is available,
 * seeking is possible.
 *
 * A special feature called "protected headroom" is also implemented. When enabled,
 * the buffer acts as usual but the entire buffer is treated like headroom and no
 * data is ever removed. Protected headroom can only be enabled/disabled when position
 * is 0.
 */
export class SemiSeekableBuffer {
  private _buffer: Buffer = Buffer.alloc(0);
  private readonly _bufferSize: number;
  private readonly _headroom: number;
  private _position = 0;
  private _hasHeadroomData = true;
  private _protected: boolean;

  constructor(
    bufferSize: number = BUFFER_SIZE,
    options: { seekableHeadroom?: number; protectedHeadroom?: boolean } = {},
  ) {
    const seekableHeadroom = options.seekableHeadroom ?? HEADROOM_SIZE;
    // Headroom cannot be smaller than actual buffer
    if (seekableHeadroom > bufferSize) {
      throw new RangeError("too large seekable headroom");
    }
    this._bufferSize = bufferSize;
    this._headroom = seekableHeadroom;
    this._protected = options.protectedHeadroom ?? false;
  }

  /** Return True if buffer is empty, otherwise False. */
  empty(): boolean {
    return this.size === 0;
  }

  /** Return number of bytes in buffer. */
  get size(): number {
    return this._buffer.length - (this._hasHeadroomData ? this._position : 0);
  }

  get length(): number {
    return this.size;
  }

  /** Return remaining bytes in buffer. */
  get remaining(): number {
    return this._bufferSize - this.size;
  }

  /** Return absolute position of bytes read from buffer. */
  get position(): number {
    return this._position;
  }

  /** Return if headroom is protected. */
  get protectedHeadroom(): boolean {
    return this._protected;
  }

  /** Set if headroom is protected or not. */
  set protectedHeadroom(value: boolean) {
    if (value === this._protected) return;
    if (this.position !== 0) {
      throw new InvalidStateError("not a starting position");
    }
    this._protected = value;
  }

  /** Add data to buffer. Returns number of bytes added to buffer. */
  add(data: Uint8Array): number {
    const roomInBuffer = Math.min(data.length, this._bufferSize - this._buffer.length);
    this._buffer = Buffer.concat([this._buffer, data.subarray(0, roomInBuffer)]);
    return roomInBuffer;
  }

  /** Retrieve data from buffer. Will return empty buffer if buffer is empty. */
  get(numberOfBytes: number): Buffer {
    let data: Buffer;
    // Use position as offset in case we have (potentially read but kept) headroom
    if (this._hasHeadroomData) {
      data = this._buffer.subarray(this._position, this._position + numberOfBytes);
    } else {
      data = this._buffer.subarray(0, numberOfBytes);
    }
    data = Buffer.from(data);

    this._position += data.length;

    // Treat entire buffer as headroom in case it's protected and do not remove
    // any data
    if (!this.protectedHeadroom) {
      if (this._hasHeadroomData) {
        // If we read past the headroom, we shall discard it (and additional
        // data we read)
        if (this._position >= this._headroom) {
          this._hasHeadroomData = false;
          this._buffer = this._buffer.subarray(this._position);
        }
      } else {
        this._buffer = this._buffer.subarray(data.length);
      }
    }

    return data;
  }

  /**
   * Seek to absolute position in buffer.
   *
   * This method only works as long as there is headroom available. Returns true if
   * seek was successful, otherwise false.
   */
  seek(position: number): boolean {
    // This is a special case where we allow seeking to the current position
    if (position === this.position) return true;

    // Absolute position (i.e. total amount of data read from buffer) has passed
    // headroom space, so we have no headroom data and thus seeking not possible.
    if (!this._hasHeadroomData) return false;

    // Can only seek within headroom
    if (position >= this._headroom) return false;

    // There must be data in buffer for seeking to work
    const headroomDataInBuffer = Math.min(this._headroom, this._buffer.length);
    if (position > headroomDataInBuffer - 1) return false;

    this._position = position;
    return true;
  }

  /** Check if data (or amount of data) fits in the buffer. */
  fits(data: number | Uint8Array): boolean {
    const inSize = typeof data === "number" ? data : data.length;
    return this._buffer.length + inSize <= this._bufferSize;
  }
}
