#!/usr/bin/env node
import { run } from "./cli/index.js";

// The only place that touches the process boundary: streams and exit code.
const result = await run(process.argv.slice(2));

if (result.ok) {
  process.stdout.write(`${result.data}\n`);
} else {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
}
