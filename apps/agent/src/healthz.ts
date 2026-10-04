import { createServer, type Server } from "node:http";
import type { DaemonStatus } from "./daemon.js";

/**
 * Optional `GET /healthz` on 127.0.0.1 only (for systemd or a local monitor).
 * The agent opens no other listening port.
 */
export async function startHealthServer(port: number, status: () => DaemonStatus): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const current = status();
    const healthy = current.connected && !current.stopping;
    res
      .writeHead(healthy ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify({ status: healthy ? "ok" : "unavailable", ...current }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}
