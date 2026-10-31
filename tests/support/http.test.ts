/** Unit tests for pyatv.support.http. */

import { expect, spyOn, test } from "bun:test";
import net from "node:net";
import { AuthenticationError, ConnectionLostError } from "../../src/exceptions.ts";
import { createTask, Event } from "../../src/support/asyncio.ts";
import {
  BasicHttpServer,
  formatRequest,
  formatResponse,
  getDigestPayload,
  type HandlerResult,
  HttpConnection,
  httpConnect,
  HttpRequest,
  HttpResponse,
  httpServer,
  HttpSimpleRouter,
  parseRequest,
  parseResponse,
  SERVER_NAME,
  USER_AGENT,
} from "../../src/support/http.ts";
import { createConnection } from "../../src/support/transport.ts";
import { b } from "../utils.ts";

// HTTP MESSAGE PARSING

test("parse response ok first line", () => {
  const [resp, rest] = parseResponse(b("HTTP/1.0 200 OK\r\n\r\n"));
  expect(resp!.code).toBe(200);
  expect(resp!.message).toBe("OK");
  expect(rest).toEqual(b(""));
});

test("parse response missing ending", () => {
  expect(parseResponse(b("HTTP/1.0 200 OK\r\n"))).toEqual([null, b("HTTP/1.0 200 OK\r\n")]);
});

test("parse response headers", () => {
  const [resp, rest] = parseResponse(b("HTTP/1.0 200 OK\r\nA: B\r\nC: D\r\n\r\n"));
  expect(resp!.headers.size).toBe(2);
  expect(resp!.headers.get("A")).toBe("B");
  expect(resp!.headers.get("C")).toBe("D");
  expect(rest).toEqual(b(""));
});

test("parse response body", () => {
  const [resp, rest] = parseResponse(b("HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nbody"));
  expect(resp!.body).toBe("body");
  expect(rest).toEqual(b(""));
});

test("parse response too no body", () => {
  const content = b("HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\n");
  const [resp, rest] = parseResponse(content);
  expect(resp).toBeNull();
  expect(rest).toEqual(content);
});

test("parse response too short body", () => {
  const content = b("HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nbody");
  const [resp, rest] = parseResponse(content);
  expect(resp).toBeNull();
  expect(rest).toEqual(content);
});

test("parse response body excessive data", () => {
  const [resp, rest] = parseResponse(b("HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nbodyextra"));
  expect(resp!.body).toBe("body");
  expect(rest).toEqual(b("extra"));
});

test("parse response sequent messages", () => {
  let [resp, rest] = parseResponse(
    b(
      "HTTP/1.0 200 OK\r\nA: B\r\n\r\n" +
        "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nAB" +
        "HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n",
    ),
  );
  expect(resp!.headers.get("A")).toBe("B");
  expect(resp!.body).toBe("");

  [resp, rest] = parseResponse(rest);
  expect(resp!.body).toBe("AB");

  [resp, rest] = parseResponse(rest);
  expect(resp!.headers.get("Content-Length")).toBe("0");
  expect(resp!.body).toBe("");
  expect(rest).toEqual(b(""));
});

test("parse response application type as bytes", () => {
  const [resp, rest] = parseResponse(
    b("HTTP/1.0 200 OK\r\nContent-Length: 4\r\nContent-Type: application/something\r\n\r\nbodyextra"),
  );
  expect(resp!.body).toEqual(b("body"));
  expect(rest).toEqual(b("extra"));
});

test("parse response arbitrary protocol header", () => {
  const [resp] = parseResponse(b("FOO/3.14 200 OK\r\n\r\n"));
  expect(resp!.protocol).toBe("FOO");
  expect(resp!.version).toBe("3.14");
});

test("parse response ignore header case", () => {
  const [resp, rest] = parseResponse(
    b("HTTP/1.0 200 OK\r\nCONTENT-lEnGtH: 4\r\ncontent-TYPE: application/something\r\n\r\nbodyextra"),
  );
  expect(resp!.body).toEqual(b("body"));
  expect(rest).toEqual(b("extra"));
});

test.each([
  [new HttpResponse("HTTP", "1.1", 200, "OK", {}, b("")), `HTTP/1.1 200 OK\r\nServer: ${SERVER_NAME}\r\n\r\n`],
  [new HttpResponse("FOO", "3.14", 200, "OK", {}, b("")), `FOO/3.14 200 OK\r\nServer: ${SERVER_NAME}\r\n\r\n`],
  [
    new HttpResponse("HTTP", "1.1", 404, "Not Found", {}, b("")),
    `HTTP/1.1 404 Not Found\r\nServer: ${SERVER_NAME}\r\n\r\n`,
  ],
  [
    new HttpResponse("HTTP", "1.1", 200, "OK", { A: "B" }, b("")),
    `HTTP/1.1 200 OK\r\nServer: ${SERVER_NAME}\r\nA: B\r\n\r\n`,
  ],
  [
    new HttpResponse("HTTP", "1.1", 200, "OK", {}, b("test")),
    `HTTP/1.1 200 OK\r\nServer: ${SERVER_NAME}\r\nContent-Length: 4\r\n\r\ntest`,
  ],
])("format response %#", (response, expected) => {
  expect(formatResponse(response)).toEqual(Buffer.from(expected));
});

