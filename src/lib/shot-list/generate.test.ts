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
import { approveScreenplay, generateScreenplay } from "../screenplay/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { approveShotList, checkShotList, generateShotList } from "./index.js";

/**
 * Stage 3 end to end, through the module entry: the gate on the approved
 * screenplay, the dry run that touches nothing, the single paid attempt, the
 * resume that costs nothing, and the approval that is never implied.
 */

const API_KEY = "sk-test-0123456789";
const EPISODE = "01-burza";
const PROJECT = "ewa";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let calls = 0;

function episodeDir(): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE);
}

/** A structurally valid 30-second screenplay: three scenes, no on-screen text. */
function screenplay(): string {
  const sections = [
    "Premise",
    "Logline",
    "Synopsis",
    "Beats",
    "Characters and locations",
    "Scenes",
    "Review",
  ];
  const scenes = [1, 2, 3]
    .map((number) =>
      [
        `### S0${number} | 10s | salon, wieczór`,
        "",
        "- Action: Ewa odsuwa krzesło i siada przy stole.",
        "- Audio: Narrator opisuje ciszę.",
        "- Text: none",
        "- End state: Ewa przy stole, dłonie na blacie.",
        "",
      ].join("\n")
    )
    .join("\n");

  return sections
    .map((name) => `## ${name}\n\n${name === "Scenes" ? scenes : `Treść sekcji ${name}.`}\n`)
    .join("\n");
}

function shot(id: string, scene: string, clip: string, range: string): string {
  return [
    `### ${id} | ${scene} | ${clip} | ${range}`,
    "",
    "- Purpose: Pokazuje, że Ewa zostaje sama z burzą.",
    "- Frame: Plan amerykański, Ewa po prawej trzeciej kadru.",
    "- Action: Ewa odsuwa krzesło (2 s) i siada (2 s).",
    "- Expression: Zaciśnięte usta, wzrok w okno.",
    "- Camera: Statyczny kadr, cięcie na osi.",
    "- Cast: ewa",
    "- Audio: Deszcz o szybę, narrator kończy zdanie.",
    "- Text: none",
    "- Start state: Ewa stoi przy krześle, obie dłonie wolne.",
    "- End state: Ewa siedzi, dłonie na blacie.",
    "",
  ].join("\n");
}

/** A plan that covers the 30 seconds in two clips of 15. */
function plan(): string {
  return [
    "## Plan\n\nDwa klipy, cięcie na akcji, kadr 16:9.\n",
    [
      "## Clips",
      "",
      "### C01 | 0-15s",
      "",
      "- Shots: U01,U02",
      "- Reference: opening-frame",
      "- Continuity: Ewa przy stole, światło lampy od lewej.",
      "",
      "### C02 | 15-30s",
      "",
      "- Shots: U03,U04",
      "- Reference: previous-end-frame",
      "- Continuity: Ewa siedzi, dłonie na blacie.",
      "",
    ].join("\n"),
    [
      "## Shots",
      "",
      shot("U01", "S01", "C01", "0-10s"),
      shot("U02", "S02", "C01", "10-15s"),
      shot("U03", "S02", "C02", "15-20s"),
      shot("U04", "S03", "C02", "20-30s"),
    ].join("\n"),
    "## Review\n\nSprawdzono sumy czasów i ciągłość. Plan wymaga oceny.\n",
  ].join("\n");
}

