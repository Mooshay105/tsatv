/** Transparent encryption layer using Chacha20_Poly1305. */

import { intToBytes } from "./bytes.ts";
import { ChaCha20Poly1305 } from "./chacha20poly1305.ts";

export const NONCE_LENGTH = 12;

/** CHACHA20 encryption/decryption layer. */
export class Chacha20Cipher {
  private readonly _encOut: ChaCha20Poly1305;
  private readonly _encIn: ChaCha20Poly1305;
  protected _outCounter = 0;
  protected _inCounter = 0;
  private readonly _nonceLength: number;

  constructor(outKey: Uint8Array, inKey: Uint8Array, nonceLength = 8) {
    this._encOut = new ChaCha20Poly1305(outKey);
    this._encIn = new ChaCha20Poly1305(inKey);
    this._nonceLength = nonceLength;
  }

  /** Return next encrypt nonce. */
  get outNonce(): Buffer {
    const nonce = intToBytes(this._outCounter, this._nonceLength, "little");
    return this._nonceLength !== NONCE_LENGTH ? this._padNonce(nonce) : nonce;
  }

  /** Return next decrypt nonce. */
  get inNonce(): Buffer {
    const nonce = intToBytes(this._inCounter, this._nonceLength, "little");
    return this._nonceLength !== NONCE_LENGTH ? this._padNonce(nonce) : nonce;
  }

  protected _padNonce(nonce: Uint8Array): Buffer {
    return Buffer.concat([Buffer.alloc(NONCE_LENGTH - nonce.length), nonce]);
  }

  /** Encrypt data with counter or specified nonce. */
  encrypt(data: Uint8Array, nonce?: Uint8Array | null, aad?: Uint8Array | null): Buffer {
    let n: Uint8Array;
    if (nonce === undefined || nonce === null) {
      n = this.outNonce;
      this._outCounter += 1;
    } else if (nonce.length < NONCE_LENGTH) {
      n = this._padNonce(nonce);
    } else {
      n = nonce;
    }
    return this._encOut.encrypt(n, data, aad);
  }

  /** Decrypt data with counter or specified nonce. */
  decrypt(data: Uint8Array, nonce?: Uint8Array | null, aad?: Uint8Array | null): Buffer {
    let n: Uint8Array;
    if (nonce === undefined || nonce === null) {
      n = this.inNonce;
      this._inCounter += 1;
    } else if (nonce.length < NONCE_LENGTH) {
      n = this._padNonce(nonce);
    } else {
      n = nonce;
    }
    return this._encIn.decrypt(n, data, aad);
  }
}

function packNonceWith4BytePad(counter: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(BigInt(counter), 4);
  return out;
}

/**
 * CHACHA20 encryption/decryption layer with an 8 byte counter.
 *
 * The first 4 bytes are always 0, followed by 8 bytes of counter for a total of 12
 * bytes.
 */
export class Chacha20Cipher8byteNonce extends Chacha20Cipher {
  constructor(outKey: Uint8Array, inKey: Uint8Array) {
    super(outKey, inKey, 8);
  }

  override get outNonce(): Buffer {
    return packNonceWith4BytePad(this._outCounter);
  }

  override get inNonce(): Buffer {
    return packNonceWith4BytePad(this._inCounter);
  }
}
