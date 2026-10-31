/**
 * SRP-6a implementation (RFC 5054) as used by HomeKit pairing (HAP).
 *
 * Uses the 3072 bit group from RFC 5054 and SHA-512. Values (A, B, S) are padded to
 * the length of N where required, just like the HomeKit Accessory Development Kit.
 */

import crypto from "node:crypto";

export const PRIME_3072 = BigInt(
  "0x" +
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
    "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
    "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
    "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB" +
    "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
    "3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33" +
    "A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
    "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864" +
    "D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2" +
    "08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
export const PRIME_3072_GEN = 5n;

export const PRIME_2048 = BigInt(
  "0x" +
    "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050" +
    "A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50" +
    "E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8" +
    "55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B" +
    "CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748" +
    "544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6" +
    "AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6" +
    "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73",
);
export const PRIME_2048_GEN = 2n;

export interface SRPContextOptions {
  /**
   * "rfc5054" pads values to the length of N (HomeKit ADK behaviour). "srptools"
   * mimics the Python srptools library (values are not padded in x, K and M).
   */
  compat?: "rfc5054" | "srptools";
  /** Custom function for deriving session key from premaster secret. */
  sessionKey?: (ctx: SRPContext, premaster: bigint) => Buffer;
}

function bigIntToBytes(value: bigint, length?: number): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const raw = Buffer.from(hex, "hex");
  if (length === undefined || raw.length >= length) return raw;
  return Buffer.concat([Buffer.alloc(length - raw.length), raw]);
}

