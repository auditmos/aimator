import { normalizeName } from "./normalize.js";

/**
 * The module's entire public interface. Name hygiene lives in ./normalize.ts
 * and stays hidden — widening this barrel is the thing to avoid.
 */
export function greet(name: string): string {
  return `Hello, ${normalizeName(name)}!`;
}
