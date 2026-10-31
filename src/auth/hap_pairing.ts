/** Abstraction for authentication based on HAP/SRP. */

import { InvalidCredentialsError } from "../exceptions.ts";

/** Supported authentication type. */
export enum AuthenticationType {
  /** No authentication (just pass through). */
  Null = 1,
  /** Legacy SRP based authentication. */
  Legacy = 2,
  /** Authentication based on HAP (Home-Kit). */
  HAP = 3,
  /** Authentication based on transient HAP (Home-Kit). */
  Transient = 4,
}

const TRANSIENT = Buffer.from("transient");

/** Identifiers and encryption keys used by HAP. */
export class HapCredentials {
  readonly ltpk: Buffer;
  readonly ltsk: Buffer;
  readonly atvId: Buffer;
  readonly clientId: Buffer;
  readonly type: AuthenticationType;

  constructor(
    ltpk: Uint8Array = Buffer.alloc(0),
    ltsk: Uint8Array = Buffer.alloc(0),
    atvId: Uint8Array = Buffer.alloc(0),
    clientId: Uint8Array = Buffer.alloc(0),
  ) {
    this.ltpk = Buffer.from(ltpk);
    this.ltsk = Buffer.from(ltsk);
    this.atvId = Buffer.from(atvId);
    this.clientId = Buffer.from(clientId);
    this.type = this._getAuthType();
  }

  private _getAuthType(): AuthenticationType {
    const empty = (b: Buffer) => b.length === 0;
    if (empty(this.ltpk) && empty(this.ltsk) && empty(this.atvId) && empty(this.clientId)) {
      return AuthenticationType.Null;
    }
    if (this.ltpk.equals(TRANSIENT)) return AuthenticationType.Transient;
    if (empty(this.ltpk) && !empty(this.ltsk) && empty(this.atvId) && !empty(this.clientId)) {
      return AuthenticationType.Legacy;
    }
    if (!empty(this.ltpk) && !empty(this.ltsk) && !empty(this.atvId) && !empty(this.clientId)) {
      return AuthenticationType.HAP;
    }
    throw new InvalidCredentialsError("invalid credentials type");
  }

  /** Return if two instances of HapCredentials are equal. */
  equals(other: unknown): boolean {
    return other instanceof HapCredentials && String(other) === String(this);
  }

  /** Return a string representation of credentials. */
  toString(): string {
    return [this.ltpk, this.ltsk, this.atvId, this.clientId].map((b) => b.toString("hex")).join(":");
  }
}

/** Perform pair setup procedure to authenticate a new device. */
export interface PairSetupProcedure {
  /** Start the pairing process. This method will show the expected PIN on screen. */
  startPairing(): Promise<void>;

  /** Finish pairing process. A username and the PIN code must be provided. */
  finishPairing(username: string, pinCode: number | string, displayName: string | null): Promise<HapCredentials>;
}

/** Verify if credentials are valid and derive encryption keys. */
export interface PairVerifyProcedure {
  /** Verify if credentials are valid and returns true if keys are generated. */
  verifyCredentials(): Promise<boolean>;

  /** Return derived encryption keys. */
  encryptionKeys(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer];

  /**
   * Return the shared secret that encryptionKeys derives keys from (optional, only
   * implemented by procedures that have one).
   */
  sharedSecret?(): Buffer;
}

export const NO_CREDENTIALS = new HapCredentials();
export const TRANSIENT_CREDENTIALS = new HapCredentials(TRANSIENT);

function unhexlify(text: string): Buffer {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new InvalidCredentialsError("invalid credentials: bad hex data");
  }
  return Buffer.from(text, "hex");
}

/** Parse a string representation of HapCredentials. */
export function parseCredentials(detailString: string | null | undefined): HapCredentials {
  if (detailString === null || detailString === undefined) return NO_CREDENTIALS;

  const split = detailString.split(":");

  // Compatibility with "legacy credentials" used by AirPlay where seed is stored
  // as LTSK and identifier as client_id (others are empty).
  if (split.length === 2) {
    const clientId = unhexlify(split[0]!);
    const ltsk = unhexlify(split[1]!);
    return new HapCredentials(Buffer.alloc(0), ltsk, Buffer.alloc(0), clientId);
  }
  if (split.length === 4) {
    return new HapCredentials(unhexlify(split[0]!), unhexlify(split[1]!), unhexlify(split[2]!), unhexlify(split[3]!));
  }

  throw new InvalidCredentialsError("invalid credentials: " + detailString);
}
