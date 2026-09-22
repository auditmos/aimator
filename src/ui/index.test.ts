import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../cli/index.js";
import { episodePaths, projectPaths, resolveWorkspace, type Workspace } from "../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../test/fixture.js";
import { INTENTS } from "./commands.js";
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

interface Frame {
  readonly data: string;
  readonly event: string;
}

/** A frame of the event stream, read off the socket and put back together. */
class Events {
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(): Promise<Frame> {
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
    const lines = frame.split("\n");

    return {
      data: lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n"),
      event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "",
    };
  }

  /** The next frame of one kind, skipping the ladder pushed on the way. */
  async nextOf(event: string): Promise<Frame> {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: a stream arrives in order
      const frame = await this.next();

      if (frame.event === event) {
        return frame;
      }
    }
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

    expect(JSON.parse(first.data)).toEqual(
      JSON.parse(await cli("status", PROJECT, EPISODE, "--json"))
    );
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

    expect(JSON.parse(pushed.data)).toMatchObject({ command: "status", episodeId: EPISODE });
    await events.close();
  });
});

/**
 * The one place in this module where an identifier becomes a path.
 *
 * The client addresses an artifact by what it is (project, episode, stage,
 * artifact) and never by where it lives, because the layout is `workspace.ts`'s
 * to know and a browser that learned it would be reading the tree twice. What
 * this resolver owes is therefore narrow and absolute: a tuple that names
 * something the layout knows becomes its bytes, and anything else is a 404
 * rather than a path walked out of the workspace.
 */