function bytesToBigInt(data: Uint8Array): bigint {
  return data.length === 0 ? 0n : BigInt("0x" + Buffer.from(data).toString("hex"));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

/** Shared SRP parameters and helper functions. */
export class SRPContext {
  readonly N: bigint;
  readonly g: bigint;
  readonly hashName: string;
  readonly padLength: number;

  readonly options: SRPContextOptions;

  constructor(
    readonly username: string,
    readonly password: string,
    prime: bigint = PRIME_3072,
    generator: bigint = PRIME_3072_GEN,
    hashName = "sha512",
    options: SRPContextOptions = {},
  ) {
    this.options = options;
    this.N = prime;
    this.g = generator;
    this.hashName = hashName;
    this.padLength = bigIntToBytes(prime).length;
  }

  pad(value: bigint): Buffer {
    return bigIntToBytes(value, this.padLength);
  }

  hash(...parts: Array<Uint8Array | string>): Buffer {
    const h = crypto.createHash(this.hashName);
    for (const part of parts) h.update(typeof part === "string" ? Buffer.from(part, "utf-8") : part);
    return h.digest();
  }

  /** k = H(N | PAD(g)) */
  get multiplier(): bigint {
    return bytesToBigInt(this.hash(bigIntToBytes(this.N), this.pad(this.g)));
  }

  private get srptools(): boolean {
    return this.options.compat === "srptools";
  }

  /** Bytes of an integer (padded unless in srptools mode). */
  private num(value: bigint): Buffer {
    return this.srptools ? bigIntToBytes(value) : this.pad(value);
  }

  private saltBytes(salt: Uint8Array): Buffer {
    return this.srptools ? bigIntToBytes(bytesToBigInt(salt)) : Buffer.from(salt);
  }

  /** x = H(s | H(I | ":" | P)) */
  passwordHash(salt: Uint8Array): bigint {
    return bytesToBigInt(this.hash(this.saltBytes(salt), this.hash(`${this.username}:${this.password}`)));
  }

  /** v = g^x % N */
  verifier(salt: Uint8Array): bigint {
    return modPow(this.g, this.passwordHash(salt), this.N);
  }

  /** u = H(PAD(A) | PAD(B)) */
  commonSecret(clientPublic: bigint, serverPublic: bigint): bigint {
    return bytesToBigInt(this.hash(this.pad(clientPublic), this.pad(serverPublic)));
  }

  /** K = H(PAD(S)) */
  sessionKey(premaster: bigint): Buffer {
    if (this.options.sessionKey) return this.options.sessionKey(this, premaster);
    return this.hash(this.num(premaster));
  }

  /** Bytes of premaster secret as used when hashing. */
  premasterBytes(premaster: bigint): Buffer {
    return this.num(premaster);
  }

  /** M = H(H(N) xor H(g), H(I), s, PAD(A), PAD(B), K) */
  keyProof(sessionKey: Uint8Array, salt: Uint8Array, clientPublic: bigint, serverPublic: bigint): Buffer {
    const hN = this.hash(bigIntToBytes(this.N));
    const hg = this.hash(bigIntToBytes(this.g));
    if (this.srptools) {
      const xored = bytesToBigInt(hN) ^ bytesToBigInt(hg);
      const hI = bytesToBigInt(this.hash(this.username));
      return this.hash(
        bigIntToBytes(xored),
        bigIntToBytes(hI),
        this.saltBytes(salt),
        bigIntToBytes(clientPublic),
        bigIntToBytes(serverPublic),
        sessionKey,
      );
    }
    const xored = Buffer.alloc(hN.length);
    for (let i = 0; i < hN.length; i++) xored[i] = hN[i]! ^ hg[i]!;
    return this.hash(xored, this.hash(this.username), salt, this.pad(clientPublic), this.pad(serverPublic), sessionKey);
  }

  /** H(PAD(A), M, K) */
  keyProofHash(clientPublic: bigint, keyProof: Uint8Array, sessionKey: Uint8Array): Buffer {
    return this.hash(this.num(clientPublic), keyProof, sessionKey);
  }

  generatePrivate(): bigint {
    return bytesToBigInt(crypto.randomBytes(32));
  }

  modPow(base: bigint, exponent: bigint): bigint {
    return modPow(base, exponent, this.N);
  }
}

/** SRP client session. */
export class SRPClientSession {
  readonly privateValue: bigint;
  readonly publicValue: bigint;
  private _key: Buffer | null = null;
  private _keyProof: Buffer | null = null;
  private _keyProofHash: Buffer | null = null;

  constructor(
    readonly context: SRPContext,
    privateValue?: Uint8Array | bigint,
  ) {
    this.privateValue =
      privateValue === undefined
        ? context.generatePrivate()
        : typeof privateValue === "bigint"
          ? privateValue
          : bytesToBigInt(privateValue);
    this.publicValue = context.modPow(context.g, this.privateValue);
  }

  /** Public value (A) as bytes. */
  get public(): Buffer {
    return this.context.options.compat === "srptools" ? bigIntToBytes(this.publicValue) : this.context.pad(this.publicValue);
  }

  /** Process server public value (B) and salt. */
  process(serverPublic: Uint8Array, salt: Uint8Array): void {
    const ctx = this.context;
    const B = bytesToBigInt(serverPublic);
    if (B % ctx.N === 0n) throw new Error("invalid server public value");
    const u = ctx.commonSecret(this.publicValue, B);
    const x = ctx.passwordHash(salt);
    const v = ctx.modPow(ctx.g, x);
    const k = ctx.multiplier;
    let base = (B - k * v) % ctx.N;
    if (base < 0n) base += ctx.N;
    const premaster = ctx.modPow(base, this.privateValue + u * x);
    this._key = ctx.sessionKey(premaster);
    this._keyProof = ctx.keyProof(this._key, salt, this.publicValue, B);
    this._keyProofHash = ctx.keyProofHash(this.publicValue, this._keyProof, this._key);
  }

  /** Session key (K). */
  get key(): Buffer {
    if (!this._key) throw new Error("session not processed");
    return this._key;
  }

  /** Client proof (M1). */
  get keyProof(): Buffer {
    if (!this._keyProof) throw new Error("session not processed");
    return this._keyProof;
  }

  /** Expected server proof (M2). */
  get keyProofHash(): Buffer {
    if (!this._keyProofHash) throw new Error("session not processed");
    return this._keyProofHash;
  }

  /** Verify server proof (M2). */
  verifyProof(serverProof: Uint8Array): boolean {
    return crypto.timingSafeEqual(this.keyProofHash, Buffer.from(serverProof));
  }
}

/** SRP server session. */
export class SRPServerSession {
  readonly privateValue: bigint;
  readonly publicValue: bigint;
  readonly verifier: bigint;
  private _key: Buffer | null = null;
  private _keyProof: Buffer | null = null;
  private _keyProofHash: Buffer | null = null;

  constructor(
    readonly context: SRPContext,
    readonly salt: Uint8Array,
    privateValue?: Uint8Array | bigint,
  ) {
    this.verifier = context.verifier(salt);
    this.privateValue =
      privateValue === undefined
        ? context.generatePrivate()
        : typeof privateValue === "bigint"
          ? privateValue
          : bytesToBigInt(privateValue);
    // B = k*v + g^b % N
    this.publicValue = (context.multiplier * this.verifier + context.modPow(context.g, this.privateValue)) % context.N;
  }

  /** Public value (B) as bytes. */
  get public(): Buffer {
    return this.context.pad(this.publicValue);
  }

  /** Process client public value (A). */
  process(clientPublic: Uint8Array): void {
    const ctx = this.context;
    const A = bytesToBigInt(clientPublic);
    if (A % ctx.N === 0n) throw new Error("invalid client public value");
    const u = ctx.commonSecret(A, this.publicValue);
    // S = (A * v^u) ^ b % N
    const premaster = ctx.modPow(A * ctx.modPow(this.verifier, u), this.privateValue);
    this._key = ctx.sessionKey(premaster);
    this._keyProof = ctx.keyProof(this._key, this.salt, A, this.publicValue);
    this._keyProofHash = ctx.keyProofHash(A, this._keyProof, this._key);
  }

  get key(): Buffer {
    if (!this._key) throw new Error("session not processed");
    return this._key;
  }

  /** Expected client proof (M1). */
  get keyProof(): Buffer {
    if (!this._keyProof) throw new Error("session not processed");
    return this._keyProof;
  }

  /** Server proof (M2). */
  get keyProofHash(): Buffer {
    if (!this._keyProofHash) throw new Error("session not processed");
    return this._keyProofHash;
  }

  /** Verify client proof (M1). */
  verifyProof(clientProof: Uint8Array): boolean {
    const proof = Buffer.from(clientProof);
    return proof.length === this.keyProof.length && crypto.timingSafeEqual(this.keyProof, proof);
  }
}
