import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ZodType } from "zod";
import { z } from "zod";
import { err, ok, type Result } from "../result.js";

/**
 * Internal to the project module: bytes, digests and writes.
 *
 * Every write in stage 0 goes through `applyWrites`, which is the single place
 * `--dry-run` is implemented. A command therefore cannot forget to honour it:
 * the preview and the real run execute the same plan, only the mode differs.
 */

export type WriteMode = "apply" | "dry-run";

export type WriteOp =
  | { readonly from: string; readonly kind: "copy"; readonly to: string }
  | { readonly kind: "directory"; readonly to: string }
  | { readonly kind: "text"; readonly text: string; readonly to: string };

interface FileDigest {
  readonly bytes: Buffer;
  readonly sha256: string;
}

class FileError extends Error {
  readonly path: string;

  constructor(path: string, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "FileError";
    this.path = path;
  }
}

class SchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "SchemaError";
    this.path = path;
  }
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Artifacts record workspace-relative paths so the whole tree can be moved. */
export function toWorkspacePath(workspaceRoot: string, absolute: string): string {
  return relative(workspaceRoot, absolute).split("\\").join("/");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readDigest(path: string): Promise<Result<FileDigest>> {
  try {
    const bytes = await readFile(path);
    return ok({ bytes, sha256: sha256Of(bytes) });
  } catch (cause) {
    return err(new FileError(path, `cannot read ${path}`, { cause }));
  }
}

export async function readJson<T>(path: string, schema: ZodType<T>): Promise<Result<T>> {
  const digest = await readDigest(path);

  if (!digest.ok) {
    return digest;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(digest.data.bytes.toString("utf8"));
  } catch (cause) {
    return err(new FileError(path, `${path} is not valid JSON`, { cause }));
  }

  const result = schema.safeParse(parsed);

  return result.success
    ? ok(result.data)
    : err(
        new SchemaError(
          path,
          `${path} does not match its schema:\n${z.prettifyError(result.error)}`
        )
      );
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Directories below `root` that hold no file at any depth, topmost first and
 * with nested ones collapsed into their outermost ancestor.
 *
 * The layout rule says a directory appears when a stage writes into it, which
 * is enforced at creation time and never verified afterwards. A digest check
 * can only see what a stage recorded; it is blind to a leftover from an older
 * version of the tool, from a stage that failed between `mkdir` and its first
 * write, or from a hand-made folder. This is the other direction of that
 * question. Dotfiles do not count as contents — an `.DS_Store` is the
 * filesystem talking, not the pipeline.
 */
export async function emptyDirectories(root: string): Promise<readonly string[]> {
  const directories: string[] = [];
  const holding = new Set<string>();

  for (const entry of await readEntries(root)) {
    const path = join(entry.parentPath, entry.name);

    if (entry.isDirectory()) {
      directories.push(path);
    } else if (!entry.name.startsWith(".")) {
      markAncestors(entry.parentPath, root, holding);
    }
  }

  return directories.filter((path) => !holding.has(path) && holding.has(dirname(path)));
}

function markAncestors(from: string, root: string, holding: Set<string>): void {
  let current = from;

  while (current.length >= root.length && current !== dirname(current)) {
    holding.add(current);
    current = dirname(current);
  }
}

async function readEntries(root: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
}

/** Returns the directory entries of `path`, or an empty list when it does not exist. */
export async function listEntries(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export async function applyWrites(
  ops: readonly WriteOp[],
  mode: WriteMode
): Promise<Result<readonly string[]>> {
  const written = ops.map((op) => op.to);

  if (mode === "dry-run") {
    return ok(written);
  }

  // Sequential on purpose: a directory has to exist before the file that goes
  // into it, and a partial failure must leave the declared prefix written
  // rather than an arbitrary subset.
  for (const op of ops) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered writes are the contract
    const outcome = await runOp(op);

    if (!outcome.ok) {
      return outcome;
    }
  }

  return ok(written);
}

async function runOp(op: WriteOp): Promise<Result<true>> {
  try {
    if (op.kind === "directory") {
      await mkdir(op.to, { recursive: true });
    } else if (op.kind === "text") {
      await mkdir(dirOf(op.to), { recursive: true });
      await writeFile(op.to, op.text, "utf8");
    } else {
      await mkdir(dirOf(op.to), { recursive: true });
      await copyFile(op.from, op.to);
    }

    return ok(true);
  } catch (cause) {
    return err(new FileError(op.to, `cannot write ${op.to}`, { cause }));
  }
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
