import { describe, expect, it } from "vitest";
import { echoCommand } from "./commands/echo/echo.js";
import { defineCommand } from "./custom-commands.js";
import { Bash } from "./EmbeddedBash.js";

describe("EmbeddedBash", () => {
  it("registers only explicitly supplied bundled commands", async () => {
    const bash = new Bash({
      bundledCommands: [echoCommand],
      defenseInDepth: false,
    });

    expect(await bash.exec("echo hello")).toMatchObject({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.exec("cat /etc/hostname")).toMatchObject({
      stdout: "",
      stderr: "bash: cat: command not found\n",
      exitCode: 127,
    });
  });

  it("lets one embedded command call another against the same filesystem", async () => {
    const write = defineCommand("write-note", async (args, ctx) => {
      await ctx.fs.writeFile(
        ctx.fs.resolvePath(ctx.cwd, args[0]),
        args.slice(1).join(" "),
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const delegate = defineCommand("delegate", async (_args, ctx) => {
      return ctx.exec?.("write-note nested.txt from delegate", {
        cwd: ctx.cwd,
      }) ?? {
        stdout: "",
        stderr: "delegate: exec unavailable\n",
        exitCode: 1,
      };
    });
    const bash = new Bash({
      customCommands: [write, delegate],
      defenseInDepth: false,
    });

    expect(await bash.exec("delegate")).toMatchObject({ exitCode: 0 });
    expect(await bash.readFile("nested.txt")).toBe("from delegate");
  });
});
