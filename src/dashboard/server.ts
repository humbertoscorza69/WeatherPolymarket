import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { EventLog } from "../core/eventLog.js";
import { WeatherExecutionEngine } from "../execution/weatherExecutionEngine.js";
import { Logger } from "../logger.js";

export interface DashboardOptions {
  port: number;
  host?: string;
  engine?: Pick<WeatherExecutionEngine, "snapshot" | "conditionIds">;
  eventLog: EventLog;
  startTime: number;
  config: Record<string, unknown>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

export function startDashboard(options: DashboardOptions): { close: () => void } {
  const log = new Logger("dashboard");
  const host = options.host ?? "127.0.0.1";
  const publicDir = resolvePublicDir();

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, options, publicDir);
    } catch (err) {
      log.error("request failed", { error: String(err), url: req.url });
      send(res, 500, "internal server error", "text/plain");
    }
  });

  server.listen(options.port, host, () => {
    log.info("dashboard listening", { url: `http://${host}:${options.port}` });
  });

  return { close: () => server.close() };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardOptions,
  publicDir: string
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/state") {
    const limit = Number(url.searchParams.get("events") ?? "200");
    const state = buildState(options, Number.isFinite(limit) ? limit : 200);
    send(res, 200, JSON.stringify(state), "application/json");
    return;
  }

  if (url.pathname === "/") {
    await serveStatic(res, publicDir, "index.html");
    return;
  }

  // Serve static files only from the dashboard public dir (prevent path traversal)
  const safePath = normalize(url.pathname).replace(/^([/\\])+/, "");
  const fullPath = resolve(publicDir, safePath);
  if (!fullPath.startsWith(publicDir + sep) && fullPath !== publicDir) {
    send(res, 403, "forbidden", "text/plain");
    return;
  }
  await serveStatic(res, publicDir, safePath);
}

function buildState(options: DashboardOptions, limit: number) {
  const uptimeMs = Date.now() - options.startTime;
  const engineSnapshot = options.engine?.snapshot?.() ?? {
    activeBuys: [],
    activeSells: [],
    positions: [],
    markets: []
  };
  return {
    uptimeMs,
    startTime: new Date(options.startTime).toISOString(),
    now: new Date().toISOString(),
    metrics: options.eventLog.metrics(),
    engine: engineSnapshot,
    events: options.eventLog.recent(limit),
    config: options.config
  };
}

async function serveStatic(res: ServerResponse, publicDir: string, requested: string): Promise<void> {
  const fullPath = resolve(publicDir, requested || "index.html");
  if (!fullPath.startsWith(publicDir)) {
    send(res, 403, "forbidden", "text/plain");
    return;
  }
  try {
    const content = await readFile(fullPath);
    const ext = fullPath.slice(fullPath.lastIndexOf("."));
    send(res, 200, content, CONTENT_TYPES[ext] ?? "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string
): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function resolvePublicDir(): string {
  // When bundled to dist/, the public dir sits alongside this file.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "public");
}
