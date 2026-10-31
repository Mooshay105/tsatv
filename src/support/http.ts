/** Module for working with HTTP requests. */

import { createHash } from "node:crypto";
import path from "node:path";
import { VERSION } from "../const.ts";
import { AuthenticationError, ConnectionLostError, HttpError, ProtocolError } from "../exceptions.ts";
import { CancelledError, Event, TimeoutError, Task, waitFor } from "./asyncio.ts";
import { logBinary } from "./index.ts";
import { getLogger } from "./logging.ts";
import { unusedPort } from "./net.ts";
import * as plistlib from "./plistlib.ts";
import { createConnection, createServer, type Protocol, type Server, type Transport } from "./transport.ts";

const LOGGER = getLogger("pyatv.support.http");

export const USER_AGENT = `pyatv/${VERSION}`;
export const SERVER_NAME = `pyatv-www/${VERSION}`;

// This timeout is rather long and that is for a reason. If a device is sleeping, it
// automatically wakes up when a service is requested from it. Up to 20 seconds or so
// have been seen. So to deal with that, keep this high.
export const DEFAULT_TIMEOUT = 25.0; // Seconds

export type DataProcessor = (data: Buffer) => Buffer;

const nullProcessor: DataProcessor = (data) => data;

// Username used for digest authentication with password protected AirPlay receivers
export const DIGEST_USERNAME = "AirPlay";

/** Parse realm and nonce from a WWW-Authenticate digest challenge. */
export function parseDigestChallenge(wwwAuthenticate: string): { realm: string; nonce: string } | null {
  const realm = /realm="([^"]*)"/i.exec(wwwAuthenticate)?.[1];
  const nonce = /nonce="([^"]*)"/i.exec(wwwAuthenticate)?.[1];
  if (realm === undefined || nonce === undefined) return null;
  return { realm, nonce };
}

const md5 = (text: string) => createHash("md5").update(text, "utf-8").digest("hex");

/** Return the Authorization payload for Apples OAuth. */
export function getDigestPayload(
  method: string,
  uri: string,
  user: string,
  realm: string,
  pwd: string,
  nonce: string,
): string {
  const ha1 = md5(`${user}:${realm}:${pwd}`);
  const ha2 = md5(`${method}:${uri}`);
  const diResponse = md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${diResponse}"`;
}


export type HeaderValue = string | number | boolean | bigint;
export type HeadersInit = Record<string, HeaderValue> | Map<string, HeaderValue> | HttpHeaders | null | undefined;

/**
 * Case insensitive headers (preserving original case of keys).
 *
 * Equivalent to requests.structures.CaseInsensitiveDict.
 */
export class HttpHeaders {
  private readonly store = new Map<string, [string, string]>();

  constructor(init?: HeadersInit | Iterable<[string, HeaderValue]>) {
    if (!init) return;
    const entries: Iterable<[string, HeaderValue]> =
      init instanceof HttpHeaders
        ? init.entries()
        : init instanceof Map
          ? init.entries()
          : Symbol.iterator in Object(init)
            ? (init as Iterable<[string, HeaderValue]>)
            : Object.entries(init as Record<string, HeaderValue>);
    for (const [key, value] of entries) this.set(key, value);
  }

  set(key: string, value: HeaderValue): void {
    this.store.set(key.toLowerCase(), [key, String(value)]);
  }

  get(key: string): string | undefined;
  get(key: string, defaultValue: string): string;
  get(key: string, defaultValue?: string): string | undefined {
    return this.store.get(key.toLowerCase())?.[1] ?? defaultValue;
  }

  has(key: string): boolean {
    return this.store.has(key.toLowerCase());
  }

  delete(key: string): boolean {
    return this.store.delete(key.toLowerCase());
  }

  get size(): number {
    return this.store.size;
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [key, value] of this.store.values()) yield [key, value];
  }

  *keys(): IterableIterator<string> {
    for (const [key] of this.store.values()) yield key;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.entries());
  }

  toString(): string {
    return JSON.stringify(this.toObject());
  }
}

export type HttpBody = string | Buffer | Record<string, unknown>;

