import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../cli/index.js";
import { episodePaths, projectPaths, resolveWorkspace, type Workspace } from "../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../test/fixture.js";
import { createUi } from "./index.js";

/**
 * The server, tested by calling it rather than by opening a port.
 *
 * What it promises is small and the tests say exactly it: **the CLI is the only
 * contract.** Every answer here is a `run(argv)` this tool already had, so
 * there is nothing for the server to get right except the argv it builds and
 * the envelope it puts the answer in. If a route ever computes a verdict of
 * its own, the UI has become the second road this project exists not to build.
 *
 * Assumptions this file encodes:
 *
 * - **The workspace is injected**, exactly as `lib/assembly` takes its muxer,
 *   which is what lets these tests run on a fixture and the process entry read
 *   `AIMATOR_WORKSPACE` without either knowing about the other.
 * - **A refusal keeps its words.** `Result` carries the message a terminal
 *   would print, so the response carries the same string, unchanged; the
 *   status code says who is at fault and nothing else.
 * - **Nothing here writes.** This slice serves the ladder and the listing;
 *   running commands and serving artifacts are the rows below it.
 *
 * Not tested here: the client. It is verified in a browser, per the issue.
 */

vi.mock("../lib/env.js", () => ({ env: { AIMATOR_FFMPEG: "/nonexistent/aimator-ffmpeg" } }));

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** What the terminal would print for the same question. */
async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

/** A frame of the event stream, read off the socket and put back together. */
class Events {
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(): Promise<string> {
    while (!this.buffered.includes("\n\n")) {
      // biome-ignore lint/performance/noAwaitInLoops: a stream arrives in order
      const { done, value } = await this.reader.read();

      if (done) {
        throw new Error("strumień zdarzeń zamknął się bez zdarzenia");
      }

      this.buffered += this.decoder.decode(value, { stream: true });
    }

    const [frame = "", ...rest] = this.buffered.split("\n\n");
    this.buffered = rest.join("\n\n");

    return frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

/** The episode's own directory, the one a stage writes into. */
function episodeRoot(): string {
  const project = projectPaths(workspace, PROJECT);

  if (!project.ok) {
    throw project.error;
  }

  const episode = episodePaths(project.data, EPISODE);

  if (!episode.ok) {
    throw episode.error;
  }

  return episode.data.root;
}

function answer(): string {
  return JSON.stringify({
    clips: [{ id: "C01", prompt: "Akcja klipu C01.", referenceIds: ["hero:ewa"] }],
    entryFrames: [],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa"] },
    references: [],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ui-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-ui-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;
  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
}, 60_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("the UI server", () => {
  it("should answer the ladder with exactly what status --json prints", async () => {
    const response = await createUi({ workspace }).request(`/api/status/${PROJECT}/${EPISODE}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(await cli("status", PROJECT, EPISODE, "--json"))
    );
  });

  it("should answer the picker with exactly what list --json prints", async () => {
    const response = await createUi({ workspace }).request("/api/projects");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(await cli("list", "--json")));
  });

  it("should hand a refusal over in the words the terminal would print", async () => {
    const response = await createUi({ workspace }).request("/api/status/nie-ma/01-burza");
    const refused = await run(["status", "nie-ma", "01-burza", "--json", "--workspace", root]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: refused.ok ? "" : refused.error.message,
        name: refused.ok ? "" : refused.error.name,
      },
    });
  });

  it("should open the stream with the ladder as it is right now", async () => {
    const response = await createUi({ workspace }).request(`/api/events/${PROJECT}/${EPISODE}`);

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = new Events(response.body as ReadableStream<Uint8Array>);
    const first = await events.next();

    expect(JSON.parse(first)).toEqual(JSON.parse(await cli("status", PROJECT, EPISODE, "--json")));
    await events.close();
  });

  /**
   * The deadline here is not the contract's.
   *
   * What a person is promised is a refreshed ladder within two seconds of a
   * file changing, and that is measured where it means something: a browser on
   * a real workspace. A deadline asserted inside a runner working through
   * thirty-five files at once would measure the runner instead, and would fail
   * on a busy machine while the server was behaving perfectly. So what this
   * test holds is the claim a test can hold honestly: the write reaches the
   * stream at all, and what arrives is the ladder rather than a heartbeat.
   */
  it("should push the ladder again when a file under the episode changes", {
    timeout: 20_000,
  }, async () => {
    const response = await createUi({ workspace }).request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(response.body as ReadableStream<Uint8Array>);

    await events.next();
    await writeFile(join(episodeRoot(), "poke.txt"), "ktoś coś zapisał\n", "utf8");

    const pushed = await Promise.race([
      events.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("strumień nie wypchnął drabiny")), 15_000)
      ),
    ]);

    expect(JSON.parse(pushed)).toMatchObject({ command: "status", episodeId: EPISODE });
    await events.close();
  });
});