test("parse request ok first line", () => {
  const [req, rest] = parseRequest(b("GET /test HTTP/1.0\r\n\r\n"));
  expect(req!.method).toBe("GET");
  expect(req!.path).toBe("/test");
  expect(req!.protocol).toBe("HTTP");
  expect(req!.version).toBe("1.0");
  expect(rest).toEqual(b(""));
});

test("parse request arbitrary protocol header", () => {
  const [req] = parseRequest(b("GET /test FOO/3.14\r\n\r\n"));
  expect(req!.protocol).toBe("FOO");
  expect(req!.version).toBe("3.14");
});

test("parse request method with underscore", () => {
  const [req] = parseRequest(b("SOME_METHOD /test FOO/3.14\r\n\r\n"));
  expect(req!.method).toBe("SOME_METHOD");
});

test.each([
  [new HttpRequest("GET", "/test", "HTTP", "1.1", {}, b("")), `GET /test HTTP/1.1\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`],
  [
    new HttpRequest("SOME METHOD", "/test", "HTTP", "1.1", {}, b("")),
    `SOME METHOD /test HTTP/1.1\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`,
  ],
  [
    new HttpRequest("GET", "/example", "HTTP", "1.1", {}, b("")),
    `GET /example HTTP/1.1\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`,
  ],
  [new HttpRequest("GET", "/test", "FOO", "3.14", {}, b("")), `GET /test FOO/3.14\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`],
  [
    new HttpRequest("GET", "/test", "HTTP", "1.1", { A: "B" }, b("")),
    `GET /test HTTP/1.1\r\nUser-Agent: ${USER_AGENT}\r\nA: B\r\n\r\n`,
  ],
  [
    new HttpRequest("GET", "/test", "HTTP", "1.1", {}, b("test")),
    `GET /test HTTP/1.1\r\nUser-Agent: ${USER_AGENT}\r\nContent-Length: 4\r\n\r\ntest`,
  ],
])("format request %#", (request, expected) => {
  expect(formatRequest(request)).toEqual(Buffer.from(expected));
});

// BASIC HTTP SERVER

type Handler = ((req: HttpRequest) => HandlerResult | false) | HttpSimpleRouter;

async function serve(handler: Handler) {
  const actual = typeof handler === "function" ? { handleRequest: handler as (r: HttpRequest) => HandlerResult } : handler;
  return httpServer(() => new BasicHttpServer(actual));
}

async function serveAndConnect(handler: Handler): Promise<[HttpConnection, Awaited<ReturnType<typeof serve>>[0]]> {
  const [server, port] = await serve(handler);
  const client = await httpConnect("127.0.0.1", port);
  return [client, server];
}

test("server request unhandled resource", async () => {
  const [client, server] = await serveAndConnect(() => false);
  const resp = await client.get("/", true);
  expect(resp.protocol).toBe("HTTP");
  expect(resp.version).toBe("1.1");
  expect(resp.code).toBe(404);
  expect(resp.message).toBe("File not found");
  expect(resp.headers.get("Server")).toBeTruthy();
  expect(resp.body).toBe("Not found");
  server.close();
});

test("server request single file", async () => {
  const handlePage = (request: HttpRequest) => {
    expect(request.protocol).toBe("HTTP");
    expect(request.version).toBe("1.1");
    expect(request.path).toBe("/resource");
    expect(request.method).toBe("GET");
    return new HttpResponse("HTTP", "1.1", 200, "OK", { DummyHeader: "value" }, b("body"));
  };

  const [client, server] = await serveAndConnect(handlePage);
  const resp = await client.get("/resource", true);
  expect(resp.protocol).toBe("HTTP");
  expect(resp.code).toBe(200);
  expect(resp.message).toBe("OK");
  expect(resp.headers.toObject()).toEqual({
    DummyHeader: "value",
    "Content-Length": "4",
    Server: SERVER_NAME,
  });
  expect(resp.body).toBe("body");
  server.close();
});

test("server bad handler gives error", async () => {
  const [client, server] = await serveAndConnect(() => {
    throw new Error("fail");
  });
  const resp = await client.get("/", true);
  expect(resp.protocol).toBe("HTTP");
  expect(resp.code).toBe(500);
  expect(resp.message).toBe("Internal server error");
  expect(resp.body).toBe("fail");
  server.close();
});