function formatMessage(
  method: string,
  uri: string,
  protocol = "HTTP/1.1",
  userAgent: string = USER_AGENT,
  contentType: string | null = null,
  headers: HeadersInit = null,
  body: string | Uint8Array | null = null,
): Buffer {
  const encodedBody = typeof body === "string" ? Buffer.from(body, "utf-8") : body ? Buffer.from(body) : null;
  const hdrs = headers instanceof HttpHeaders ? headers : new HttpHeaders(headers);

  let msg = `${method} ${uri} ${protocol}`;
  if (!hdrs.has("User-Agent")) msg += `\r\nUser-Agent: ${userAgent}`;
  if (contentType) msg += `\r\nContent-Type: ${contentType}`;
  if (encodedBody && encodedBody.length > 0) msg += `\r\nContent-Length: ${encodedBody.length}`;
  for (const [key, value] of hdrs.entries()) msg += `\r\n${key}: ${value}`;
  msg += "\r\n\r\n";

  const output = Buffer.from(msg, "utf-8");
  return encodedBody && encodedBody.length > 0 ? Buffer.concat([output, encodedBody]) : output;
}

/** Generic HTTP response message. */
export class HttpResponse {
  readonly headers: HttpHeaders;

  constructor(
    readonly protocol: string,
    readonly version: string,
    readonly code: number,
    readonly message: string,
    headers: HeadersInit,
    readonly body: HttpBody,
  ) {
    this.headers = headers instanceof HttpHeaders ? headers : new HttpHeaders(headers);
  }

  toString(): string {
    const body =
      typeof this.body === "string"
        ? this.body
        : Buffer.isBuffer(this.body)
          ? `<${this.body.length} bytes>`
          : JSON.stringify(this.body);
    return `HttpResponse(protocol=${this.protocol}, version=${this.version}, code=${this.code}, message=${this.message}, headers=${this.headers}, body=${body})`;
  }
}

/** Generic HTTP request message. */
export class HttpRequest {
  readonly headers: HttpHeaders;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly protocol: string,
    readonly version: string,
    headers: HeadersInit,
    readonly body: string | Buffer,
  ) {
    this.headers = headers instanceof HttpHeaders ? headers : new HttpHeaders(headers);
  }

  toString(): string {
    return `HttpRequest(method=${this.method}, path=${this.path}, protocol=${this.protocol}, version=${this.version}, headers=${this.headers})`;
  }
}

const HEADER_END = Buffer.from("\r\n\r\n");

function parseHttpMessage(message: Buffer): [string | null, HttpHeaders, string | Buffer, Buffer] {
  const idx = message.indexOf(HEADER_END);
  if (idx === -1) return [null, new HttpHeaders(), Buffer.alloc(0), message];

  const headerStr = message.subarray(0, idx).toString("utf-8");
  const body = message.subarray(idx + 4);
  const lines = headerStr.split("\r\n");

  const msgHeaders = new HttpHeaders();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const sep = line.indexOf(": ");
    if (sep === -1) throw new RangeError(`bad header line: ${line}`);
    msgHeaders.set(line.slice(0, sep), line.slice(sep + 2));
  }

  const contentLength = parseInt(msgHeaders.get("Content-Length", "0"), 10);
  if (body.length < contentLength) return [null, new HttpHeaders(), Buffer.alloc(0), message];

  let msgBody: string | Buffer = Buffer.from(body.subarray(0, contentLength));

  // Assume body is text unless content type is application/octet-stream
  if (!msgHeaders.get("Content-Type", "").startsWith("application")) {
    const decoded = new TextDecoder("utf-8", { fatal: true });
    try {
      msgBody = decoded.decode(msgBody);
    } catch {
      // Keep as bytes
    }
  }

  return [lines[0]!, msgHeaders, msgBody, Buffer.from(body.subarray(contentLength))];
}

/** Encode HTTP response. */
export function formatResponse(response: HttpResponse): Buffer {
  const headers = response.headers;
  let output = `${response.protocol}/${response.version} ${response.code} ${response.message}\r\n`;
  if (!headers.has("Server")) output += `Server: ${SERVER_NAME}\r\n`;
  for (const [key, value] of headers.entries()) output += `${key}: ${value}\r\n`;

  let body: Buffer = Buffer.alloc(0);
  const raw = response.body;
  if (raw) {
    if (typeof raw === "string") body = Buffer.from(raw, "utf-8");
    else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) body = Buffer.from(raw);
    else body = plistlib.dumps(raw, plistlib.FMT_BINARY);
    if (body.length > 0) output += `Content-Length: ${body.length}\r\n`;
  }
  return Buffer.concat([Buffer.from(output, "utf-8"), Buffer.from("\r\n"), body]);
}

