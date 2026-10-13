import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCharacter,
  addEpisode,
  approveStage0,
  initProject,
  setCharacterBasis,
  setEpisodeSettings,
} from "../project/index.js";
import { generateShotList } from "../shot-list/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { approveScreenplay, checkScreenplay, generateScreenplay } from "./index.js";

const API_KEY = "sk-test-0123456789";
const SHA256 = /^[0-9a-f]{64}$/;
const EPISODE = "01-burza";
const PROJECT = "ewa";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let calls = 0;

function episodeDir(): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE);
}

/** A structurally valid 30-second draft: three scenes, no on-screen text. */
function draft(seconds: readonly number[] = [10, 10, 10], text = "none"): string {
  const sections = [
    "Premise",
    "Logline",
    "Synopsis",
    "Beats",
    "Characters and locations",
    "Scenes",
    "Review",
  ];
  const scenes = seconds
    .map((value, index) =>
      [
        `### S${String(index + 1).padStart(2, "0")} | ${value}s | kuchnia, wieczór`,
        "",
        "- Action: Ewa siada przy stole i patrzy w okno.",
        "- Audio: Narrator opisuje ciszę przed burzą.",
        `- Text: ${text}`,
        "- End state: Ewa przy stole, dłonie na kolanach.",
        "",
      ].join("\n")
    )
    .join("\n");

  return sections
    .map((name) => `## ${name}\n\n${name === "Scenes" ? scenes : `Treść sekcji ${name}.`}\n`)
    .join("\n");
}

function completion(text: string): string {
  return JSON.stringify({
    id: "resp_abc123",
    model: "gpt-6-astra",
    output: [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }],
    status: "completed",
  });
}

function respondWith(body: string, status = 200): typeof fetch {
  return (() => {
    calls += 1;
    return Promise.resolve(new Response(body, { headers: { "x-request-id": "req_1" }, status }));
  }) as unknown as typeof fetch;
}

async function generate(
  overrides: Partial<Parameters<typeof generateScreenplay>[0]> = {}
): ReturnType<typeof generateScreenplay> {
  return await generateScreenplay({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(completion(draft())),
    maxOutputTokens: 12_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    workspace,
    ...overrides,
  });
}