class DummyRouter extends HttpSimpleRouter {
  constructor() {
    super();
    this.addRoute("GET", "/foo", (r) => this.foo(r));
    this.addRoute("GET", "/bar", (r) => this.bar(r));
  }

  foo(request: HttpRequest): HttpResponse {
    return new HttpResponse("HTTP", "1.1", 200, "foo", {}, request.body);
  }

  bar(request: HttpRequest): HttpResponse {
    return new HttpResponse("HTTP", "1.1", 123, "dummy", {}, request.body);
  }
}

test("simple router", () => {
  const resp = new DummyRouter().handleRequest(new HttpRequest("GET", "/foo", "HTTP", "1.1", {}, "foobar")) as HttpResponse;
  expect(resp.code).toBe(200);
  expect(resp.protocol).toBe("HTTP");
  expect(resp.version).toBe("1.1");
  expect(resp.body).toBe("foobar");
});

test("simple router method", () => {
  expect(new DummyRouter().handleRequest(new HttpRequest("POST", "/foo", "HTTP", "1.1", {}, "foobar"))).toBeNull();
});

test("server with router", async () => {
  const [client, server] = await serveAndConnect(new DummyRouter());
  const resp = await client.get("/foo", true);
  expect(resp.code).toBe(200);
  server.close();
});

test("server process received", async () => {
  const [client, server] = await serveAndConnect(new DummyRouter());
  const mock = spyOn(BasicHttpServer.prototype, "processReceived").mockImplementation((data: Buffer) =>
    Buffer.from(data.toString("latin1").replace("/foo", "/bar"), "latin1"),
  );
  const resp = await client.get("/foo", true);
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockRestore();
  expect(resp.code).toBe(123);
  server.close();
});

test("server process sent", async () => {
  const [client, server] = await serveAndConnect(new DummyRouter());
  const mock = spyOn(BasicHttpServer.prototype, "processSent").mockImplementation((data: Buffer) =>
    Buffer.from(data.toString("latin1").replace("200", "456"), "latin1"),
  );
  const resp = await client.get("/foo", true);
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockRestore();
  expect(resp.code).toBe(456);
  server.close();
});

test("server async handler", async () => {
  class TestRouter extends HttpSimpleRouter {
    constructor() {
      super();
      this.addRoute("GET", "/baz", (request) => createTask(async () => this.asyncBaz(request)));
    }

    async asyncBaz(request: HttpRequest): Promise<HttpResponse> {
      return new HttpResponse("HTTP", "1.1", 200, "baz", {}, request.body);
    }
  }

  const [client, server] = await serveAndConnect(new TestRouter());
  const resp = await client.get("/baz", true);
  expect(resp.code).toBe(200);
  expect(resp.message).toBe("baz");
  server.close();
});

test("server segmented request", async () => {
  const [server, port] = await serve(new DummyRouter());
  const responseReceived = new Event();
  let responseContent: Buffer = Buffer.alloc(0);
  const [transport] = await createConnection(
    () => ({
      dataReceived(data: Buffer) {
        responseContent = data;
        responseReceived.set();
      },
    }),
    "127.0.0.1",
    port,
  );

  let dataReceived = new Event();
  const original = BasicHttpServer.prototype.dataReceived;
  const mock = spyOn(BasicHttpServer.prototype, "dataReceived").mockImplementation(function (
    this: BasicHttpServer,
    data: Buffer,
  ) {
    dataReceived.set();
    return original.call(this, data);
  });

  transport.write(b("GET /foo HTTP/1.1\r\nContent-Length: 11\r\n\r\n"));
  await dataReceived.wait();
  dataReceived = new Event();
  transport.write(b("first"));
  await dataReceived.wait();
  dataReceived = new Event();
  transport.write(b("second"));
  await responseReceived.wait();
  mock.mockRestore();

  expect(responseContent.toString("latin1").startsWith("HTTP/1.1 200 foo\r\n")).toBe(true);
  expect(responseContent.toString("latin1").endsWith("\r\nfirstsecond")).toBe(true);
  transport.close();
  server.close();
});

// HTTP CONNECTION

test("connection send processor", async () => {
  const [client, server] = await serveAndConnect(new DummyRouter());
  client.sendProcessor = (data) => Buffer.from(data.toString("latin1").replace("/foo", "/bar"), "latin1");
  const resp = await client.get("/foo", true);
  expect(resp.code).toBe(123);
  expect(resp.message).toBe("dummy");
  server.close();
});