/** Parse HTTP response. Returns [response or null, remaining data]. */
export function parseResponse(response: Uint8Array): [HttpResponse | null, Buffer] {
  const [firstLine, msgHeaders, msgBody, rest] = parseHttpMessage(Buffer.from(response));
  if (firstLine === null) return [null, rest];

  const match = /^([^/]+)\/([0-9.]+) ([0-9]+) (.*)/.exec(firstLine);
  if (!match) throw new RangeError(`bad first line: ${firstLine}`);

  const [, protocol, version, code, message] = match;
  return [new HttpResponse(protocol!, version!, parseInt(code!, 10), message!, msgHeaders, msgBody), rest];
}

/** Encode HTTP request. */
export function formatRequest(request: HttpRequest): Buffer {
  return formatMessage(
    request.method,
    request.path,
    `${request.protocol}/${request.version}`,
    USER_AGENT,
    null,
    request.headers,
    request.body,
  );
}

/** Parse HTTP request. Returns [request or null, remaining data]. */
export function parseRequest(request: Uint8Array): [HttpRequest | null, Buffer] {
  const [firstLine, msgHeaders, msgBody, rest] = parseHttpMessage(Buffer.from(request));
  if (!firstLine) return [null, rest];

  const match = /^([A-Z_]+) ([^ ]+) ([^/]+)\/([0-9.]+)/.exec(firstLine);
  if (!match) throw new RangeError(`bad first line: ${firstLine}`);

  const [, method, reqPath, protocol, version] = match;
  return [new HttpRequest(method!, reqPath!, protocol!, version!, msgHeaders, msgBody), rest];
}

/** Decode a binary property list in a response. */
export function decodeBplistFromBody(response: HttpResponse | HttpRequest): Record<string, any> {
  const body = response.body;
  if (typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new ProtocolError(`expected bytes or str but got ${typeof body}`);
  }
  return plistlib.loads(typeof body === "string" ? Buffer.from(body, "utf-8") : body);
}

// --- Client session (aiohttp ClientSession replacement) ----------------------

export interface ClientResponse {
  status: number;
  headers: Headers;
  contentLength: number | null;
  read(): Promise<Buffer>;
}

/** Minimal HTTP client session based on fetch. */
export class ClientSession {
  closed = false;

  async request(
    method: string,
    url: string,
    options: {
      headers?: HeadersInit;
      data?: Uint8Array | string | null;
      timeout?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ClientResponse> {
    const headers: Record<string, string> = {};
    for (const [key, value] of new HttpHeaders(options.headers).entries()) headers[key] = value;
    const signals: AbortSignal[] = [];
    if (options.timeout) signals.push(AbortSignal.timeout(options.timeout * 1000));
    if (options.signal) signals.push(options.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.data ?? undefined,
        signal,
        // Many devices do not like keep-alive
        keepalive: false,
      });
    } catch (ex: any) {
      if (options.signal?.aborted) throw new CancelledError();
      if (ex?.name === "TimeoutError" || ex?.name === "AbortError") {
        throw new TimeoutError(`request to ${url} timed out`);
      }
      const err = new Error(String(ex?.message ?? ex));
      (err as any).code = ex?.code ?? "ECONNREFUSED";
      (err as any).cause = ex;
      throw err;
    }
    const length = response.headers.get("content-length");
    return {
      status: response.status,
      headers: response.headers,
      contentLength: length !== null ? parseInt(length, 10) : null,
      read: async () => {
        try {
          return Buffer.from(await response.arrayBuffer());
        } catch (ex: any) {
          if (options.signal?.aborted) throw new CancelledError();
          const err = new Error(String(ex?.message ?? ex));
          (err as any).code = ex?.code ?? "ECONNRESET";
          throw err;
        }
      },
    };
  }

