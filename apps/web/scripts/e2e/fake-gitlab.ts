// A fake GitLab instance for the e2e specs: answers what Connect GitLab and the project
// picker's save ask of GitLab (the bot token's user and scopes, the projects it maintains,
// project webhooks and project access tokens), so the full flow runs without a real
// instance. The panel reaches it on `http://localhost:<port>` (plain http is accepted
// for localhost).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FAKE_GITLAB_PROJECTS, FAKE_GITLAB_TOKEN, FAKE_GITLAB_USER } from "../../e2e/fake-gitlab";

export interface FakeGitLab {
  /** `http://localhost:<port>`, as the panel (on this host) reaches it. */
  url: string;
  /** Requests received, as `METHOD /path`. */
  requests: string[];
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Starts the fake on a free port (all interfaces, so `localhost` works over IPv4 and IPv6). */
export async function startFakeGitLab(): Promise<FakeGitLab> {
  const requests: string[] = [];
  let nextId = 1000;
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) =>
      send(response, 500, { message: String(error) }),
    );
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (request.headers["private-token"] !== FAKE_GITLAB_TOKEN) {
      return send(response, 401, { message: "401 Unauthorized" });
    }
    const base = `http://${request.headers.host}`;
    const path = url.pathname.replace(/^\/api\/v4/, "");
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/user") return send(response, 200, FAKE_GITLAB_USER);
    if (method === "GET" && path === "/personal_access_tokens/self") {
      return send(response, 200, {
        id: 5,
        name: "omniralph",
        scopes: ["api"],
        active: true,
        revoked: false,
      });
    }
    if (method === "GET" && path === "/projects") {
      return send(
        response,
        200,
        FAKE_GITLAB_PROJECTS.map((project) => ({
          ...project,
          web_url: `${base}/${project.path_with_namespace}`,
        })),
      );
    }
    if (method === "POST" && (match = /^\/projects\/(\d+)\/hooks$/.exec(path))) {
      await readJson(request);
      return send(response, 201, { id: nextId++, url: "webhook" });
    }
    if (method === "DELETE" && /^\/projects\/\d+\/hooks\/\d+$/.test(path)) {
      response.writeHead(204).end();
      return;
    }
    if (method === "POST" && (match = /^\/projects\/(\d+)\/access_tokens$/.exec(path))) {
      const body = await readJson(request);
      const id = nextId++;
      return send(response, 201, {
        id,
        token: `glpat-e2e-project-${match[1]}-${id}`,
        scopes: body.scopes,
        expires_at: body.expires_at,
      });
    }
    return send(response, 404, { message: "404 Not Found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // The panel's keep-alive connections would hold `close` open.
        server.closeAllConnections();
      }),
  };
}
