import { describe, expect, it } from "vitest";
import { browserHost, DOCKER_DESKTOP_HOST, isDockerDesktop } from "./docker-host";

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