async function makeStage0(approve = true): Promise<void> {
  const source = join(scratch, "01-Burza.md");
  await writeFile(source, "# Burza\n\nEwa boi się burzy.\n", "utf8");

  await initProject({
    aspectRatio: "16:9",
    mode: "apply",
    projectId: PROJECT,
    title: "Dzielna Ewa",
    workspace,
  });
  await addCharacter({
    characterId: "ewa",
    mode: "apply",
    name: "Ewa",
    projectId: PROJECT,
    workspace,
  });
  await setCharacterBasis({
    basis: "description",
    characterId: "ewa",
    mode: "apply",
    projectId: PROJECT,
    workspace,
  });
  await writeFile(join(root, "projects", PROJECT, "project.md"), "# Ewa\n\nZasady.\n", "utf8");
  await addEpisode({
    mode: "apply",
    projectId: PROJECT,
    settings: {},
    sourcePath: source,
    workspace,
  });
  await setEpisodeSettings({
    episodeId: EPISODE,
    mode: "apply",
    projectId: PROJECT,
    settings: {
      audio: "narration",
      durationSeconds: 30,
      language: "pl",
      sourceNature: "law-or-idea",
      subtitles: "none",
    },
    workspace,
  });

  if (approve) {
    await approveStage0({
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
  }
}

interface StageJson {
  readonly artifacts: {
    readonly screenplay: {
      readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
      readonly outputs: readonly { readonly path: string; readonly sha256: string }[];
      readonly producer: {
        readonly kind: string;
        readonly model: string;
        readonly promptVersion: number;
      };
      readonly review: { readonly status: string };
      readonly status: string;
    };
  };
  readonly stage: string;
}

async function readStage(): Promise<StageJson> {
  const text = await readFile(join(episodeDir(), "screenplay.stage.json"), "utf8");
  return JSON.parse(text) as StageJson;
}

async function readValidation(runId: string): Promise<{ structuralValidation: string }> {
  const text = await readFile(join(episodeDir(), "runs", runId, "validation.json"), "utf8");
  return JSON.parse(text) as { structuralValidation: string };
}

async function runDirs(): Promise<string[]> {
  try {
    return await readdir(join(episodeDir(), "runs"));
  } catch {
    return [];
  }
}

beforeEach(async () => {
  calls = 0;
  root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-src-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  await makeStage0();
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("generateScreenplay --dry-run", () => {
  it("should return the exact prompt a paid call would send", async () => {
    const result = await generate({ mode: "dry-run" });
    const prompt = result.ok ? result.data.prompt : null;

    expect(prompt).toContain("# Task: write a screenplay for a short animated story");
    expect(prompt).toContain('"durationSeconds": 30');
    expect(prompt).toContain("Ewa boi się burzy.");
    expect(prompt).toContain("Zasady.");
  });

  /**
   * The bill, in the unit this stage is billed in.
   *
   * Stage 1 buys exactly one call, which is precisely why the count is worth
   * returning: what a person asks a dry run is whether this command is about
   * to buy a screenplay or to tell them it cannot, and zero and one are two
   * different answers to that question. The stages that already draw several
   * images print the same number under the same name.
   */
  it("should count the one paid call it would make", async () => {
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.paidCalls : null).toBe(1);
  });

  it("should touch neither the network nor the workspace", async () => {
    await generate({ mode: "dry-run" });

    expect(calls).toBe(0);
    expect(await runDirs()).toEqual([]);
    expect(await readdir(episodeDir())).toEqual(
      expect.not.arrayContaining(["screenplay.md", "screenplay.stage.json"])
    );
  });

  it("should need neither a key nor a model", async () => {
    const result = await generate({ apiKey: null, mode: "dry-run", model: null });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.prompt : null).toContain("# Task:");
  });

  it("should report a missing stage-0 approval, bill nothing, and still show the prompt", async () => {
    await rm(root, { force: true, recursive: true });
    root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
    const resolved = resolveWorkspace(root);
    workspace = resolved.ok ? resolved.data : { root: "" };
    await makeStage0(false);

    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("approved");
    expect(result.ok ? result.data.prompt : null).toContain("# Task:");
    expect(result.ok ? result.data.ready : true).toBe(false);
    expect(result.ok ? result.data.paidCalls : null).toBe(0);
  });
});

describe("generateScreenplay", () => {
  it("should refuse to pay while stage 0 is unapproved", async () => {
    await rm(root, { force: true, recursive: true });
    root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
    const resolved = resolveWorkspace(root);
    workspace = resolved.ok ? resolved.data : { root: "" };
    await makeStage0(false);

    const result = await generate();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("approved");
    expect(calls).toBe(0);
  });

  it("should refuse to pay without a model", async () => {
    const result = await generate({ model: null });

    expect(result.ok ? "" : result.error.message).toContain("model");
    expect(calls).toBe(0);
  });

  it("should refuse to pay without an API key", async () => {
    const result = await generate({ apiKey: null });

    expect(result.ok ? "" : result.error.message).toContain("OPENAI_API_KEY");
    expect(calls).toBe(0);
  });

  it("should publish the screenplay and record its own inputs by digest", async () => {
    const result = await generate();
    expect(result.ok).toBe(true);

    const stage = await readStage();
    const { screenplay } = stage.artifacts;

    expect(stage.stage).toBe("screenplay");
    expect(screenplay.status).toBe("completed");
    expect(screenplay.inputs).toHaveLength(4);
    expect(screenplay.inputs.every((entry) => SHA256.test(entry.sha256))).toBe(true);
    expect(screenplay.outputs).toHaveLength(1);
    expect(screenplay.review.status).toBe("pending");
    expect(screenplay.producer.kind).toBe("model");
    expect(screenplay.producer.model).toBe("gpt-6-astra");
    expect(screenplay.producer.promptVersion).toBe(1);
  });

  it("should archive the attempt without copying a single input", async () => {
    await generate();
    const [runId = ""] = await runDirs();
    const files = await readdir(join(episodeDir(), "runs", runId));

    expect(files.sort()).toEqual([
      "prompt.md",
      "request.json",
      "response.json",
      "run.json",
      "transport.json",
      "validation.json",
    ]);
  });

  it("should record status submitted before the paid call, not after it", async () => {
    let seen: string | null = null;
    const spy = (() => {
      calls += 1;
      return readFile(join(episodeDir(), "screenplay.stage.json"), "utf8").then((text) => {
        seen = JSON.parse(text).artifacts.screenplay.status;
        return new Response(completion(draft()), { status: 200 });
      });
    }) as unknown as typeof fetch;

    await generate({ fetch: spy });

    expect(seen).toBe("submitted");
  });

  it("should not retry after an HTTP error", async () => {
    const result = await generate({ fetch: respondWith("{}", 500) });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("500");
    expect(calls).toBe(1);
  });

  it("should keep the response and refuse to publish when the model declines", async () => {
    const body = JSON.stringify({
      id: "resp_x",
      output: [{ content: [{ type: "refusal" }], role: "assistant", type: "message" }],
      status: "completed",
    });
    const result = await generate({ fetch: respondWith(body) });
    const [runId = ""] = await runDirs();

    expect(result.ok).toBe(false);
    expect(await readdir(join(episodeDir(), "runs", runId))).toContain("response.json");
    expect(await readdir(episodeDir())).not.toContain("screenplay.md");
  });

  it("should refuse to publish a draft that fails validation", async () => {
    const result = await generate({ fetch: respondWith(completion(draft([10, 10]))) });
    const [runId = ""] = await runDirs();

    expect(result.ok).toBe(false);
    expect((await readValidation(runId)).structuralValidation).toBe("failed");
    expect(await readdir(episodeDir())).not.toContain("screenplay.md");
  });

  it("should redact the API key from the archived response", async () => {
    const body = completion(draft()).replace("resp_abc123", API_KEY);
    await generate({ fetch: respondWith(body) });
    const [runId = ""] = await runDirs();
    const archived = await readFile(join(episodeDir(), "runs", runId, "response.json"), "utf8");

    expect(archived).not.toContain(API_KEY);
    expect(archived).toContain("UKRYTY KLUCZ");
  });

  it("should refuse a second paid call without --regenerate", async () => {
    await generate();
    const result = await generate();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("--regenerate");
    expect(calls).toBe(1);
  });

  it("should start a new attempt and keep the previous result with --regenerate", async () => {
    await generate();
    const first = await readFile(join(episodeDir(), "screenplay.md"), "utf8");
    const result = await generate({
      fetch: respondWith(completion(draft([15, 15]))),
      regenerate: true,
    });
    const runs = await runDirs();

    expect(result.ok).toBe(true);
    expect(runs).toHaveLength(2);
    expect(calls).toBe(2);

    const kept = await Promise.all(
      runs.map((id) =>
        readFile(join(episodeDir(), "runs", id, "previous", "screenplay.md"), "utf8").catch(
          () => ""
        )
      )
    );

    expect(kept).toContain(first);
  });

  it("should release the lock so the next attempt is not blocked by the last", async () => {
    await generate();

    expect(await readdir(episodeDir())).not.toContain("screenplay.lock");
  });
});

/**
 * `--regenerate --instruction`: a correction of what was published, not a
 * second draft in the dark.
 *
 * Assumptions this block encodes: the note is a non-empty string in whatever
 * language its author wrote; the previous version is `screenplay.md` as it
 * stands on disk; the request carries the original prompt, that file and the
 * note, with the note quoted verbatim between markers. Not tested here: the
 * CLI refusal of `--instruction` without `--regenerate`, which is the CLI's.
 */
describe("generateScreenplay --instruction", () => {
  const NOTE = "Skróć dialog w S03, resztę zostaw bez zmian.";

  it("should preview the original prompt, the published screenplay and the note verbatim", async () => {
    await generate();
    const published = await readFile(join(episodeDir(), "screenplay.md"), "utf8");
    const plain = await generate({ mode: "dry-run", regenerate: true });
    const result = await generate({ instruction: NOTE, mode: "dry-run", regenerate: true });
    const prompt = result.ok ? (result.data.prompt ?? "") : "";

    expect(prompt).toContain(plain.ok ? (plain.data.prompt ?? "-") : "-");
    expect(prompt).toContain("# Revision:");
    expect(prompt).toContain(`----- BEGIN screenplay.md -----\n${published}`);
    expect(prompt).toContain(`----- BEGIN NOTE -----\n${NOTE}\n----- END NOTE -----`);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(calls).toBe(1);
  });

  it("should record the note and the corrected version by digest, copied nowhere else", async () => {
    await generate();
    const published = await readFile(join(episodeDir(), "screenplay.md"), "utf8");
    const result = await generate({
      fetch: respondWith(completion(draft([15, 15]))),
      instruction: NOTE,
      regenerate: true,
    });
    const runId = result.ok ? (result.data.runId ?? "") : "";
    const record = (await readStage()).artifacts.screenplay as unknown as {
      readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
      readonly instruction: string | null;
    };
    const previous = `projects/${PROJECT}/episodes/${EPISODE}/runs/${runId}/previous/screenplay.md`;
    const kept = record.inputs.filter((entry) => entry.path.endsWith("screenplay.md"));

    expect(record.instruction).toBe(NOTE);
    expect(record.inputs).toHaveLength(5);
    expect(kept).toEqual([
      { path: previous, sha256: createHash("sha256").update(published).digest("hex") },
    ]);
    expect(await readFile(join(root, previous), "utf8")).toBe(published);
    expect((await readdir(join(episodeDir(), "runs", runId))).sort()).toEqual([
      "previous",
      "prompt.md",
      "request.json",
      "response.json",
      "run.json",
      "transport.json",
      "validation.json",
    ]);
  });

  it("should leave the note out of a plain regeneration's record", async () => {
    await generate();
    await generate({ regenerate: true });
    const record = (await readStage()).artifacts.screenplay as unknown as {
      readonly inputs: readonly unknown[];
      readonly instruction: string | null;
    };

    expect(record.instruction).toBeNull();
    expect(record.inputs).toHaveLength(4);
  });

  it("should refuse a note without --regenerate, sending nothing", async () => {
    await generate();
    const result = await generate({ instruction: NOTE });

    expect(result.ok ? null : result.error.message).toContain("--regenerate");
    expect(calls).toBe(1);
  });

  it("should refuse to correct a screenplay that was never published", async () => {
    const preview = await generate({ instruction: NOTE, mode: "dry-run", regenerate: true });
    const result = await generate({ instruction: NOTE, regenerate: true });

    expect(preview.ok ? preview.data.paidCalls : null).toBe(0);
    expect(preview.ok ? preview.data.problems.join(" ") : "").toContain("--instruction");
    expect(result.ok ? null : result.error.message).toContain("--instruction");
    expect(calls).toBe(0);
  });

  it("should not publish a correction the validator refuses", async () => {
    await generate();
    const published = await readFile(join(episodeDir(), "screenplay.md"), "utf8");
    const result = await generate({
      fetch: respondWith(completion(draft([10, 10]))),
      instruction: NOTE,
      regenerate: true,
    });

    expect(result.ok).toBe(false);
    expect(await readFile(join(episodeDir(), "screenplay.md"), "utf8")).toBe(published);
  });

  it("should not read the corrected version as a changed input, before or after approval", async () => {
    const scope = { episodeId: EPISODE, projectId: PROJECT, workspace };

    await generate();
    await generate({
      fetch: respondWith(completion(draft([15, 15]))),
      instruction: NOTE,
      regenerate: true,
    });
    const before = await checkScreenplay(scope);
    await approveScreenplay({ ...scope, mode: "apply", note: null, reviewer: "test" });
    const after = await checkScreenplay(scope);
    const record = (await readStage()).artifacts.screenplay;

    expect(before.ok ? before.data.problems : null).toEqual([]);
    expect(after.ok ? after.data.approved : null).toBe(true);
    expect(record.inputs.filter((entry) => entry.path.includes("/previous/"))).toHaveLength(1);
  });

  it("should finish a saved correction for free, keeping its note and its corrected version", async () => {
    await generate();
    const failed = await generate({
      fetch: respondWith(completion(draft([10, 10]))),
      instruction: NOTE,
      regenerate: true,
    });
    const runId = (await readStage()).artifacts.screenplay as unknown as { readonly runId: string };
    await writeFile(
      join(episodeDir(), "runs", runId.runId, "response.json"),
      completion(draft([15, 15])),
      "utf8"
    );

    const result = await generate();
    const record = (await readStage()).artifacts.screenplay as unknown as {
      readonly inputs: readonly { readonly path: string }[];
      readonly instruction: string | null;
      readonly status: string;
    };

    expect(failed.ok).toBe(false);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(record.status).toBe("completed");
    expect(record.instruction).toBe(NOTE);
    expect(record.inputs.filter((entry) => entry.path.includes("/previous/"))).toHaveLength(1);
  });
});

describe("checkScreenplay and approveScreenplay", () => {
  const scope = (): { episodeId: string; projectId: string; workspace: Workspace } => ({
    episodeId: EPISODE,
    projectId: PROJECT,
    workspace,
  });

  function approve(): ReturnType<typeof approveScreenplay> {
    return approveScreenplay({ ...scope(), mode: "apply", note: null, reviewer: "test" });
  }

  it("should report an absent stage 1 without inventing one", async () => {
    const result = await checkScreenplay(scope());

    expect(result.ok ? result.data.status : null).toBe("absent");
    expect(result.ok ? result.data.approved : true).toBe(false);
  });

  it("should report a generated screenplay as valid but not accepted", async () => {
    await generate();
    const result = await checkScreenplay(scope());

    expect(result.ok ? result.data.status : null).toBe("completed");
    expect(result.ok ? result.data.problems : ["x"]).toEqual([]);
    expect(result.ok ? result.data.approved : true).toBe(false);
    expect(result.ok ? result.data.verdict?.scenes : null).toBe(3);
  });

  it("should refuse to approve what does not exist", async () => {
    const result = await approve();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("nie ma czego zatwierdzić");
  });

  it("should bind an approval to the bytes that were verified", async () => {
    await generate();
    expect((await approve()).ok).toBe(true);

    const stage = await readStage();
    expect(stage.artifacts.screenplay.review.status).toBe("approved");
    expect((await checkScreenplay(scope())).ok).toBe(true);
  });

  it("should stop treating an edited screenplay as approved", async () => {
    await generate();
    await approve();
    await writeFile(join(episodeDir(), "screenplay.md"), "zmienione ręcznie\n", "utf8");

    const result = await checkScreenplay(scope());

    expect(result.ok ? result.data.approved : true).toBe(false);
    expect(result.ok ? result.data.problems.join("\n") : "").toContain("screenplay.md: ");
  });

  it("should refuse to approve a screenplay that no longer validates", async () => {
    await generate();
    await writeFile(join(episodeDir(), "screenplay.md"), "zmienione ręcznie\n", "utf8");

    const result = await approve();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("nie przechodzi walidacji");
  });

  it("should report a stage-0 input that changed after generation", async () => {
    await generate();
    await writeFile(
      join(root, "projects", PROJECT, "project.md"),
      "# Ewa\n\nInne zasady.\n",
      "utf8"
    );

    const result = await checkScreenplay(scope());

    expect(result.ok ? result.data.inputsChanged : []).toContain(`projects/${PROJECT}/project.md`);
  });

  it("should revoke an approval when a stage-0 input changes", async () => {
    await generate();
    await approve();
    await writeFile(
      join(root, "projects", PROJECT, "project.md"),
      "# Ewa\n\nInne zasady.\n",
      "utf8"
    );

    const result = await checkScreenplay(scope());

    expect(result.ok ? result.data.approved : null).toBe(false);
  });

  // Drift is a lapsed consent, not a broken screenplay: the draft still
  // validates against the decisions on disk. Refusing here would leave the one
  // command able to clear the drift forbidden by it, and the only way on would
  // be a second paid screenplay.
  it("should let a human re-approve over a changed input, re-recording it", async () => {
    await generate();
    await approve();
    await writeFile(
      join(root, "projects", PROJECT, "project.md"),
      "# Ewa\n\nInne zasady.\n",
      "utf8"
    );

    const again = await approve();

    expect(again.ok ? again.data.approved : again.error.message).toBe(true);

    const after = await checkScreenplay(scope());

    expect(after.ok ? after.data.inputsChanged : null).toEqual([]);
    expect(after.ok ? after.data.approved : null).toBe(true);
  });

  // The digest only ever caught the cosmetic half. A decision the screenplay
  // actually answers fails the structural check first, and that still blocks.
  it("should still refuse when a changed decision makes the draft wrong", async () => {
    await generate();
    await approve();
    await setEpisodeSettings({
      episodeId: EPISODE,
      mode: "apply",
      projectId: PROJECT,
      settings: { durationSeconds: 45 },
      workspace,
    });

    const again = await approve();

    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.error.message).toContain("nie przechodzi walidacji");
  });
});

/**
 * A screenplay a person corrected by hand, which is a lapsed consent, not a forgery.
 *
 * The digest still guards the bytes: a changed file is never silently carried
 * forward as what the model wrote. What changes is the reading. A correction
 * that still passes the stage's own verdict is unread rather than broken, the
 * same situation as an edited `project.md`, so `approve` is what accepts it,
 * and the record says both things at once: `producer` names what generated the
 * first version, `amendments` that a person changed it afterwards.
 *
 * Assumptions: the correction is made in place, on the published file; one
 * that breaks the verdict is still a refusal, and the validator says why.
 */
describe("a screenplay corrected by hand", () => {
  const PATH = `projects/${PROJECT}/episodes/${EPISODE}/screenplay.md`;
  const scope = (): { episodeId: string; projectId: string; workspace: Workspace } => ({
    episodeId: EPISODE,
    projectId: PROJECT,
    workspace,
  });

  function approve(): ReturnType<typeof approveScreenplay> {
    return approveScreenplay({ ...scope(), mode: "apply", note: null, reviewer: "test" });
  }

  /** The same draft, one sentence of action reworded: it still validates. */
  async function correct(): Promise<string> {
    const text = draft().replace("Ewa siada przy stole", "Ewa staje przy oknie");
    await writeFile(join(episodeDir(), "screenplay.md"), text, "utf8");

    return text;
  }

  function digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  it("should report a correction that validates as a lapsed consent, not an error", async () => {
    await generate();
    await approve();
    await correct();

    const result = await checkScreenplay(scope());
    const problems = result.ok ? result.data.problems.join("\n") : "";

    expect(result.ok ? result.data.amended : null).toEqual([PATH]);
    expect(result.ok ? result.data.approved : null).toBe(false);
    expect(problems).toContain(`${PATH}: poprawiony ręcznie po generacji`);
    expect(problems).toContain(`aimator approve ${PROJECT} ${EPISODE} --stage screenplay`);
    expect(problems).not.toContain("poza narzędziem");
  });

  it("should accept the correction, rebinding its digest and recording who made it", async () => {
    await generate();
    const generated = await readFile(join(episodeDir(), "screenplay.md"), "utf8");
    const text = await correct();

    const result = await approve();

    expect(result.ok ? result.data.approved : result.error.message).toBe(true);

    const record = (await readStage()).artifacts
      .screenplay as StageJson["artifacts"]["screenplay"] & {
      readonly amendments: readonly Record<string, string>[];
    };

    expect(record.outputs).toEqual([{ path: PATH, sha256: digest(text) }]);
    expect(record.producer.kind).toBe("model");
    expect(record.amendments).toEqual([
      {
        at: expect.any(String),
        from: digest(generated),
        path: PATH,
        reviewer: "test",
        to: digest(text),
      },
    ]);

    const after = await checkScreenplay(scope());

    expect(after.ok ? after.data.amended : null).toEqual([]);
    expect(after.ok ? after.data.approved : null).toBe(true);
  });

  it("should refuse a correction that breaks the verdict, and say why", async () => {
    await generate();
    await writeFile(
      join(episodeDir(), "screenplay.md"),
      draft().replace("| 10s |", "| 12s |"),
      "utf8"
    );

    const checked = await checkScreenplay(scope());
    const result = await approve();

    expect(checked.ok ? checked.data.problems.join("\n") : "").toContain("screenplay.md: ");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("nie przechodzi walidacji");
  });

  it("should regenerate from the corrected version, which is the one replaced", async () => {
    await generate();
    await approve();
    const text = await correct();

    const result = await generate({ instruction: "Skróć S02.", mode: "dry-run", regenerate: true });

    expect(result.ok ? result.data.prompt : "").toContain(text.trim());
  });
});

describe("resuming a submitted attempt", () => {
  // The response is already paid for and archived. Re-deriving a verdict from
  // it must never cost a second call, otherwise a validator bug is billable.
  it("should re-validate a saved response instead of calling the API again", async () => {
    await generate({ fetch: respondWith(completion(draft([10, 10]))) });
    expect(calls).toBe(1);

    const result = await generate();

    expect(calls).toBe(1);
    expect(result.ok ? "" : result.error.message).toContain("20");
  });
});

describe("refusing to resume", () => {
  it("should say the attempt may have been billed when no response was saved", async () => {
    await generate({ fetch: respondWith(completion(draft([10, 10]))) });
    const [runId = ""] = await runDirs();
    await rm(join(episodeDir(), "runs", runId, "response.json"));

    const result = await generate();

    expect(calls).toBe(1);
    expect(result.ok ? "" : result.error.message).toContain("mogła zostać rozliczona");
  });

  it("should block on the approval gate when an input changed", async () => {
    await generate({ fetch: respondWith(completion(draft([10, 10]))) });
    await writeFile(join(root, "projects", PROJECT, "project.md"), "# Ewa\n\nInne.\n", "utf8");

    const result = await generate();

    expect(calls).toBe(1);
    expect(result.ok ? "" : result.error.message).toContain("approved");
  });

  it("should refuse to publish a saved response against re-approved inputs", async () => {
    await generate({ fetch: respondWith(completion(draft([10, 10]))) });
    await writeFile(join(root, "projects", PROJECT, "project.md"), "# Ewa\n\nInne.\n", "utf8");
    // Re-approved, so the stage-0 gate passes and the saved answer is the only
    // thing left that still describes the old rules.
    await approveStage0({
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });

    const result = await generate();

    expect(calls).toBe(1);
    expect(result.ok ? "" : result.error.message).toContain("opisuje inne wejście");
  });

  /**
   * The case that actually happened: the archived answer was fine all along and
   * the validator was wrong. Swapping the archived body stands in for fixing
   * the validator, because the bug it caught is now fixed in the code.
   */
  it("should publish a saved response the validator now accepts, without paying", async () => {
    await generate({ fetch: respondWith(completion(draft([10, 10]))) });
    const [runId = ""] = await runDirs();
    await writeFile(
      join(episodeDir(), "runs", runId, "response.json"),
      completion(draft([10, 10, 10], "none.")),
      "utf8"
    );

    const result = await generate();

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect((await readStage()).artifacts.screenplay.status).toBe("completed");
    expect(await readFile(join(episodeDir(), "screenplay.md"), "utf8")).toContain("Text: none.");
  });
});

describe("generateScreenplay refusals", () => {
  function rejecting(status: number, body: unknown): typeof fetch {
    return (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        })
      );
    }) as unknown as typeof fetch;
  }

  /**
   * The diagnostics are the whole value of a refusal. Judging the answer before
   * archiving it threw the body away, which is how a 400 became "check the
   * model, access and balance" and nothing else.
   */
  it("should archive the body of a rejected call before reporting it", async () => {
    const result = await generate({
      fetch: rejecting(400, { error: { code: "model_not_found", message: "nie ma modelu" } }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("nie ma modelu");
    expect(result.ok ? null : result.error.message).toContain("model_not_found");

    const [runId] = await runDirs();
    const saved = JSON.parse(
      await readFile(join(episodeDir(), "runs", String(runId), "response.json"), "utf8")
    );
    expect(saved.error.code).toBe("model_not_found");
  });

  /**
   * A 4xx is the provider declining to do the work, so nothing was charged.
   * Demanding `--regenerate` afterwards would make a rejected request look
   * like a paid one.
   */
  it("should let a plain re-run follow a refusal that cannot have been billed", async () => {
    await generate({ fetch: rejecting(400, { error: { message: "nie ma modelu" } }) });

    const result = await generate();

    expect(result.ok && result.data.verdict?.scenes).toBe(3);
  });

  it("should keep the --regenerate rule after a status that may have been billed", async () => {
    await generate({ fetch: rejecting(503, { error: { message: "przeciążenie" } }) });

    const result = await generate();

    expect(result.ok ? null : result.error.message).toContain("HTTP 503");
    expect(result.ok ? null : result.error.message).toContain("--regenerate");
  });
});

/**
 * A screenplay already written in this pipeline's format, accepted as it is.
 *
 * Assumptions: `--verbatim` reads `source.md` and nothing outside the
 * workspace, so stage 0's monopoly on bringing files in stays intact. The gate
 * is generation's own (stage 0 approved), plus two of its own: the episode says
 * its source *is* a screenplay, and that source passes the same verdict a paid
 * answer has to. It buys nothing, so it needs no model, no key and no network.
 * Not tested here: the CLI's refusal of paid-only flags, which is grammar.
 */
describe("generateScreenplay --verbatim", () => {
  const READY = "02-gotowy";

  function readyDir(): string {
    return join(root, "projects", PROJECT, "episodes", READY);
  }

  /** A second episode whose source is a screenplay, and stage 0 approved again. */
  async function makeReady(text = draft(), nature: "screenplay" | "synopsis" = "screenplay") {
    const source = join(scratch, `${READY}.md`);
    await writeFile(source, text, "utf8");
    await addEpisode({
      mode: "apply",
      projectId: PROJECT,
      settings: {
        audio: "narration",
        durationSeconds: 30,
        language: "pl",
        maxClipSeconds: 10,
        sourceNature: nature,
        subtitles: "none",
      },
      sourcePath: source,
      workspace,
    });
    await approveStage0({
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
  }

  function verbatim(
    overrides: Partial<Parameters<typeof generateScreenplay>[0]> = {}
  ): ReturnType<typeof generateScreenplay> {
    return generate({
      apiKey: null,
      episodeId: READY,
      fetch: respondWith(completion(draft())),
      model: null,
      verbatim: true,
      ...overrides,
    });
  }

  it("should publish source.md as screenplay.md byte for byte, buying nothing", async () => {
    await makeReady();

    const result = await verbatim();
    const stage = JSON.parse(await readFile(join(readyDir(), "screenplay.stage.json"), "utf8"));
    const record = stage.artifacts.screenplay;

    expect(result.ok ? result.data.paidCalls : result.error.message).toBe(0);
    expect(calls).toBe(0);
    expect(await readFile(join(readyDir(), "screenplay.md"))).toEqual(
      await readFile(join(readyDir(), "source.md"))
    );
    expect(record).toMatchObject({
      producer: { kind: "manual" },
      review: { status: "pending" },
      status: "completed",
    });
    expect(record.inputs).toEqual([
      {
        path: `projects/${PROJECT}/episodes/${READY}/source.md`,
        sha256: createHash("sha256")
          .update(await readFile(join(readyDir(), "source.md")))
          .digest("hex"),
      },
    ]);
  });

  it("should refuse an episode whose source is not a screenplay", async () => {
    await makeReady(draft(), "synopsis");

    const result = await verbatim();

    expect(result.ok ? null : result.error.message).toContain('sourceNature "synopsis"');
    expect(result.ok ? null : result.error.message).toContain("kupi adaptację");
    expect(await readdir(readyDir())).not.toContain("screenplay.md");
  });

  it("should refuse a source the verdict rejects, naming why, and write nothing", async () => {
    await makeReady(draft([16, 14]));
    const before = await readdir(readyDir());

    const result = await verbatim();

    expect(result.ok ? null : result.error.message).toContain("source.md:");
    expect(result.ok ? null : result.error.message).toContain("16");
    expect(result.ok ? null : result.error.message).toContain("kupi adaptację");
    expect(await readdir(readyDir())).toEqual(before);
  });

  it("should refuse while stage 0 is not approved, as generation does", async () => {
    await makeReady();
    await setEpisodeSettings({
      episodeId: READY,
      mode: "apply",
      projectId: PROJECT,
      settings: { durationSeconds: 30 },
      workspace,
    });

    const result = await verbatim();

    expect(result.ok ? null : result.error.message).toContain(
      `etap 0 musi mieć review.status = "approved"`
    );
    expect(result.ok ? null : result.error.message).toContain(`aimator approve ${PROJECT}`);
    expect(await readdir(readyDir())).not.toContain("screenplay.md");
  });

  it("should be approved like any screenplay, after which stage 3 may pay", async () => {
    await makeReady();
    await verbatim();

    const approved = await approveScreenplay({
      episodeId: READY,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
    const next = await generateShotList({
      apiKey: null,
      episodeId: READY,
      fetch: respondWith(completion(draft())),
      maxOutputTokens: 12_000,
      mode: "dry-run",
      model: "gpt-6-astra",
      projectId: PROJECT,
      regenerate: false,
      workspace,
    });

    expect(approved.ok ? approved.data.approved : approved.error.message).toBe(true);
    expect(next.ok ? next.data.problems : next.error.message).toEqual([]);
    expect(next.ok && next.data.paidCalls).toBe(1);
  });

  it("should refuse to replace a screenplay without --regenerate", async () => {
    await makeReady();
    await verbatim();

    const again = await verbatim();

    expect(again.ok ? null : again.error.message).toContain("--verbatim --regenerate");
  });

  it("should replace a screenplay under --regenerate, keeping the old one in previous/", async () => {
    await makeReady();
    await verbatim();
    await writeFile(join(readyDir(), "screenplay.md"), "poprawione ręcznie\n", "utf8");

    const again = await verbatim({ regenerate: true });
    const runId = again.ok ? String(again.data.runId) : again.error.message;

    expect(
      await readFile(join(readyDir(), "runs", runId, "previous", "screenplay.md"), "utf8")
    ).toBe("poprawione ręcznie\n");
    expect(await readFile(join(readyDir(), "screenplay.md"), "utf8")).toBe(draft());
  });

  it("should write nothing under --dry-run and say it buys nothing", async () => {
    await makeReady();
    const before = await readdir(readyDir());

    const preview = await verbatim({ mode: "dry-run" });

    expect(preview.ok ? preview.data : preview.error.message).toMatchObject({
      paidCalls: 0,
      problems: [],
      prompt: null,
      ready: true,
    });
    expect(await readdir(readyDir())).toEqual(before);
  });
});