test("connection receive processor", async () => {
  const [client, server] = await serveAndConnect(new DummyRouter());
  client.receiveProcessor = (data) => Buffer.from(data.toString("latin1").replace("foo", "something else"), "latin1");
  const resp = await client.get("/foo", true);
  expect(resp.code).toBe(200);
  expect(resp.message).toBe("something else");
  server.close();
});

test("connection abort timeout if connection closed", async () => {
  // Set up a TCP server that will just consume the request and disconnect
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  const connection = await httpConnect("127.0.0.1", port);

  // Spawn three requests. Connection will be closed when processing the first one
  // but all three shall be aborted with an exception.
  const tasks = [0, 1, 2].map(() => connection.sendAndReceive("GET", "/test"));
  for (const result of await Promise.allSettled(tasks)) {
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ConnectionLostError);
  }
  server.close();
});

// --- Late responses after timeouts (pyatv #2893, #1790, #2376) ---------------

function fakeConnection(): HttpConnection {
  const conn = new HttpConnection();
  conn.connectionMade({ write() {}, close() {}, getExtraInfo: () => ["1.2.3.4", 1] } as any);
  return conn;
}

const rtspResponse = (cseq: number, body: string) =>
  Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);

test("late RTSP response is not delivered to next request", async () => {
  const conn = fakeConnection();
  await expect(
    conn.sendAndReceive("POST", "/feedback", { protocol: "RTSP/1.0", timeout: 0.05, headers: { CSeq: 20 } }),
  ).rejects.toThrow("no response");

  const next = conn.sendAndReceive("GET", "/info", { protocol: "RTSP/1.0", timeout: 1, headers: { CSeq: 21 } });
  conn.dataReceived(rtspResponse(20, "late"));
  conn.dataReceived(rtspResponse(21, "info"));
  const resp = await next;
  expect(resp.headers.get("CSeq")).toBe("21");
  expect(resp.body).toEqual("info");
});

test("RTSP responses are matched by CSeq when out of order", async () => {
  const conn = fakeConnection();
  const first = conn.sendAndReceive("GET", "/a", { protocol: "RTSP/1.0", timeout: 1, headers: { CSeq: 1 } });
  const second = conn.sendAndReceive("GET", "/b", { protocol: "RTSP/1.0", timeout: 1, headers: { CSeq: 2 } });
  conn.dataReceived(rtspResponse(2, "b"));
  conn.dataReceived(rtspResponse(1, "a"));
  expect((await first).body).toEqual("a");
  expect((await second).body).toEqual("b");
});

test("late HTTP response is discarded instead of shifting responses", async () => {
  const conn = fakeConnection();
  await expect(conn.sendAndReceive("POST", "/pair-pin-start", { timeout: 0.05 })).rejects.toThrow("no response");

  const next = conn.sendAndReceive("GET", "/info", { timeout: 1 });
  conn.dataReceived(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nlate"));
  conn.dataReceived(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ninfo"));
  expect((await next).body).toEqual("info");
});

// DIGEST AUTHENTICATION (password protected AirPlay receivers, pyatv #556)

function digestServer(password: string, seen: Array<string | undefined>) {
  return (request: HttpRequest): HttpResponse => {
    const authorization = request.headers.get("Authorization");
    seen.push(authorization);
    const expected = getDigestPayload(request.method, request.path, "AirPlay", "airplay", password, "abc");
    if (authorization === expected) return new HttpResponse("HTTP", "1.1", 200, "OK", new Map(), Buffer.from("ok"));
    return new HttpResponse(
      "HTTP",
      "1.1",
      401,
      "Unauthorized",
      new Map([["WWW-Authenticate", 'Digest realm="airplay", nonce="abc"']]),
      Buffer.alloc(0),
    );
  };
}

test("connection with password retries with digest authentication", async () => {
  const seen: Array<string | undefined> = [];
  const [client, server] = await serveAndConnect(digestServer("secret", seen));
  client.password = "secret";

  expect((await client.get("/first")).code).toBe(200);
  expect(seen.length).toBe(2);
  expect(seen[0]).toBeUndefined();

  // Following requests are authenticated directly
  expect((await client.get("/second")).code).toBe(200);
  expect(seen.length).toBe(3);
  server.close();
});

test("connection with wrong password fails", async () => {
  const seen: Array<string | undefined> = [];
  const [client, server] = await serveAndConnect(digestServer("secret", seen));
  client.password = "wrong";

  await expect(client.get("/first")).rejects.toThrow(AuthenticationError);
  expect(seen.length).toBe(2); // Only one retry
  expect((await client.get("/again", true)).code).toBe(401);
  server.close();
});

test("connection without password does not retry", async () => {
  const seen: Array<string | undefined> = [];
  const [client, server] = await serveAndConnect(digestServer("secret", seen));
  await expect(client.get("/first")).rejects.toThrow(AuthenticationError);
  expect(seen.length).toBe(1);
  server.close();
});
