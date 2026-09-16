import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { UsageRecord } from "./types.js";
import { parseUsage } from "./adapters/index.js";

/**
 * A loopback HTTP endpoint that accepts usage metadata from your own tooling —
 * a LiteLLM callback, a proxy, a test harness.
 *
 * This is the one component that opens a socket, so its defaults are the
 * conservative ones:
 *
 *   - bound to 127.0.0.1 explicitly, never 0.0.0.0, so nothing off-host can
 *     reach it even on an open network;
 *   - off unless `aiUsageMonitor.ingest.enabled` is set;
 *   - a per-session bearer token, compared in constant time, so other local
 *     processes cannot inject usage records into your history;
 *   - a hard body cap, so a runaway caller cannot exhaust extension-host memory.
 *
 * It only ever accepts usage *metadata*. Prompts and completions are not read
 * from the payload and never stored.
 */

const MAX_BODY_BYTES = 256 * 1024;

export interface IngestOptions {
  port: number;
  onRecord: (record: UsageRecord) => void;
  /** Diagnostics only. Never receives payload contents. */
  log: (message: string) => void;
}

export interface IngestHandle {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

export async function startIngestServer(options: IngestOptions): Promise<IngestHandle> {
  const token = randomBytes(24).toString("hex");

  const server = http.createServer((req, res) => {
    handle(req, res, token, options).catch((error) => {
      options.log(`ingest: request failed: ${errorText(error)}`);
      respond(res, 500, { error: "internal error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Explicit loopback host: the whole security model rests on this argument.
    server.listen(options.port, "127.0.0.1");
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // In-flight keep-alive sockets would otherwise hold the close open past
        // extension deactivation.
        server.closeAllConnections?.();
      }),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  options: IngestOptions,
): Promise<void> {
  if (req.method !== "POST") {
    respond(res, 405, { error: "use POST" });
    return;
  }

  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (path !== "/usage") {
    respond(res, 404, { error: "unknown path" });
    return;
  }

  if (!authorized(req, token)) {
    respond(res, 401, { error: "bad or missing bearer token" });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (error) {
    respond(res, 413, { error: errorText(error) });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    respond(res, 400, { error: "body is not valid JSON" });
    return;
  }

  // An envelope may wrap the vendor response and add what the response itself
  // does not carry — the measured duration, and the real provider when the call
  // went through a proxy that reports itself as the provider.
  const envelope = isRecord(payload) ? payload : {};
  const inner = "response" in envelope ? envelope.response : payload;

  const record = parseUsage(inner, {
    source: "ingest",
    durationMs: typeof envelope.durationMs === "number" ? envelope.durationMs : undefined,
    provider: typeof envelope.provider === "string" ? envelope.provider : undefined,
  });

  if (!record) {
    // Log the shape, not the content: the payload may hold prompt text.
    options.log(`ingest: no adapter recognized the payload (keys: ${Object.keys(envelope).join(", ")})`);
    respond(res, 422, { error: "no adapter recognized this payload" });
    return;
  }

  options.onRecord(record);
  respond(res, 200, { ok: true, id: record.id });
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch, so check length first — that
  // comparison leaks only the length, which is fixed and public anyway.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) {
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
