/**
 * asyncio-like Protocol/Transport abstraction on top of node:net and node:dgram.
 *
 * Much of pyatv is written with asyncio protocols (connection_made, data_received,
 * connection_lost). This module makes it possible to keep that structure.
 */

import dgram from "node:dgram";
import net from "node:net";
import { getLogger } from "./logging.ts";

const LOGGER = getLogger("pyatv.support.transport");

export type Address = [string, number];

export interface Transport {
  write(data: Uint8Array | string): void;
  close(): void;
  isClosing(): boolean;
  getExtraInfo(name: string, defaultValue?: unknown): any;
}

export interface Protocol {
  connectionMade?(transport: Transport): void;
  dataReceived?(data: Buffer): void;
  eofReceived?(): void;
  connectionLost?(exc: Error | null): void;
}

class SocketTransport implements Transport {
  private _closing = false;
  constructor(readonly socket: net.Socket) {}

  write(data: Uint8Array | string): void {
    if (this._closing || this.socket.destroyed) return;
    this.socket.write(typeof data === "string" ? Buffer.from(data) : data);
  }

  close(): void {
    if (this._closing) return;
    this._closing = true;
    this.socket.end();
    // Make sure socket is fully torn down even if remote does not close
    setTimeout(() => this.socket.destroy(), 100).unref?.();
  }

  abort(): void {
    this._closing = true;
    this.socket.destroy();
  }

  isClosing(): boolean {
    return this._closing || this.socket.destroyed;
  }

  getExtraInfo(name: string, defaultValue?: unknown): any {
    switch (name) {
      case "sockname":
        return [stripV6(this.socket.localAddress ?? ""), this.socket.localPort ?? 0];
      case "peername":
        return [stripV6(this.socket.remoteAddress ?? ""), this.socket.remotePort ?? 0];
      case "socket":
        return this.socket;
      default:
        return defaultValue;
    }
  }
}

function stripV6(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function attach(socket: net.Socket, protocol: Protocol, transport: SocketTransport): void {
  let lost = false;
  let error: Error | null = null;
  socket.on("data", (data: Buffer) => {
    try {
      protocol.dataReceived?.(data);
    } catch (ex) {
      LOGGER.error("Exception in data_received: %s", ex);
      LOGGER.debug("%s", (ex as Error)?.stack ?? "");
    }
  });
  socket.on("end", () => {
    try {
      protocol.eofReceived?.();
    } catch (ex) {
      LOGGER.error("Exception in eof_received: %s", ex);
    }
  });
  socket.on("error", (err) => {
    error = err;
  });
  socket.on("close", () => {
    if (lost) return;
    lost = true;
    try {
      protocol.connectionLost?.(error);
    } catch (ex) {
      LOGGER.error("Exception in connection_lost: %s", ex);
    }
  });
  void transport;
}

/** Open a TCP connection (equivalent of loop.create_connection). */
export function createConnection<P extends Protocol>(
  factory: () => P,
  host: string,
  port: number,
  options: { timeout?: number; localAddress?: string } = {},
): Promise<[Transport, P]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, localAddress: options.localAddress });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timer = setTimeout(() => {
        socket.destroy();
        const err = new Error(`connect to ${host}:${port} timed out`);
        (err as any).code = "ETIMEDOUT";
        reject(err);
      }, options.timeout * 1000);
    }
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.setNoDelay(true);
      const protocol = factory();
      const transport = new SocketTransport(socket);
      attach(socket, protocol, transport);
      try {
        protocol.connectionMade?.(transport);
      } catch (ex) {
        socket.destroy();
        reject(ex);
        return;
      }
      resolve([transport, protocol]);
    });
  });
}

/** A listening TCP server. */
export class Server {
  readonly connections = new Set<net.Socket>();
  constructor(readonly server: net.Server) {}

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  get address(): string {
    const address = this.server.address();
    return typeof address === "object" && address ? address.address : "";
  }

  /** Mimic asyncio's server.sockets[0].getsockname(). */
  get sockets(): Array<{ getsockname(): Address }> {
    return [{ getsockname: () => [this.address, this.port] }];
  }

  close(): void {
    this.server.close();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
  }

  async waitClosed(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server.listening) resolve();
      else this.server.once("close", () => resolve());
    });
  }
}

/** Create TCP server (equivalent of loop.create_server). */
export function createServer(factory: () => Protocol, host = "127.0.0.1", port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const wrapper = new Server(server);
    server.on("connection", (socket) => {
      socket.setNoDelay(true);
      wrapper.connections.add(socket);
      socket.on("close", () => wrapper.connections.delete(socket));
      const protocol = factory();
      const transport = new SocketTransport(socket);
      attach(socket, protocol, transport);
      try {
        protocol.connectionMade?.(transport);
      } catch (ex) {
        LOGGER.error("Exception in connection_made: %s", ex);
        socket.destroy();
      }
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(wrapper);
    });
  });
}

// --- Datagram -----------------------------------------------------------------

export interface DatagramTransport {
  sendto(data: Uint8Array, addr?: Address | null): void;
  close(): void;
  isClosing(): boolean;
  getExtraInfo(name: string, defaultValue?: unknown): any;
}

export interface DatagramProtocol {
  connectionMade?(transport: DatagramTransport): void;
  datagramReceived?(data: Buffer, addr: Address): void;
  errorReceived?(exc: Error): void;
  connectionLost?(exc: Error | null): void;
}

