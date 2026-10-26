import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the git server saw: its `Authorization` header, and whether it was a push. */
export interface GitHttpRequest {
  authorization: string | undefined;
  push: boolean;
}

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>`: repositories are at `<url>/<name>.git` under `root`. */
  url: string;
  requests: GitHttpRequest[];
  close(): Promise<void>;
}

/** `Basic` authorization of a brokered credential, as git sends it. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function isPush(req: IncomingMessage, url: URL): boolean {
  return (
    url.pathname.endsWith("/git-receive-pack") ||
    url.searchParams.get("service") === "git-receive-pack" ||
    req.headers["content-type"] === "application/x-git-receive-pack-request"
  );
}

/**
 * A smart-HTTP git server (`git http-backend`) serving the bare repositories
 * under `root`, standing in for the code host: `authorize` decides whether a
 * request's `Authorization` may fetch (`push: false`) or push (`push: true`);
 * a refused request gets a 401 asking for Basic credentials.
 */
export async function startGitHttpServer(
  root: string,
  authorize: (request: GitHttpRequest) => boolean,
): Promise<GitHttpServer> {
  const requests: GitHttpRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://git");
    const request = { authorization: req.headers.authorization, push: isPush(req, url) };
    requests.push(request);
    if (!authorize(request)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
      res.end();
      return;
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "x-access-token",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-encoding"] && {
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
        }),
      },
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.writeHead(status);
      headersSent = true;
      res.write(head.subarray(end + 4));
    });
    child.on("close", () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
