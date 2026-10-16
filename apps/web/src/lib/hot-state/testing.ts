// A Redis for tests, in a container (as `@omniralph/db/testing` does for Postgres).
import { GenericContainer, getContainerRuntimeClient, Wait } from "testcontainers";

/** A test file's own Redis; `stop` removes the container. */
export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

/** Whether a container runtime (Docker) is available; Redis tests skip without one. */
export async function testRedisAvailable(): Promise<boolean> {
  return getContainerRuntimeClient().then(
    () => true,
    () => false,
  );
}

/** Starts a throwaway Redis (no persistence) for a test file. */
export async function startTestRedis(): Promise<TestRedis> {
  const container = await new GenericContainer("redis:7-alpine")
    .withCommand(["redis-server", "--save", "", "--appendonly", "no"])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
