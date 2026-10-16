import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("sends the dashboard to the repositories page", () => {
    // Next.js `redirect(path)` throws an error whose digest carries the path.
    expect(() => HomePage()).toThrow(
      expect.objectContaining({ digest: expect.stringContaining(";/repositories;") }),
    );
  });
});
