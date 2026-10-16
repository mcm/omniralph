import { describe, expect, it } from "vitest";
import { browserHost, containerUrl, DOCKER_DESKTOP_HOST, isDockerDesktop } from "./environment";

describe("browserHost", () => {
  it("opens host.docker.internal on Docker Desktop", () => {
    expect(isDockerDesktop("Docker Desktop")).toBe(true);
    expect(browserHost("Docker Desktop")).toBe(DOCKER_DESKTOP_HOST);
  });

  it("keeps localhost on other daemons", () => {
    for (const os of ["Ubuntu 24.04.1 LTS", "Alpine Linux v3.24 (containerized)", ""]) {
      expect(isDockerDesktop(os)).toBe(false);
      expect(browserHost(os)).toBe("localhost");
    }
  });
});

describe("containerUrl", () => {
  it("points a loopback URL at the container's host name", () => {
    expect(containerUrl("postgres://u:p@localhost:5432/db", DOCKER_DESKTOP_HOST)).toBe(
      "postgres://u:p@host.docker.internal:5432/db",
    );
    expect(containerUrl("http://127.0.0.1:3000/x", "localhost")).toBe("http://localhost:3000/x");
  });

  it("keeps any other host", () => {
    expect(containerUrl("postgres://u:p@db.internal:5432/db", DOCKER_DESKTOP_HOST)).toBe(
      "postgres://u:p@db.internal:5432/db",
    );
  });
});
