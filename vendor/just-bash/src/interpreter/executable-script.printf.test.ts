import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("creating executable scripts with printf", () => {
  it("matches Bash when the outer printf consumes a format specifier", async () => {
    const bash = new Bash();
    const command = String.raw`printf '#!/bin/bash\nprintf \"script:%s\\n\" \"$1\"\n' > hello.sh && chmod +x hello.sh && ./hello.sh works`;

    const result = await bash.exec(command);

    expect(result).toMatchObject({
      stdout: "script:\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves a literal format specifier used in the generated script", async () => {
    const bash = new Bash();
    const command = String.raw`printf '#!/bin/bash\nprintf \"script:%%s\\n\" \"$1\"\n' > hello.sh && chmod +x hello.sh && ./hello.sh works`;

    const result = await bash.exec(command);

    expect(result).toMatchObject({
      stdout: "script:works\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
