import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkReferences } from "../lib/references/index.js";
import {
  episodePaths,
  episodeTrackPaths,
  projectPaths,
  resolveWorkspace,
  type Workspace,
} from "../lib/workspace.js";
import { EPISODE, makeCut, makeUpstream, PROJECT } from "../test/fixture.js";
import { run } from "./index.js";

/**
 * One question instead of a dozen.
 *
 * `status` is the only command that reads every stage at once, so what it has
 * to get right is the reading rather than any single verdict: five states, a
 * reason whenever a cell is waiting on somebody else's yes, and exactly one
 * "Dalej:" for the episode. The ladder is frozen as a snapshot of the cells,
 * without the stage objects they carry, because those are each stage's own
 * contract and are proved next to each stage; what is proved here is that the
 * cell carries them unchanged.
 */

vi.mock("../lib/env.js", () => ({ env: { AIMATOR_FFMPEG: "/nonexistent/aimator-ffmpeg" } }));

const STATES = new Set(["approved", "blocked", "ready", "review", "running"]);
const WORD = /^[a-z][a-z-]*$/;
const USAGE_LINE = /^ {2}(\S+)(?: (\S+))?/;
const NEXT_LINE = /^Dalej: (.*)$/gm;
const INVOCATION = /^aimator (\S+)(?: (\S+))?/;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let usage = "";