describe("the artifact resolver", () => {
  it("should serve the screenplay as the markdown it is", async () => {
    const response = await createUi({ workspace }).request(
      `/api/artifact/${PROJECT}/${EPISODE}/screenplay/screenplay`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(
      await readFile(join(episodeRoot(), "screenplay.md"), "utf8")
    );
  });

  it("should answer 404 for anything the layout does not name, and leak nothing", async () => {
    const secret = join(scratch, "sekret.md");

    await writeFile(secret, "TAJNE\n", "utf8");

    const app = createUi({ workspace });
    const answers = await Promise.all(
      [
        `/api/artifact/${PROJECT}/${EPISODE}/screenplay/${encodeURIComponent("../../../../../../etc/passwd")}`,
        `/api/artifact/${encodeURIComponent("..")}/${EPISODE}/screenplay/screenplay`,
        `/api/artifact/${PROJECT}/${encodeURIComponent("../..")}/screenplay/screenplay`,
        `/api/artifact/${PROJECT}/${EPISODE}/screenplay/${encodeURIComponent(secret)}`,
        `/api/artifact/${PROJECT}/${EPISODE}/montaz/episode`,
      ].map(async (path) => {
        const response = await app.request(path);

        return { body: await response.text(), status: response.status };
      })
    );

    expect(answers.map((one) => one.status)).toEqual([404, 404, 404, 404, 404]);
    expect(answers.every((one) => !one.body.includes("TAJNE"))).toBe(true);
  });
});

/**
 * A command started here, and answered where the ladder is answered.
 *
 * The request returns an identifier and nothing else, because the clip stage
 * polls a provider for minutes and a browser that waited for it would be a
 * browser that cannot show anything else meanwhile. The result arrives on the
 * stream the episode already has open: one connection, one order of events,
 * and no window in which a result exists and has nowhere to go.
 *
 * The server does not read the argv it is handed. Which command is legal is
 * the CLI's answer, given by refusing, and a second opinion here would be the
 * private road `imports.test.ts` exists to prevent.
 */
describe("running a command", () => {
  it("should answer with a run id at once and deliver the result as an event", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: ["check", PROJECT, EPISODE, "--stage", "screenplay", "--json"],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(started.status).toBe(202);

    const { runId } = (await started.json()) as { runId: string };

    expect(runId).not.toBe("");

    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toEqual({
      data: await cli("check", PROJECT, EPISODE, "--stage", "screenplay", "--json"),
      ok: true,
      runId,
    });
    await events.close();
  });

  /**
   * The first of the two steps of a purchase, as far as a test can take it.
   *
   * What a browser has to confirm is the clicking. What this confirms is the
   * seam between the two halves that a click would otherwise be the first to
   * exercise: the argv the dictionary builds for "Generuj" is a command this
   * server runs, and what comes back under its identifier is the object the
   * panel arranges, the bill and the whole prompt included. The second step is
   * not run here, for the obvious reason, and `--dry-run` is why the first one
   * can be: by contract it reads no secret and sends nothing.
   */
  it("should answer the first step of a purchase with the stage's own object", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.previewScreenplay({
          episodeId: EPISODE,
          maxOutputTokens: "",
          model: "gpt-6-astra",
          projectId: PROJECT,
          regenerate: true,
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");
    const done = JSON.parse(finished.data) as { data: string; ok: boolean; runId: string };
    const report = JSON.parse(done.data) as {
      command: string;
      paidCalls: number;
      prompt: string;
      stage: string;
    };

    expect(done).toMatchObject({ ok: true, runId });
    expect(report.command).toBe("generate");
    expect(report.stage).toBe("screenplay");
    expect(report.paidCalls).toBe(1);
    expect(report.prompt).toContain("# Task: write a screenplay");
    await events.close();
  });

  /**
   * The loopback address is the security model, and it is not the whole one.
   *
   * Any page open in this browser can post to `127.0.0.1:4317`; CORS would
   * stop it reading the answer and would not stop the command running, and
   * from the next slice on a command spends money. Two checks close that:
   * a foreign `Origin` is refused, and a body has to be JSON, which is what
   * makes the browser ask permission before sending anything at all.
   */
  /**
   * Stage 0's one promise the browser could quietly break.
   *
   * A person pastes a path out of Finder and the CLI copies the file, which is
   * why `episode.json` records where it came from. Handing bytes over instead
   * would have made that origin a temporary directory, and an answer to "skąd
   * to jest" would have stopped existing: that is the whole reason the PRD
   * refused an upload. So the string travels from the form to `--source`
   * untouched, and what proves it is the archive rather than the argv.
   */
  it("should carry the path typed in a stage-0 form into the episode's archive", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const source = join(scratch, "02-Slonce.md");

    await writeFile(source, "# Słońce\n\nEwa czeka na słońce.\n", "utf8");

    const started = await app.request("/api/run", {
      body: JSON.stringify({
        argv: INTENTS.addEpisode({
          audio: "narration",
          duration: "30",
          language: "pl",
          maxClip: "15",
          nature: "law-or-idea",
          projectId: PROJECT,
          source,
          subtitles: "none",
        }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");

    expect(JSON.parse(finished.data)).toMatchObject({ ok: true, runId });

    const project = projectPaths(workspace, PROJECT);

    if (!project.ok) {
      throw project.error;
    }

    const added = episodePaths(project.data, "02-slonce");

    if (!added.ok) {
      throw added.error;
    }

    expect(JSON.parse(await readFile(added.data.file, "utf8"))).toMatchObject({
      source: { originPath: source },
    });

    const checked = await app.request("/api/run", {
      body: JSON.stringify({ argv: INTENTS.checkPrepare({ projectId: PROJECT }) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(checked.status).toBe(202);
    await events.close();
  });

  it("should refuse a command posted by a page that is not this one", async () => {
    const response = await createUi({ workspace }).request("/api/run", {
      body: JSON.stringify({ argv: ["list"] }),
      headers: { "content-type": "application/json", origin: "https://zla-strona.example" },
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { name: "ForbiddenError" } });
  });

  /**
   * Comparing `Origin` to `Host` is not enough, and the attack says why.
   *
   * A page on `zla-strona.example` whose DNS is re-pointed at 127.0.0.1 is
   * served by this server under **its own** name: the browser then sends
   * `Host: zla-strona.example` and `Origin: http://zla-strona.example`, the
   * two agree, the request is same-origin so no preflight is asked for, and
   * the page can read the answer. The only header an attacker cannot forge
   * into the loopback address is the name this server is reached by, so that
   * is what is checked.
   */
  it("should refuse a request reaching it under a name that is not the loopback", async () => {
    const app = createUi({ workspace });
    const [started, read] = await Promise.all([
      app.request("http://zla-strona.example:4317/api/run", {
        body: JSON.stringify({ argv: ["list"] }),
        headers: {
          "content-type": "application/json",
          origin: "http://zla-strona.example:4317",
        },
        method: "POST",
      }),
      app.request(`http://zla-strona.example:4317/api/status/${PROJECT}/${EPISODE}`),
    ]);

    expect(started.status).toBe(403);
    expect(read.status).toBe(403);
    expect(await read.text()).not.toContain("command");
  });

  it("should refuse a body that needed no permission to send", async () => {
    const response = await createUi({ workspace }).request("/api/run", {
      body: JSON.stringify({ argv: ["list"] }),
      headers: { "content-type": "text/plain;charset=UTF-8" },
      method: "POST",
    });

    expect(response.status).toBe(415);
  });

  it("should carry a refusal in the words the terminal would print", async () => {
    const app = createUi({ workspace });
    const stream = await app.request(`/api/events/${PROJECT}/${EPISODE}`);
    const events = new Events(stream.body as ReadableStream<Uint8Array>);

    await events.next();

    const started = await app.request("/api/run", {
      body: JSON.stringify({ argv: ["approve", "nie-ma", EPISODE, "--stage", "screenplay"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { runId } = (await started.json()) as { runId: string };
    const finished = await events.nextOf("run");
    const refused = await run([
      "approve",
      "nie-ma",
      EPISODE,
      "--stage",
      "screenplay",
      "--workspace",
      root,
    ]);

    expect(JSON.parse(finished.data)).toEqual({
      error: {
        message: refused.ok ? "" : refused.error.message,
        name: refused.ok ? "" : refused.error.name,
      },
      ok: false,
      runId,
    });
    await events.close();
  });
});
