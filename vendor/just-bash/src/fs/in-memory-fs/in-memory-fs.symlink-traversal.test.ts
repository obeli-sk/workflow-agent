import { describe, expect, it } from "vitest";
import { InMemoryFs } from "./in-memory-fs.js";

describe("InMemoryFs directory symlink traversal", () => {
  it("reads a directory below an intermediate symlink", async () => {
    const fs = new InMemoryFs({
      "/deployments/active/activity/worker.js": "export default 1;",
    });
    await fs.symlink("/deployments/active", "/deployments/current");

    const entries = await fs.readdirWithFileTypes(
      "/deployments/current/activity",
    );

    expect(entries).toEqual([
      {
        name: "worker.js",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
    ]);
  });
});
