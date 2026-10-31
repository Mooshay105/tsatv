/**
 * AirPlay server authentication code.
 *
 * NB: Only supports transient pairing used by some AirPlay 2 devices.
 */

import { hkdfExpand } from "../../auth/hap_srp.ts";
import { ErrorCode, readTlv, TlvValue, writeTlv } from "../../auth/hap_tlv8.ts";
import { PIN_CODE, PRIVATE_KEY, SERVER_IDENTIFIER } from "../../auth/server_auth.ts";
import * as chacha20 from "../../support/chacha20.ts";
import { X25519PublicKey } from "../../support/crypto.ts";
import { Float } from "../../support/float.ts";
import { HttpRequest, HttpResponse, HttpSimpleRouter } from "../../support/http.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import * as plistlib from "../../support/plistlib.ts";
import type { SRPServerSession } from "../../support/srp.ts";
import { generateKeys, newServerSession, type ServerKeys } from "../mrp/server_auth.ts";
import { TRANSIENT_PIN } from "./auth/hap_transient.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.server_auth");

export { generateKeys, newServerSession };

const byte = (value: number) => Buffer.from([value]);

const bodyBytes = (request: HttpRequest) =>
  Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, "utf-8");

/** Basic support for FairPlay authentication. */
export class PlayFair {
  static readonly MODE_POSITON = 14;
  static readonly TYPE_POSITION = 5;
  static readonly SEQ_POSITION = 6;
  static readonly SETUP_MESSAGE_TYPE = 1;
  static readonly SETUP1_MESSAGE_SEQ = 1;
  static readonly SETUP2_MESSAGE_SEQ = 3;
  static readonly SETUP2_RESPONSE_SUFFIX_LENGTH = 20;

  static readonly replyMessage = [
    "46504c59030102000000008202000f9f3f9e0a2521dbdf312ab2bfb29e8d232b6376a8c818701d22ae93d82737feaf9db4fdf41c2dba9d1f49caaabf6591ac1f7bc6f7e0663d21afe01565953eab81f418ceed095adb7c3d0e254909a79831d49c3982973434facb42c63a1cd911a6fe941a8a6d4a743b46c3a7649e44c78955e49d8155009549c4e2f7a3f6d5ba",
    "46504c5903010200000000820201cf32a25714b2524f8aa0ad7af164e37bcf4424e200047efc0ad67afcd95ded1c2730bb591b962ed63a9c4ded88ba8fc78de64d91ccfd5c7b56da88e31f5cceafc7431995a01665a54e1939d25b94db64b9e45d8d063e1e6af07e9656162b0efa404275ea5a44d9591c7256b9fbe6513898b80227721988571650942ad946688a",
    "46504c5903010200000000820202c169a352eeed35b18cdd9c58d64f16c1519a89eb5317bd0d4336cd68f638ff9d016a5b52b7fa9216b2b65482c78444118121a2c7fed83db7119e9182aad7d18c7063e2a457555910af9e0efc76347d164043807f581ee4fbe42ca9dedc1b5eb2a3aa3d2ecd59e7eee70b3629f22afd161d877353ddb99adc8e07006e56f850ce",
    "46504c59030102000000008202039001e1727e0f57f9f5880db104a6257a23f5cfff1abbe1e93045251afb97eb9fc0011ebe0f3a81df5b691d76acb2f7a5c708e3d328f56bb39dbde5f29c8a17f481487e3ae863c678325422e6f78e166d18aa7fd636258bce28726f661f738893ce44311e4be6c0535193e5ef72e8686233729c227d820c999445d89246c8c359",
  ].map((h) => Buffer.from(h.replace(/\s+/g, ""), "hex"));

  static readonly fpHeader = Buffer.from("46504c590301040000000014".replace(/\s+/g, ""), "hex");

  /** Generate response to FairPlay request. */
  fairplaySetup(request: Buffer): Buffer | number | null {
    if (request[4] !== 3) return -1; // Unsupported fairplay version

    const msgType = request[PlayFair.TYPE_POSITION];
    const seq = request[PlayFair.SEQ_POSITION];

    if (msgType === PlayFair.SETUP_MESSAGE_TYPE) {
      if (seq === PlayFair.SETUP1_MESSAGE_SEQ) {
        return PlayFair.replyMessage[request[PlayFair.MODE_POSITON]!]!;
      }
      if (seq === PlayFair.SETUP2_MESSAGE_SEQ) {
        return Buffer.concat([PlayFair.fpHeader, request.subarray(request.length - PlayFair.SETUP2_RESPONSE_SUFFIX_LENGTH)]);
      }
    }
    return null;
  }
}

/** Shared part of server-side implementation of AirPlay authentication. */
export abstract class BaseAirPlayServerAuth extends HttpSimpleRouter {
  static readonly keys: ServerKeys = generateKeys(PRIVATE_KEY);
  readonly uniqueId: Buffer;
  session: SRPServerSession | null = null;
  salt: Buffer | null = null;
  sharedKey: Buffer | null = null;
  inputKey: Buffer | null = null;
  outputKey: Buffer | null = null;

