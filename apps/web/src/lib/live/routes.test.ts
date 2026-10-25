import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const API = join(__dirname, "../../app/api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

describe("live change collectors", () => {
  it("are opened by every agent API, webhook and cron route", () => {
    const files = ["harness", "webhooks", "cron"].flatMap((dir) => routeFiles(join(API, dir)));
    expect(files.length).toBeGreaterThan(20);
    const unwrapped = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const methods = [
        ...source.matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g),
      ];
      expect(methods.length).toBeGreaterThan(0);
      return methods
        .filter(([, method]) => !new RegExp(`export const ${method} = liveRoute\\(`).test(source))
        .map(([, method]) => `${relative(API, file)} ${method}`);
    });
    expect(unwrapped).toEqual([]);
  });

  it("cover webhook work deferred until after the response", () => {
    for (const file of routeFiles(join(API, "webhooks"))) {
      const source = readFileSync(file, "utf8");
      for (const [call] of source.matchAll(/after\([^)]*\)/g)) {
        expect(call, relative(API, file)).toMatch(/after\((liveDeferred|liveWaitUntil)\(/);
      }
    }
  });

  it("are opened by apiHandler", () => {
    const source = readFileSync(join(__dirname, "../api/handler.ts"), "utf8");
    expect(source).toMatch(/withLiveChanges\(\(\) => handle\(request, route\)\)/);
  });
});
