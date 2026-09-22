import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../cli/index.js";
import { ok } from "../lib/result.js";
import { resolveWorkspace, type Workspace } from "../lib/workspace.js";
import { createUi } from "./index.js";

/**
 * The event stream's one promise: it keeps talking.
 *
 * Everything the screen knows arrives on this socket, so a stream that goes
 * quiet is a screen that lies without saying anything: the ladder stops where
 * it was, a command's result never lands, and the panel that started it waits
 * for an answer nobody is going to send. The page has no way to tell that
 * apart from a workspace where nothing is happening.
 *
 * What can go quiet is the queue. Recomputes and finished commands are
 * serialised onto one chain so that two writers cannot interleave frames on
 * one socket, and a chain is exactly the structure that a single rejection
 * ends: every link after a rejected one is skipped rather than run. So the
 * claim this file holds is the one a queue owes: **a push that fails must cost
 * one frame, not the socket.**
 *
 * `run` is mocked here and nowhere else in this module's tests, because the
 * reason a push fails is not the point. A stage that throws where it meant to
 * refuse is a bug in that stage; a stream that dies because one did is a bug
 * here, and only the second one is under test.
 */

vi.mock("../cli/index.js", () => ({ run: vi.fn() }));
vi.mock("../lib/env.js", () => ({ env: {} }));

const PROJECT = "ewa";
const EPISODE = "01-burza";

let root = "";
let workspace: Workspace = { root: "" };
let ladders = 0;

/** A frame of the stream, read off the socket and put back together. */
async function frameOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  event: string,
  budgetMs: number
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let buffered = "";

  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: a stream arrives in order
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ]);

    if (next === null || next.done === true) {
      break;
    }

    buffered += decoder.decode(next.value, { stream: true });

    if (buffered.includes(`event: ${event}`)) {
      return buffered;
    }
  }

  throw new Error(`strumień nie wypchnął zdarzenia "${event}"`);
}

/** The watcher settles for 150 ms, so a poke is answered a little after that. */
async function poke(name: string): Promise<void> {
  await writeFile(join(root, name), "ktoś coś zapisał\n", "utf8");
}

async function untilLadders(count: number): Promise<void> {
  for (let waited = 0; waited < 8000 && ladders < count; waited += 50) {
    // biome-ignore lint/performance/noAwaitInLoops: polling a counter
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ui-stream-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  ladders = 0;

  // The second ladder throws, every other answer is ordinary. A stage that
  // fails this way is rare and real: `run` returns a `Result` for what it can
  // refuse and lets the unexpected propagate, which is the contract that makes
  // this reachable at all.
  vi.mocked(run).mockImplementation((argv: readonly string[]) => {
    if (argv[0] !== "status") {
      return Promise.resolve(ok("zrobione"));
    }

    ladders += 1;

    if (ladders === 2) {
      return Promise.reject(new Error("etap rzucił tam, gdzie miał odmówić"));
    }

    return Promise.resolve(ok(JSON.stringify({ command: "status", episodeId: EPISODE })));
  });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe("the event stream", () => {
  it("should keep pushing after one recompute fails", { timeout: 30_000 }, async () => {
    const response = await createUi({ workspace }).request(`/api/events/${PROJECT}/${EPISODE}`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    await frameOf(reader, "status", 5000);
    await poke("pierwszy.txt");
    await untilLadders(2);
    await poke("drugi.txt");

    await expect(frameOf(reader, "status", 8000)).resolves.toContain("event: status");
    await reader.cancel();
  });

  it("should still deliver a finished command after one recompute fails", {
    timeout: 30_000,
  }, async () => {
    const app = createUi({ workspace });
    const response = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    await frameOf(reader, "status", 5000);
    await poke("pierwszy.txt");
    await untilLadders(2);

    const started = await app.request("/api/run", {
      body: JSON.stringify({ argv: ["check", PROJECT] }),
      headers: { "content-type": "application/json", origin: "http://localhost" },
      method: "POST",
    });

    expect(started.status).toBe(202);
    await expect(frameOf(reader, "run", 8000)).resolves.toContain("event: run");
    await reader.cancel();
  });
});