  constructor(
    readonly name: string,
    uniqueId: string = SERVER_IDENTIFIER,
    readonly pin: number = PIN_CODE,
  ) {
    super();
    this.uniqueId = Buffer.from(uniqueId);
    this.addRoute("POST", "^/pair-pin-start$", (r) => this.handlePairPinStart(r));
    this.addRoute("POST", "^/pair-setup$", (r) => this.handlePairSetup(r));
    this.addRoute("POST", "^/pair-verify$", (r) => this.handlePairVerify(r));
  }

  get keys(): ServerKeys {
    return BaseAirPlayServerAuth.keys;
  }

  handlePairPinStart(request: HttpRequest): HttpResponse {
    return new HttpResponse(request.protocol, request.version, 200, "OK", { CSeq: request.headers.get("CSeq", "1") }, Buffer.alloc(0));
  }

  handlePairSetup(request: HttpRequest): HttpResponse {
    const authVersion = request.headers.get("X-Apple-HKP");
    if (authVersion === "3") return this._handlePairSetup(request, false);
    if (authVersion === "4") return this._handlePairSetup(request, true);
    return new HttpResponse(
      request.protocol,
      request.version,
      501,
      "Not implemented",
      { CSeq: request.headers.get("CSeq", "1") },
      Buffer.alloc(0),
    );
  }

  private _handlePairSetup(request: HttpRequest, transient: boolean): HttpResponse {
    const pairingData = readTlv(bodyBytes(request));
    LOGGER.debug("Pair-setup message received: %s", pairingData);
    const seqno = pairingData.get(TlvValue.SeqNo)![0]!;
    const tlv = (this as any)[`_m${seqno}Setup`](pairingData, transient) as Buffer;
    return new HttpResponse(
      request.protocol,
      request.version,
      200,
      "OK",
      { CSeq: request.headers.get("CSeq", "1"), "Content-Type": "application/x-apple-binary-plist" },
      tlv,
    );
  }

  handlePairVerify(request: HttpRequest): HttpResponse {
    if (request.headers.get("X-Apple-HKP") !== "3") {
      return new HttpResponse(
        request.protocol,
        request.version,
        501,
        "Not implemented",
        { CSeq: request.headers.get("CSeq", "1") },
        Buffer.alloc(0),
      );
    }
    const pairingData = readTlv(bodyBytes(request));
    LOGGER.debug("Pair-verify message received: %s", pairingData);
    const seqno = pairingData.get(TlvValue.SeqNo)![0]!;
    const tlv = (this as any)[`_m${seqno}Verify`](pairingData) as Buffer;
    return new HttpResponse(
      request.protocol,
      request.version,
      200,
      "OK",
      { CSeq: request.headers.get("CSeq", "1"), "Content-Type": "application/octet-stream" },
      tlv,
    );
  }

  protected _m1Verify(pairingData: Map<number, Buffer>): Buffer {
    const serverPubKey = this.keys.verifyPub;
    const clientPubKey = pairingData.get(TlvValue.PublicKey)!;
    const sharedKey = this.keys.verify.exchange(X25519PublicKey.fromPublicBytes(clientPubKey));
    const sessionKey = hkdfExpand("Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info", sharedKey);

    const info = Buffer.concat([serverPubKey, this.uniqueId, clientPubKey]);
    const signature = this.keys.sign.sign(info);
    const tlv = writeTlv(
      new Map([
        [TlvValue.Identifier, this.uniqueId],
        [TlvValue.Signature, signature],
      ]),
    );
    const chacha = new chacha20.Chacha20Cipher8byteNonce(sessionKey, sessionKey);
    const encrypted = chacha.encrypt(tlv, Buffer.from("PV-Msg02"));

    this.sharedKey = sharedKey;
    this.inputKey = hkdfExpand("Control-Salt", "Control-Write-Encryption-Key", sharedKey);
    this.outputKey = hkdfExpand("Control-Salt", "Control-Read-Encryption-Key", sharedKey);
    logBinary(LOGGER, "Keys", { Output: this.outputKey, Input: this.inputKey });

    return writeTlv(
      new Map([
        [TlvValue.SeqNo, byte(0x02)],
        [TlvValue.PublicKey, serverPubKey],
        [TlvValue.EncryptedData, encrypted],
      ]),
    );
  }

  protected _m3Verify(_pairingData: Map<number, Buffer>): Buffer {
    this.enableEncryption(this.outputKey!, this.inputKey!);
    return writeTlv(new Map([[TlvValue.SeqNo, byte(0x04)]]));
  }

  protected _m1Setup(_pairingData: Map<number, Buffer>, transient: boolean): Buffer {
    [this.session, this.salt] = newServerSession(this.keys, String(transient ? TRANSIENT_PIN : this.pin));
    return writeTlv(
      new Map([
        [TlvValue.SeqNo, byte(0x02)],
        [TlvValue.Salt, this.salt],
        [TlvValue.PublicKey, this.session.public],
      ]),
    );
  }