function answer(): string {
  return JSON.stringify({
    clips: ["C01", "C02"].map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

interface Cell {
  readonly character: string | null;
  readonly id: string;
  readonly nextStep: string | null;
  readonly reason: string | null;
  readonly stage: number;
  readonly state: string;
  readonly status: Record<string, unknown>;
  readonly title: string;
  readonly track: string | null;
}

interface Episode {
  readonly cells: readonly Cell[];
  readonly command: string;
  readonly episodeId: string;
  readonly next: { readonly cell: string; readonly command: string } | null;
  readonly projectId: string;
}

async function status(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

async function json(...argv: readonly string[]): Promise<Episode> {
  return JSON.parse(await status(...argv, "--json")) as Episode;
}

/** The ladder alone: what the cells say, without the stage objects they carry. */
function ladder(episode: Episode): readonly string[] {
  return episode.cells.map((cell) => `${cell.id} ${cell.title}: ${cell.state}`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-status-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-status-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;
  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  await makeCut({ root, track: "gpt-image", workspace });

  const help = await run(["--help"]);

  if (!help.ok) {
    throw help.error;
  }

  usage = help.data;
}, 240_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("status --json", () => {
  it("should give every stage, track and character a cell in one of five states", async () => {
    const episode = await json("status", PROJECT, EPISODE);

    expect(episode.command).toBe("status");
    expect(ladder(episode)).toMatchSnapshot();

    for (const cell of episode.cells) {
      expect(STATES).toContain(cell.state);
    }
  });

  it("should carry each stage's own object, unchanged", async () => {
    const episode = await json("status", PROJECT, EPISODE);
    const cell = episode.cells.find((one) => one.id === "5/gpt-image");
    const own = await checkReferences({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    if (!own.ok) {
      throw own.error;
    }

    expect(cell?.status).toEqual(JSON.parse(JSON.stringify(own.data)));
  });

  it("should name exactly one next step for the episode", async () => {
    const episode = await json("status", PROJECT, EPISODE);
    const text = await status("status", PROJECT, EPISODE);

    expect(episode.next).not.toBeNull();
    expect(text.match(NEXT_LINE)).toHaveLength(1);
  });

  it("should fail the same way with the flag as without it", async () => {
    const plain = await run(["status", "nie-ma-takiego", EPISODE, "--workspace", root]);
    const tagged = await run(["status", "nie-ma-takiego", EPISODE, "--workspace", root, "--json"]);

    expect(plain.ok).toBe(false);
    expect(tagged.ok).toBe(false);

    if (plain.ok || tagged.ok) {
      return;
    }

    expect(tagged.error.name).toBe(plain.error.name);
    expect(tagged.error.message).toBe(plain.error.message);
  });
});

describe("the ladder", () => {
  it("should block stage 5 on stage 4, and say so", async () => {
    const pending = await mkdtemp(join(tmpdir(), "aimator-status-pending-"));
    const source = await mkdtemp(join(tmpdir(), "aimator-status-pending-src-"));
    const resolved = resolveWorkspace(pending);

    if (!resolved.ok) {
      throw resolved.error;
    }

    await makeUpstream({
      answer: answer(),
      approvePackage: false,
      root: pending,
      scratch: source,
      workspace: resolved.data,
    });

    const result = await run(["status", PROJECT, EPISODE, "--json", "--workspace", pending]);

    if (!result.ok) {
      throw result.error;
    }

    const episode = JSON.parse(result.data) as Episode;
    const cell = episode.cells.find((one) => one.id === "5/gpt-image");

    expect(cell?.state).toBe("blocked");
    expect(cell?.reason).toContain("etap 4");

    await rm(pending, { force: true, recursive: true });
    await rm(source, { force: true, recursive: true });
  }, 240_000);

  /**
   * The one thing on this screen that a terminal can change under it.
   *
   * A stage writing right now and a stage that has written nothing yet are
   * identical in every artifact they own, so the lock is the only evidence
   * there is, which is also why it has to be read **both ways**: a cell that
   * went to "w toku" and stayed there after the work finished would be worse
   * than one that never said it, because a person would stop believing the
   * column. Stage 1 is where it matters first: its lock is held for as long as
   * a paid call takes to answer.
   */
  it("should follow stage 1's lock into work in progress and back out of it", async () => {
    const project = projectPaths(workspace, PROJECT);

    if (!project.ok) {
      throw project.error;
    }

    const episode = episodePaths(project.data, EPISODE);

    if (!episode.ok) {
      throw episode.error;
    }

    const held = episode.data.screenplayLock;
    const before = await json("status", PROJECT, EPISODE);

    await writeFile(held, "", "utf8");

    const during = await json("status", PROJECT, EPISODE);

    await rm(held, { force: true });

    const after = await json("status", PROJECT, EPISODE);
    const stage1 = (reported: Episode): string | undefined =>
      reported.cells.find((one) => one.id === "1")?.state;

    expect(stage1(during)).toBe("running");
    expect(stage1(after)).toBe(stage1(before));
    expect(stage1(after)).not.toBe("running");
  });

  it("should read a stage's lock file as work in progress, on that track alone", async () => {
    const project = projectPaths(workspace, PROJECT);

    if (!project.ok) {
      throw project.error;
    }

    const episode = episodePaths(project.data, EPISODE);

    if (!episode.ok) {
      throw episode.error;
    }

    const held = episodeTrackPaths(episode.data, "seedream").clipsLock;
    await mkdir(dirname(held), { recursive: true });
    await writeFile(held, "", "utf8");

    const reported = await json("status", PROJECT, EPISODE);
    // The track had no directory before this: stage 0 refuses an empty one,
    // so the lock takes its parent with it.
    await rm(dirname(held), { force: true, recursive: true });

    expect(reported.cells.find((one) => one.id === "7/seedream")?.state).toBe("running");
    expect(reported.cells.find((one) => one.id === "7/gpt-image")?.state).not.toBe("running");
  });
});

describe("the text render", () => {
  it("should point at a command the usage text defines", async () => {
    const commands = new Set<string>();

    for (const line of usage.split("\n")) {
      const [, first, second] = USAGE_LINE.exec(line) ?? [];

      if (!(first && WORD.test(first))) {
        continue;
      }

      commands.add(second && WORD.test(second) ? `${first} ${second}` : first);
    }

    const text = await status("status", PROJECT, EPISODE);
    const unknown: string[] = [];

    for (const [, step] of text.matchAll(NEXT_LINE)) {
      const [, first, second] = INVOCATION.exec(step ?? "") ?? [];

      if (!(first && (commands.has(`${first} ${second ?? ""}`) || commands.has(first)))) {
        unknown.push(step ?? "");
      }
    }

    expect(unknown).toEqual([]);
  });
});
