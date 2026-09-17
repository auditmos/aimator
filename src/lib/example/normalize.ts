// Internal to the example module — not re-exported from index.ts.
// Callers reach this behaviour through greet(), never by importing this file.

// Zero-width characters survive a copy-paste but should not reach a greeting.
const ZERO_WIDTH = /[​-‍﻿]/g;
const WHITESPACE_RUN = /\s+/g;

export function normalizeName(name: string): string {
  return name.replace(ZERO_WIDTH, "").replace(WHITESPACE_RUN, " ").trim();
}
