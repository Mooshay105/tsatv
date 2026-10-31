/** Minimal web application used by fake devices (aiohttp web.Application replacement). */

import http from "node:http";
import type { Socket } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  socket: Socket;
  match: RegExpExecArray;
}

export interface FakeResponse {
  status?: number;
  body?: Buffer | string | null;
  headers?: Record<string, string>;
}

export type FakeHandler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse> | null | Promise<null>;

/** Simple router + HTTP server. */
export class WebApp {
  private readonly routes: Array<{ method: string; path: RegExp; handler: FakeHandler }> = [];
  private server: http.Server | null = null;
  port = 0;
  readonly onStartup: Array<() => Promise<void>> = [];

  addRoute(method: string, path: string | RegExp, handler: FakeHandler): void {
    const regex = typeof path === "string" ? new RegExp("^" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") : path;
    this.routes.push({ method, path: regex, handler });
  }

  addGet(path: string | RegExp, handler: FakeHandler): void {
    this.addRoute("GET", path, handler);
  }

  addPost(path: string | RegExp, handler: FakeHandler): void {
    this.addRoute("POST", path, handler);
  }

  addPut(path: string | RegExp, handler: FakeHandler): void {
    this.addRoute("PUT", path, handler);
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(port = 0, host = "127.0.0.1"): Promise<void> {
    for (const hook of this.onStartup) await hook();
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";
        for (const route of this.routes) {
          const match = route.path.exec(url.pathname);
          if (route.method !== method || !match) continue;
          try {
            const response = await route.handler({
              method,
              path: url.pathname,
              query: url.searchParams,
              headers: req.headers,
              body: Buffer.concat(chunks),
              socket: req.socket,
              match,
            });
            if (response === null) return; // Handler took care of response (or closed socket)
            const body = response.body ?? Buffer.alloc(0);
            res.writeHead(response.status ?? 200, {
              "Content-Length": String(Buffer.byteLength(body)),
              ...(response.headers ?? {}),
            });
            res.end(body);
          } catch (ex) {
            if (!res.headersSent) {
              res.writeHead(500);
              res.end(String(ex));
            }
          }
          return;
        }
        res.writeHead(404);
        res.end("Not found");
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
