import { greet } from "./lib/example/index.js";
import { err, ok, type Result } from "./lib/result.js";

const USAGE = `Usage: ts-template <command>

Commands:
  greet <name>   Print a greeting
  --help         Show this message`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Pure entry point: argv in, outcome out. Nothing here touches process,
 * stdout, or exit codes — that is bin.ts's job, which keeps this testable.
 */
export function run(argv: string[]): Result<string> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help") {
    return ok(USAGE);
  }

  if (command === "greet") {
    const [name] = rest;
    return name === undefined ? err(new UsageError("greet requires a name")) : ok(greet(name));
  }

  return err(new UsageError(`unknown command: ${command}`));
}