  get(
    url: string,
    options: { headers?: HeadersInit; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<ClientResponse> {
    return this.request("GET", url, options);
  }

  post(
    url: string,
    options: { headers?: HeadersInit; data?: Uint8Array | string | null; timeout?: number } = {},
  ): Promise<ClientResponse> {
    return this.request("POST", url, options);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Manages a ClientSession instance. */
export class ClientSessionManager {
  constructor(
    private readonly _session: ClientSession,
    private readonly _shouldClose: boolean,
  ) {}

  /** Return client session. */
  get session(): ClientSession {
    return this._session;
  }

  /** Close session. */
  async close(): Promise<void> {
    if (this._shouldClose) await this._session.close();
  }
}

/** This class simplifies GET/POST requests. */
export class HttpSession {
  constructor(
    private readonly _session: ClientSession,
    public baseUrl: string,
  ) {}

  /** Perform a GET request (timeout 0 means no timeout). Returns [data, status]. */
  async getData(
    path: string,
    headers: HeadersInit = null,
    timeout: number = DEFAULT_TIMEOUT,
    signal?: AbortSignal,
  ): Promise<[Buffer, number]> {
    const url = this.baseUrl + path;
    LOGGER.debug("GET URL: %s", url);
    const resp = await this._session.get(url, { headers, timeout, signal });
    LOGGER.debug("Response: status=%d, headers=[%s]", resp.status, [...resp.headers.entries()]);
    let respData: Buffer = Buffer.alloc(0);
    if (resp.contentLength !== null) {
      respData = await resp.read();
      logBinary(LOGGER, "<< GET", { Data: respData });
    } else {
      await resp.read();
    }
    return [respData, resp.status];
  }

  /** Perform a POST request. Returns [data, status]. */
  async postData(
    path: string,
    data: Uint8Array | null = null,
    headers: HeadersInit = null,
    timeout: number = DEFAULT_TIMEOUT,
  ): Promise<[Buffer, number]> {
    const url = this.baseUrl + path;
    LOGGER.debug("POST URL: %s", url);
    logBinary(LOGGER, ">> POST", { Data: data });
    const resp = await this._session.post(url, { headers, data, timeout });
    LOGGER.debug("Response: status=%d, headers=[%s]", resp.status, [...resp.headers.entries()]);
    let respData: Buffer = Buffer.alloc(0);
    if (resp.contentLength !== null) {
      respData = await resp.read();
      logBinary(LOGGER, "<< POST", { Data: respData });
    } else {
      await resp.read();
    }
    return [respData, resp.status];
  }
}

// --- HTTP connection ----------------------------------------------------------

interface PendingRequest {
  event: Event;
  response: HttpResponse | null;
  connectionClosed: boolean;
  /** CSeq of the request (RTSP), used to match the response. */
  cseq: string | null;
  /** Time (ms) when the request timed out, null if still waiting. */
  timedOutAt: number | null;
}

/**
 * How long (ms) a timed out request is kept as a placeholder, so that a late response
 * to it is discarded instead of being delivered to the next request.
 */
export const TIMED_OUT_REQUEST_LIFETIME_MS = 60_000;

/** Representation of a HTTP connection. */
export class HttpConnection implements Protocol {
  transport: Transport | null = null;
  receiveProcessor: DataProcessor;
  sendProcessor: DataProcessor;
  private _localIp: string | null = null;
  private _remoteIp: string | null = null;
  private _requests: PendingRequest[] = [];
  private _buffer: Buffer = Buffer.alloc(0);

  /**
   * Optional provider of an Authorization header value, added to every request that
   * does not already have one (e.g. digest authentication for password protected
   * AirPlay receivers).
   */
  authorizationProvider: ((method: string, uri: string) => string) | null = null;

  /**
   * Password for password protected AirPlay receivers. When set and the receiver
   * answers a request with a digest challenge (401), digest authentication is set up
   * (see authorizationProvider) and the request is sent again.
   */
  password: string | null = null;

  constructor(receiveProcessor?: DataProcessor | null, sendProcessor?: DataProcessor | null) {
    this.receiveProcessor = receiveProcessor ?? nullProcessor;
    this.sendProcessor = sendProcessor ?? nullProcessor;
  }

  /** Return IP address of local interface. */
  get localIp(): string {
    if (this._localIp === null) throw new Error("not connected");
    return this._localIp;
  }

  /** Return IP address of remote instance. */
  get remoteIp(): string {
    if (this._remoteIp === null) throw new Error("not connected");
    return this._remoteIp;
  }

  /** Close HTTP connection. */
  close(): void {
    if (this.transport) {
      const transport = this.transport;
      this.transport = null;
      transport.close();
    }
    this._requests = [];
  }

  connectionMade(transport: Transport): void {
    this.transport = transport;
    this._localIp = transport.getExtraInfo("sockname")[0];
    this._remoteIp = transport.getExtraInfo("peername")[0];
    LOGGER.debug("Connected to %s", this.remoteIp);
  }

  dataReceived(data: Buffer): void {
    const processed = this.receiveProcessor(data);
    LOGGER.debug("Received: %s", processed);
    this._buffer = Buffer.concat([this._buffer, processed]);
    while (this._buffer.length > 0) {
      // Try to parse a complete response
      const [parsed, rest] = parseResponse(this._buffer);
      this._buffer = rest;
      if (parsed === null) {
        LOGGER.debug("Not enough data to decode message");
        break;
      }

      const pending = this._takePendingRequest(parsed);
      if (!pending) {
        LOGGER.warning("Got response without having a request: %s", parsed);
      } else if (pending.timedOutAt !== null) {
        LOGGER.debug("Discarding late response to timed out request: %s", parsed);
      } else {
        pending.response = parsed;
        pending.event.set();
      }
    }
  }

  // Find (and remove) the request a response belongs to. Responses with a CSeq (RTSP)
  // are matched on that, other responses go to the oldest request (HTTP/1.1 responses
  // arrive in request order).
  private _takePendingRequest(response: HttpResponse): PendingRequest | undefined {
    const now = Date.now();
    this._requests = this._requests.filter(
      (pending) => pending.timedOutAt === null || now - pending.timedOutAt < TIMED_OUT_REQUEST_LIFETIME_MS,
    );

    const cseq = response.headers.get("CSeq")?.trim();
    if (cseq !== undefined) {
      const idx = this._requests.findIndex((pending) => pending.cseq === cseq);
      if (idx >= 0) return this._requests.splice(idx, 1)[0];
      // Device answered with a CSeq we did not send, fall back to request order but
      // never hand it to a request that expects another CSeq
      const fallback = this._requests.findLastIndex((pending) => pending.cseq === null);
      return fallback >= 0 ? this._requests.splice(fallback, 1)[0] : undefined;
    }
    return this._requests.pop();
  }

  errorReceived(exc: unknown): void {
    LOGGER.error("Error received: %s", exc);
  }

  connectionLost(_exc: Error | null): void {
    LOGGER.debug("Connection closed");
    for (const pending of this._requests) {
      pending.connectionClosed = true;
      pending.event.set();
    }
    this._requests = [];
    this.transport = null;
  }

  /** Make a GET request and return response. */
  get(path: string, allowError = false): Promise<HttpResponse> {
    return this.sendAndReceive("GET", path, { allowError });
  }

  /** Make a POST request and return response. */
  post(
    path: string,
    options: { headers?: HeadersInit; body?: string | Uint8Array | null; allowError?: boolean } = {},
  ): Promise<HttpResponse> {
    return this.sendAndReceive("POST", path, options);
  }

  /** Send a HTTP message and return response. */
  async sendAndReceive(
    method: string,
    uri: string,
    options: {
      protocol?: string;
      userAgent?: string;
      contentType?: string | null;
      headers?: HeadersInit;
      body?: string | Uint8Array | null;
      allowError?: boolean;
      timeout?: number;
    } = {},
  ): Promise<HttpResponse> {
    const password = this.password;
    if (!password) return this._sendAndReceiveOnce(method, uri, options);

    const response = await this._sendAndReceiveOnce(method, uri, { ...options, allowError: true });
    const digest = response.code === 401 ? parseDigestChallenge(response.headers.get("WWW-Authenticate") ?? "") : null;
    if (digest === null) return this._checkResponse(method, protocolOf(options), response, options.allowError);

    LOGGER.debug("Receiver requires password, retrying %s %s with digest authentication", method, uri);
    this.authorizationProvider = (m, u) => getDigestPayload(m, u, DIGEST_USERNAME, digest.realm, password, digest.nonce);
    const headers = new HttpHeaders(options.headers);
    headers.delete("Authorization");
    return this._sendAndReceiveOnce(method, uri, { ...options, headers });
  }

  private async _sendAndReceiveOnce(
    method: string,
    uri: string,
    options: {
      protocol?: string;
      userAgent?: string;
      contentType?: string | null;
      headers?: HeadersInit;
      body?: string | Uint8Array | null;
      allowError?: boolean;
      timeout?: number;
    } = {},
  ): Promise<HttpResponse> {
    const protocol = protocolOf(options);
    const headers = new HttpHeaders(options.headers);
    if (this.authorizationProvider && !headers.has("Authorization")) {
      headers.set("Authorization", this.authorizationProvider(method, uri));
    }
    const output = formatMessage(
      method,
      uri,
      protocol,
      options.userAgent ?? USER_AGENT,
      options.contentType ?? null,
      headers,
      options.body ?? null,
    );

    LOGGER.debug("Sending %s message: %s", protocol, output);
    if (this.transport === null) throw new Error("not connected to remote");

    this.transport.write(this.sendProcessor(output));

    const pending: PendingRequest = {
      event: new Event(),
      response: null,
      connectionClosed: false,
      cseq: headers.get("CSeq")?.trim() ?? null,
      timedOutAt: null,
    };
    this._requests.unshift(pending);
    let response: HttpResponse;
    try {
      try {
        await waitFor(pending.event.wait(), options.timeout ?? 10);
      } catch (ex) {
        if (ex instanceof TimeoutError) {
          // Keep the request in the queue as a placeholder: if the response arrives
          // late it is discarded instead of being delivered to the next request
          pending.timedOutAt = Date.now();
          throw new TimeoutError(`no response to ${method} ${uri} (${protocol})`);
        }
        throw ex;
      }

      if (pending.connectionClosed) throw new ConnectionLostError("connection was lost");
      if (pending.response === null) throw new Error("did not get a response");
      response = pending.response;
    } finally {
      // If request failed and event is still in request queue, remove it (unless it is
      // kept as a placeholder for a timed out request)
      if (pending.timedOutAt === null) {
        const idx = this._requests.indexOf(pending);
        if (idx >= 0) this._requests.splice(idx, 1);
      }
    }

    LOGGER.debug("Got %s response: %s:", response.protocol, response);
    return this._checkResponse(method, protocol, response, options.allowError);
  }

  /** Return response if it is positive (or errors are allowed), otherwise throw. */
  private _checkResponse(method: string, protocol: string, response: HttpResponse, allowError = false): HttpResponse {
    if (response.code === 403) throw new AuthenticationError("not authenticated");

    // Password required
    if (response.code === 401) {
      if (allowError) return response;
      throw new AuthenticationError("not authenticated");
    }

    // Positive response
    if ((response.code >= 200 && response.code < 300) || allowError) return response;

    throw new HttpError(
      `${protocol} method ${method} failed with code ${response.code}: ${response.message}`,
      response.code,
    );
  }
}

function protocolOf(options: { protocol?: string }): string {
  return options.protocol ?? "HTTP/1.1";
}

// --- HTTP server ----------------------------------------------------------------

export type HandlerResult =
  | HttpResponse
  | Task<HttpResponse>
  | Task<HttpResponse | null>
  | Promise<HttpResponse | null>
  | null
  | undefined;

/** Abstract base class for handling HTTP requests. */
export interface AbstractHttpServerHandler {
  handleRequest(request: HttpRequest): HandlerResult;
}

/** Simple router that routes method and path to handler function. */
export class HttpSimpleRouter implements AbstractHttpServerHandler {
  private readonly _routes = new Map<string, Map<string, (request: HttpRequest) => HandlerResult>>();

  /** Add new handler to route. */
  addRoute(method: string, path: string, target: (request: HttpRequest) => HandlerResult): void {
    let routes = this._routes.get(method);
    if (!routes) {
      routes = new Map();
      this._routes.set(method, routes);
    }
    routes.set(path, target);
  }

  /** Dispatch request to correct handler method. */
  handleRequest(request: HttpRequest): HandlerResult {
    for (const [routePath, target] of this._routes.get(request.method) ?? []) {
      if (new RegExp("^(?:" + routePath + ")").test(request.path)) {
        return target(request);
      }
    }
    return null;
  }
}

/** Super basic HTTP server. */
export class BasicHttpServer implements Protocol {
  transport: Transport | null = null;
  private _requestBuffer: Buffer = Buffer.alloc(0);

  constructor(public handler: AbstractHttpServerHandler) {}

  connectionMade(transport: Transport): void {
    LOGGER.debug("Connection from %s", transport.getExtraInfo("peername"));
    this.transport = transport;
  }

  dataReceived(data: Buffer): void {
    LOGGER.debug("Received: %s", data);
    const processed = this.processReceived(data);

    // Process all requests in packet
    this._requestBuffer = Buffer.concat([this._requestBuffer, processed]);
    while (this._requestBuffer.length > 0) {
      const rest = this._parseAndSendNext(this._requestBuffer);
      if (rest === this._requestBuffer) break;
      this._requestBuffer = rest;
    }
  }

  connectionLost(_exc: Error | null): void {
    this.transport = null;
  }

  /** Process incoming data. */
  processReceived(data: Buffer): Buffer {
    return data;
  }

  /** Process outgoing data. */
  processSent(data: Buffer): Buffer {
    return data;
  }

  private _parseAndSendNext(data: Buffer): Buffer {
    let resp: HandlerResult = null;
    let rest: Buffer = Buffer.alloc(0);
    try {
      const [request, remaining] = parseRequest(data);
      if (!request) return data;
      rest = remaining;
      resp = this.handler.handleRequest(request);
    } catch (ex) {
      LOGGER.error("failed to process request: %s", ex);
      resp = new HttpResponse("HTTP", "1.1", 500, "Internal server error", {}, String((ex as Error)?.message ?? ex));
    }

    if (!resp) {
      resp = new HttpResponse("HTTP", "1.1", 404, "File not found", {}, "Not found");
    }

    if (resp instanceof HttpResponse) {
      this._sendResponse(resp);
    } else {
      Promise.resolve(resp instanceof Task ? (resp.promise as Promise<HttpResponse | null>) : resp).then(
        (response) => {
          if (response) this._sendResponse(response);
        },
        (ex) => LOGGER.error("request handler failed: %s", ex),
      );
    }
    return rest;
  }

  private _sendResponse(resp: HttpResponse): void {
    if (this.transport) {
      this.transport.write(this.processSent(formatResponse(resp)));
    }
  }
}

/** Web server serving only a single file. */
export class StaticFileWebServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  readonly path: string;

  constructor(
    fileToServe: string,
    private readonly _address: string,
    private _port: number | null = null,
  ) {
    this.path = path.resolve(fileToServe);
  }

  /** Start the web server. */
  async start(): Promise<void> {
    if (!this._port) this._port = unusedPort();
    LOGGER.debug("Starting AirPlay file server on port %d", this._port);
    const name = path.basename(this.path);
    const filePath = this.path;
    this.server = Bun.serve({
      hostname: this._address,
      port: this._port,
      fetch(req) {
        const url = new URL(req.url);
        if (decodeURIComponent(url.pathname) === `/${name}`) {
          return new Response(Bun.file(filePath));
        }
        return new Response("Permission denied", { status: 401 });
      },
    });
  }

  /** Stop the web server and free resources. */
  async close(): Promise<void> {
    LOGGER.debug("Closing local AirPlay web server");
    this.server?.stop(true);
    this.server = null;
  }

  /** Address to the file being served. */
  get fileAddress(): string {
    return `http://${this._address}:${this._port}/${path.basename(this.path)}`;
  }
}

/** Open connection to a remote host. */
export async function httpConnect(address: string, port: number): Promise<HttpConnection> {
  const [, connection] = await createConnection(() => new HttpConnection(), address, port);
  return connection;
}

/** Set up a new basic HTTP server. Returns [server, port]. */
export async function httpServer(
  serverFactory: () => BasicHttpServer,
  address = "127.0.0.1",
  port = 0,
): Promise<[Server, number]> {
  const server = await createServer(serverFactory, address, port);
  return [server, server.port];
}

/** Create ClientSession managed by pyatv. */
export async function createSession(session?: ClientSession | null): Promise<ClientSessionManager> {
  return new ClientSessionManager(session ?? new ClientSession(), !session);
}
