/** Cryptography routines used by HAP. */

import { Chacha20Cipher } from "../support/chacha20.ts";

/**
 * Manages cryptography for a HAP session according to IP in specification.
 *
 * The HAP specification mandates that data is encrypted/decrypted in blocks of 1024
 * bytes. This class takes care of that. It is designed to be transparent until
 * encryption is enabled, i.e. data is just passed through in case it has not yet
 * been enabled.
 */
export class HAPSession {
  static readonly FRAME_LENGTH = 1024; // As specified by HAP, section 5.2.2 (Release R1)
  static readonly AUTH_TAG_LENGTH = 16;

  private _encryptedData: Buffer = Buffer.alloc(0);
  chacha20: Chacha20Cipher | null = null;

  /** Enable encryption with specified keys. */
  enable(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this.chacha20 = new Chacha20Cipher(outputKey, inputKey);
  }

  /** Decrypt incoming data. */
  decrypt(data: Uint8Array): Buffer {
    if (this.chacha20 === null) return Buffer.from(data);

    this._encryptedData = Buffer.concat([this._encryptedData, data]);

    const output: Buffer[] = [];
    while (this._encryptedData.length > 0) {
      const length = this._encryptedData.subarray(0, 2);
      if (length.length < 2) break;
      const blockLength = length.readUInt16LE(0) + HAPSession.AUTH_TAG_LENGTH;
      if (this._encryptedData.length < blockLength + 2) break;

      const block = this._encryptedData.subarray(2, 2 + blockLength);
      output.push(this.chacha20.decrypt(block, null, Buffer.from(length)));

      this._encryptedData = this._encryptedData.subarray(2 + blockLength);
    }
    return Buffer.concat(output);
  }

  /** Encrypt outgoing data. */
  encrypt(data: Uint8Array): Buffer {
    if (this.chacha20 === null) return Buffer.from(data);

    const output: Buffer[] = [];
    let remaining = Buffer.from(data);
    while (remaining.length > 0) {
      const frame = remaining.subarray(0, HAPSession.FRAME_LENGTH);
      remaining = remaining.subarray(HAPSession.FRAME_LENGTH);

      const length = Buffer.alloc(2);
      length.writeUInt16LE(frame.length);
      output.push(length, this.chacha20.encrypt(frame, null, length));
    }
    return Buffer.concat(output);
  }
}