class UdpTransport implements DatagramTransport {
  private _closing = false;
  constructor(
    readonly socket: dgram.Socket,
    private readonly remote: Address | null,
  ) {}

  sendto(data: Uint8Array, addr?: Address | null): void {
    if (this._closing) return;
    const target = addr ?? this.remote;
    if (!target) throw new Error("no destination address");
    this.socket.send(data, target[1], target[0], (err) => {
      if (err) LOGGER.debug("Failed to send datagram to %s:%d: %s", target[0], target[1], err);
    });
  }

  close(): void {
    if (this._closing) return;
    this._closing = true;
    try {
      this.socket.close();
    } catch {
      // Already closed
    }
  }

  isClosing(): boolean {
    return this._closing;
  }

  getExtraInfo(name: string, defaultValue?: unknown): any {
    if (name === "sockname") {
      const address = this.socket.address();
      return [address.address, address.port];
    }
    if (name === "peername") return this.remote;
    if (name === "socket") return this.socket;
    return defaultValue;
  }
}

export interface DatagramEndpointOptions {
  localAddr?: Address | null;
  remoteAddr?: Address | null;
  sock?: dgram.Socket;
  reuseAddr?: boolean;
}

/** Create a datagram endpoint (equivalent of loop.create_datagram_endpoint). */
export async function createDatagramEndpoint<P extends DatagramProtocol>(
  factory: () => P,
  options: DatagramEndpointOptions = {},
): Promise<[DatagramTransport, P]> {
  let socket = options.sock;
  if (!socket) {
    socket = dgram.createSocket({ type: "udp4", reuseAddr: options.reuseAddr ?? false });
    const local = options.localAddr ?? ["0.0.0.0", 0];
    await new Promise<void>((resolve, reject) => {
      socket!.once("error", reject);
      socket!.bind(local[1], local[0], () => {
        socket!.off("error", reject);
        resolve();
      });
    });
  }
  const protocol = factory();
  const transport = new UdpTransport(socket, options.remoteAddr ?? null);
  socket.on("message", (msg, rinfo) => {
    try {
      protocol.datagramReceived?.(msg, [rinfo.address, rinfo.port]);
    } catch (ex) {
      LOGGER.error("Exception in datagram_received: %s", ex);
    }
  });
  socket.on("error", (err) => protocol.errorReceived?.(err));
  socket.on("close", () => protocol.connectionLost?.(null));
  protocol.connectionMade?.(transport);
  return [transport, protocol];
}

// --- Streams ------------------------------------------------------------------

/** Minimal StreamReader (asyncio.StreamReader equivalent). */
export class StreamReader {
  private buffer = Buffer.alloc(0);
  private eof = false;
  private waiter: (() => void) | null = null;
  private error: Error | null = null;

  feedData(data: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.wake();
  }

  feedEof(): void {
    this.eof = true;
    this.wake();
  }

  setException(error: Error): void {
    this.error = error;
    this.wake();
  }

  atEof(): boolean {
    return this.eof && this.buffer.length === 0;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private async waitForData(): Promise<void> {
    if (this.error) throw this.error;
    await new Promise<void>((resolve) => (this.waiter = resolve));
    if (this.error) throw this.error;
  }

  /** Read up to n bytes (-1 reads until EOF). */
  async read(n = -1): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    if (n < 0) {
      while (!this.eof) await this.waitForData();
      const out = this.buffer;
      this.buffer = Buffer.alloc(0);
      return out;
    }
    while (this.buffer.length === 0 && !this.eof) await this.waitForData();
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(out.length);
    return Buffer.from(out);
  }

  async readexactly(n: number): Promise<Buffer> {
    while (this.buffer.length < n) {
      if (this.eof) throw new Error("IncompleteReadError");
      await this.waitForData();
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return Buffer.from(out);
  }

  async readuntil(separator: Uint8Array | string = "\n"): Promise<Buffer> {
    const sep = typeof separator === "string" ? Buffer.from(separator) : Buffer.from(separator);
    for (;;) {
      const idx = this.buffer.indexOf(sep);
      if (idx >= 0) {
        const out = this.buffer.subarray(0, idx + sep.length);
        this.buffer = this.buffer.subarray(idx + sep.length);
        return Buffer.from(out);
      }
      if (this.eof) throw new Error("IncompleteReadError");
      await this.waitForData();
    }
  }

  async readline(): Promise<Buffer> {
    try {
      return await this.readuntil("\n");
    } catch {
      const out = this.buffer;
      this.buffer = Buffer.alloc(0);
      return out;
    }
  }
}

/** Minimal StreamWriter. */
export class StreamWriter {
  constructor(readonly transport: Transport) {}

  write(data: Uint8Array | string): void {
    this.transport.write(data);
  }

  async drain(): Promise<void> {}

  close(): void {
    this.transport.close();
  }

  async waitClosed(): Promise<void> {}

  getExtraInfo(name: string): any {
    return this.transport.getExtraInfo(name);
  }
}

/** Open a stream connection (asyncio.open_connection equivalent). */
export async function openConnection(host: string, port: number): Promise<[StreamReader, StreamWriter]> {
  const reader = new StreamReader();
  const [transport] = await createConnection(
    () => ({
      dataReceived: (data: Buffer) => reader.feedData(data),
      eofReceived: () => reader.feedEof(),
      connectionLost: (exc: Error | null) => {
        if (exc) reader.setException(exc);
        else reader.feedEof();
      },
    }),
    host,
    port,
  );
  return [reader, new StreamWriter(transport)];
}