function completion(text: string): string {
  return JSON.stringify({
    id: "resp_shot_1",
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
  overrides: Partial<Parameters<typeof generateShotList>[0]> = {}
): ReturnType<typeof generateShotList> {
  return await generateShotList({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(completion(plan())),
    maxOutputTokens: 24_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    workspace,
    ...overrides,
  });
}

/** Stage 0 with all six decisions, then a generated and approved screenplay. */
async function makeUpstream(options: { approve?: boolean; maxClipSeconds?: number | null } = {}) {
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
      maxClipSeconds: options.maxClipSeconds === undefined ? 15 : options.maxClipSeconds,
      sourceNature: "law-or-idea",
      subtitles: "none",
    },
    workspace,
  });
  await approveStage0({
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
  await generateScreenplay({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(completion(screenplay())),
    maxOutputTokens: 12_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    workspace,
  });

  if (options.approve !== false) {
    await approveScreenplay({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
  }

  calls = 0;
}

interface StageJson {
  readonly artifacts: {
    readonly "shot-list": {
      readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
      readonly outputs: readonly { readonly path: string; readonly sha256: string }[];
      readonly producer: { readonly kind: string; readonly promptVersion: number };
      readonly review: { readonly status: string };
      readonly runId: string;
      readonly status: string;
    };
  };
  readonly stage: string;
}

async function readStage(): Promise<StageJson> {
  return JSON.parse(
    await readFile(join(episodeDir(), "shot-list.stage.json"), "utf8")
  ) as StageJson;
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
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("generateShotList --dry-run", () => {
  it("should show the prompt and send nothing", async () => {
    await makeUpstream();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(calls).toBe(0);
    expect(result.ok ? result.data.ready : null).toBe(true);
    expect(result.ok ? result.data.prompt : "").toContain("### S01 | 10s | salon, wieczór");
    expect(result.ok ? result.data.created : null).toEqual([]);
  });

  it("should write nothing at all", async () => {
    await makeUpstream();
    // Stage 1's own archive already sits in `runs/`; a dry run adds none.
    const before = await runDirs();
    await generate({ apiKey: null, mode: "dry-run" });

    expect(await runDirs()).toEqual(before);
    await expect(readStage()).rejects.toThrow();
  });

  it("should report the unapproved screenplay as an obstacle and still show the prompt", async () => {
    await makeUpstream({ approve: false });
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.ready : null).toBe(false);
    expect(result.ok ? result.data.problems.join("\n") : "").toContain("--stage screenplay");
    expect(result.ok ? result.data.prompt : null).not.toBeNull();
  });

  it("should report an undecided clip limit and build no prompt without it", async () => {
    await makeUpstream({ maxClipSeconds: null });
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("maxClipSeconds");
    expect(result.ok ? result.data.prompt : "x").toBeNull();
  });

  it("should not claim a missing key it never looked for", async () => {
    await makeUpstream();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").not.toContain("OPENAI_API_KEY");
  });
});

describe("generateShotList", () => {
  it("should refuse to pay while the screenplay is unapproved", async () => {
    await makeUpstream({ approve: false });
    const result = await generate();

    expect(calls).toBe(0);
    expect(result.ok ? null : result.error.message).toContain("--stage screenplay");
  });

  it("should refuse to pay while the clip limit is undecided", async () => {
    await makeUpstream({ maxClipSeconds: null });
    const result = await generate();

    expect(calls).toBe(0);
    expect(result.ok ? null : result.error.message).toContain("maxClipSeconds");
  });

  it("should write the shot list beside the screenplay, with no track level", async () => {
    await makeUpstream();
    const result = await generate();

    expect(result.ok ? result.data.verdict?.shots.length : null).toBe(4);
    expect(await readFile(join(episodeDir(), "shot-list.md"), "utf8")).toContain("### U01");
  });

  it("should record the run, the prompt version and a pending review", async () => {
    await makeUpstream();
    await generate();
    const stage = await readStage();

    expect(stage.stage).toBe("shot-list");
    expect(stage.artifacts["shot-list"].status).toBe("completed");
    expect(stage.artifacts["shot-list"].review.status).toBe("pending");
    expect(stage.artifacts["shot-list"].producer.promptVersion).toBe(1);
  });

  it("should reference the screenplay by path and digest without copying it", async () => {
    await makeUpstream();
    await generate();
    const stage = await readStage();
    const paths = stage.artifacts["shot-list"].inputs.map((entry) => entry.path);
    const [runId = ""] = await runDirs();

    expect(paths).toContain(`projects/${PROJECT}/episodes/${EPISODE}/screenplay.md`);
    expect(paths).not.toContain(`projects/${PROJECT}/episodes/${EPISODE}/source.md`);
    expect(await readdir(join(episodeDir(), "runs", runId))).not.toContain("screenplay.md");
  });

  it("should call the API exactly once", async () => {
    await makeUpstream();
    await generate();

    expect(calls).toBe(1);
  });

  it("should refuse a second paid attempt without --regenerate", async () => {
    await makeUpstream();
    await generate();
    calls = 0;
    const again = await generate();

    expect(calls).toBe(0);
    expect(again.ok ? null : again.error.message).toContain("--regenerate");
  });

  it("should keep the previous plan when --regenerate replaces it", async () => {
    await makeUpstream();
    await generate();
    await generate({ regenerate: true });
    const runs = await runDirs();
    const previous = await Promise.all(
      runs.map((runId) => readdir(join(episodeDir(), "runs", runId)))
    );

    expect(previous.flat()).toContain("previous-shot-list.md");
  });

  it("should not publish a plan that fails validation", async () => {
    await makeUpstream();
    const broken = plan().replace("### U04 | S03 | C02 | 20-30s", "### U04 | S03 | C02 | 20-28s");
    const result = await generate({ fetch: respondWith(completion(broken)) });

    expect(result.ok ? null : result.error.message).toContain("28");
    await expect(readFile(join(episodeDir(), "shot-list.md"), "utf8")).rejects.toThrow();
  });

  it("should finish a submitted attempt from its archived answer without paying again", async () => {
    await makeUpstream();
    const broken = plan().replace("- Cast: ewa", "- Cast: nikt");
    await generate({ fetch: respondWith(completion(broken)) });
    calls = 0;

    // The same broken answer is re-judged from disk: a validator bug must not
    // be billable.
    const again = await generate();

    expect(calls).toBe(0);
    expect(again.ok ? null : again.error.message).toContain("nikt");
  });

  it("should let a 4xx refusal be retried by an ordinary run", async () => {
    await makeUpstream();
    await generate({ fetch: respondWith('{"error":{"message":"no access"}}', 403) });
    calls = 0;
    const again = await generate();

    expect(calls).toBe(1);
    expect(again.ok).toBe(true);
  });
});

describe("checkShotList and approveShotList", () => {
  it("should report a plan that validates but nobody has accepted", async () => {
    await makeUpstream();
    await generate();
    const status = await checkShotList({
      episodeId: EPISODE,
      projectId: PROJECT,
      workspace,
    });

    expect(status.ok ? status.data.status : null).toBe("completed");
    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(status.ok ? status.data.problems : null).toEqual([]);
  });

  it("should record an approval bound to the current bytes", async () => {
    await makeUpstream();
    await generate();
    const approved = await approveShotList({
      episodeId: EPISODE,
      mode: "apply",
      note: "dobre tempo",
      projectId: PROJECT,
      reviewer: "tester",
      workspace,
    });

    expect(approved.ok ? approved.data.approved : null).toBe(true);
    expect((await readStage()).artifacts["shot-list"].review.status).toBe("approved");
  });

  it("should revoke an approval when the plan is edited outside the tool", async () => {
    await makeUpstream();
    await generate();
    await approveShotList({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "tester",
      workspace,
    });
    await writeFile(
      join(episodeDir(), "shot-list.md"),
      plan().replace("Dwa klipy", "Trzy"),
      "utf8"
    );
    const status = await checkShotList({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(status.ok ? status.data.problems.join("\n") : "").toContain("zmieniony poza narzędziem");
  });

  it("should refuse to approve what does not validate", async () => {
    await makeUpstream();
    await generate();
    await writeFile(join(episodeDir(), "shot-list.md"), "## Plan\n\nnic\n", "utf8");
    const approved = await approveShotList({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "tester",
      workspace,
    });

    expect(approved.ok ? null : approved.error.message).toContain("nie akceptuje się");
  });

  it("should report drift when the screenplay changes after the plan was made", async () => {
    await makeUpstream();
    await generate();
    await writeFile(
      join(episodeDir(), "screenplay.md"),
      screenplay().replace("Treść sekcji Logline.", "Inna treść."),
      "utf8"
    );
    const status = await checkShotList({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(status.ok ? status.data.inputsChanged.join("\n") : "").toContain("screenplay.md");
  });

  // A lapsed consent, not a broken plan: the shot list still covers every scene
  // of the screenplay as it now stands, so the person who reads both decides.
  it("should let a human re-approve over a changed input, re-recording it", async () => {
    await makeUpstream();
    await generate();
    const accept = (): ReturnType<typeof approveShotList> =>
      approveShotList({
        episodeId: EPISODE,
        mode: "apply",
        note: null,
        projectId: PROJECT,
        reviewer: "tester",
        workspace,
      });
    await accept();
    // `project.md`, not `screenplay.md`: editing the screenplay would also
    // break stage 1's own output digest, which is a different failure and
    // would blur what this test is about.
    await writeFile(join(root, "projects", PROJECT, "project.md"), "# Ewa\n\nInne.\n", "utf8");

    const again = await accept();

    expect(again.ok ? again.data.approved : again.error.message).toBe(true);

    const after = await checkShotList({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(after.ok ? after.data.inputsChanged : null).toEqual([]);
    expect(after.ok ? after.data.approved : null).toBe(true);
  });

  // A screenplay that really changed shape fails the structural check first,
  // because the plan is re-validated against the screenplay as it now stands.
  it("should still refuse when the changed screenplay no longer fits the plan", async () => {
    await makeUpstream();
    await generate();
    await writeFile(
      join(episodeDir(), "screenplay.md"),
      screenplay().replace("### S03 | 10s | salon, wieczór", "### S03 | 8s | salon, wieczór"),
      "utf8"
    );

    const again = await approveShotList({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "tester",
      workspace,
    });

    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.error.message).toContain("nie przechodzi walidacji");
  });
});
