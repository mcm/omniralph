// How the Playwright container reaches the panel on the host. With `--network host` on Linux
// it shares the host's network, so `localhost` works. Docker Desktop (Mac, Windows) runs the
// daemon in a VM, whose `localhost` isn't the host's: the container opens
// `host.docker.internal` instead, and `next dev` must allow that origin
// (`allowedDevOrigins`) or it blocks the dev resources and the page never hydrates.

/** Docker Desktop's in-container name for the host. */
export const DOCKER_DESKTOP_HOST = "host.docker.internal";

/** Env var `next.config.ts` reads for extra `allowedDevOrigins` (comma-separated). */
export const DEV_ORIGINS_ENV = "OMNIRALPH_ALLOWED_DEV_ORIGINS";

/** True for `docker info`'s `OperatingSystem` of a Docker Desktop daemon. */
export function isDockerDesktop(operatingSystem: string): boolean {
  return /docker desktop/i.test(operatingSystem);
}

/** The host name the browser container uses for the panel. */
export function browserHost(operatingSystem: string): string {
  return isDockerDesktop(operatingSystem) ? DOCKER_DESKTOP_HOST : "localhost";
}