  protected _m3Setup(pairingData: Map<number, Buffer>, transient: boolean): Buffer {
    const session = this.session!;
    session.process(pairingData.get(TlvValue.PublicKey)!);

    let tlv: Map<number, Buffer>;
    if (session.verifyProof(pairingData.get(TlvValue.Proof)!)) {
      tlv = new Map([
        [TlvValue.Proof, session.keyProofHash],
        [TlvValue.SeqNo, byte(0x04)],
      ]);
    } else {
      tlv = new Map([
        [TlvValue.Error, byte(ErrorCode.Authentication)],
        [TlvValue.SeqNo, byte(0x04)],
      ]);
    }

    if (transient) {
      this.sharedKey = session.key;
      this.inputKey = hkdfExpand("Control-Salt", "Control-Write-Encryption-Key", this.sharedKey);
      this.outputKey = hkdfExpand("Control-Salt", "Control-Read-Encryption-Key", this.sharedKey);
      this.enableEncryption(this.outputKey, this.inputKey);
      this.hasPaired();
    }
    return writeTlv(tlv);
  }

  protected _m5Setup(pairingData: Map<number, Buffer>, _transient: boolean): Buffer {
    const session = this.session!;
    const sessionKey = hkdfExpand("Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info", session.key);
    const accDeviceX = hkdfExpand("Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info", session.key);

    const chacha = new chacha20.Chacha20Cipher8byteNonce(sessionKey, sessionKey);
    const decrypted = chacha.decrypt(pairingData.get(TlvValue.EncryptedData)!, Buffer.from("PS-Msg05"));
    LOGGER.debug("MSG5 EncryptedData=%s", readTlv(decrypted));

    const deviceInfo = Buffer.concat([accDeviceX, this.uniqueId, this.keys.authPub]);
    const signature = this.keys.sign.sign(deviceInfo);

    const tlv = writeTlv(
      new Map([
        [TlvValue.Identifier, this.uniqueId],
        [TlvValue.PublicKey, this.keys.authPub],
        [TlvValue.Signature, signature],
      ]),
    );
    const encrypted = new chacha20.Chacha20Cipher8byteNonce(sessionKey, sessionKey).encrypt(tlv, Buffer.from("PS-Msg06"));

    this.hasPaired();
    return writeTlv(
      new Map([
        [TlvValue.SeqNo, byte(0x06)],
        [TlvValue.EncryptedData, encrypted],
      ]),
    );
  }

  /** Enable encryption with the specified keys. */
  abstract enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void;

  /** Call when a client has paired. */
  hasPaired(): void {}
}

/** Server-side implementation of AirPlay authentication. */
export abstract class AirPlayServerAuth extends BaseAirPlayServerAuth {
  constructor(name: string, uniqueId: string = SERVER_IDENTIFIER, pin: number = PIN_CODE) {
    super(name, uniqueId, pin);
    this.addRoute("GET", "^/info$", (r) => this.handleInfo(r));
    this.addRoute("OPTIONS", ".*", (r) => this.handleOptions(r));
    this.addRoute("POST", "^/fp-setup$", (r) => this.handleFpSetup(r));
  }

  handleOptions(request: HttpRequest): HttpResponse {
    return new HttpResponse(
      request.protocol,
      request.version,
      200,
      "OK",
      { CSeq: request.headers.get("CSeq", "1"), Public: "POST, GET, OPTIONS" },
      Buffer.alloc(0),
    );
  }

  handleFpSetup(request: HttpRequest): HttpResponse {
    const response = new PlayFair().fairplaySetup(bodyBytes(request));
    return new HttpResponse(
      request.protocol,
      request.version,
      200,
      "OK",
      { CSeq: request.headers.get("CSeq", "1") },
      Buffer.isBuffer(response) ? response : Buffer.alloc(0),
    );
  }

  handleInfo(request: HttpRequest): HttpResponse {
    LOGGER.debug("Sending AirPlay device info");
    const body = {
      psi: "dc0eccfd-f834-47d5-95ce-d8f41e2544f6",
      vv: 2,
      playbackCapabilities: {
        supportsInterstitials: false,
        supportsFPSSecureStop: false,
        supportsUIForAudioOnlyContent: false,
      },
      canRecordScreenStream: false,
      statusFlags: 4,
      keepAliveSendStatsAsBody: true,
      protocolVersion: "1.1",
      volumeControlType: 3,
      name: this.name,
      senderAddress: "10.0.10.254:45285",
      deviceID: "ff:ee:dd:cc:bb:aa",
      pi: "a1023589-a2ef-47de-8596-42f6fe5caacd",
      screenDemoMode: false,
      initialVolume: new Float(-27.0),
      featuresEx: "AMp/StBrbbb",
      supportedFormats: {
        lowLatencyAudioStream: 4398080065536,
        screenStream: 21235712,
        audioStream: 21235712,
        bufferStream: 1649282121728,
      },
      sourceVersion: "550.10",
      model: "AudioAccessory5,1",
      pk: Buffer.from("ab".repeat(32)),
      macAddress: "ff:ee:dd:cc:bb:aa",
      receiverHDRCapability: "4k60",
      features: "0x4A7FCA00,0x3C356BD0",
    };
    return new HttpResponse("RTSP", "1.0", 200, "OK", { CSeq: request.headers.get("CSeq", "1") }, plistlib.dumps(body));
  }
}
