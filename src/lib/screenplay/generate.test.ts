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

  it("should report a missing stage-0 approval while still showing the prompt", async () => {
    await rm(root, { force: true, recursive: true });
    root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
    const resolved = resolveWorkspace(root);
    workspace = resolved.ok ? resolved.data : { root: "" };
    await makeStage0(false);

    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("approved");
    expect(result.ok ? result.data.prompt : null).toContain("# Task:");
    expect(result.ok ? result.data.ready : true).toBe(false);
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
        readFile(join(episodeDir(), "runs", id, "previous-screenplay.md"), "utf8").catch(() => "")
      )
    );

    expect(kept).toContain(first);
  });

  it("should release the lock so the next attempt is not blocked by the last", async () => {
    await generate();

    expect(await readdir(episodeDir())).not.toContain("screenplay.lock");
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
    expect(result.ok ? result.data.problems.join("\n") : "").toContain("hashem");
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
});

describe("resuming a submitted attempt", () => {
  // The response is already paid for and archived. Re-deriving a verdict from
  // it must never cost a second call — otherwise a validator bug is billable.
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
