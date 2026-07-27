import {
  type CommandName,
  createJavaScriptCommands,
  createLazyCommands,
  createNetworkCommands,
  createPythonCommands,
} from "./commands/registry.js";
import {
  Bash as EmbeddedBash,
  type BashOptions as EmbeddedBashOptions,
} from "./EmbeddedBash.js";
import { createSecureFetch } from "./network/index.js";
import type { Command } from "./types.js";

export type {
  BashLogger,
  ExecOptions,
  JavaScriptConfig,
} from "./EmbeddedBash.js";
export type { ExecutionLimitProfile, ExecutionLimits } from "./limits.js";

export interface BashOptions
  extends Omit<EmbeddedBashOptions, "commands"> {
  commands?: CommandName[];
}

export class Bash extends EmbeddedBash {
  constructor(options: BashOptions = {}) {
    const bundledCommands: Command[] = [
      ...createLazyCommands(options.commands),
      ...(options.fetch || options.network ? createNetworkCommands() : []),
      ...(options.python ? createPythonCommands() : []),
      ...(options.javascript ? createJavaScriptCommands() : []),
      ...(options.bundledCommands ?? []),
    ];
    super({ ...options, bundledCommands, secureFetchFactory: createSecureFetch });
  }
}
