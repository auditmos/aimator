import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY, png, recorder } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import {
  addCharacter,
  approveStage0,
  initProject,
  setCharacterBasis,
  setStyle,
} from "../project/index.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveStyle, checkStyle, generateStyle } from "./index.js";

/**
 * Style frames generated per track from the project's Style Bible.
 *
 * Assumptions this file encodes, stated before the first test:
 *
 * - **It reads stage 0 alone**, like stage 2: a project with no episode is a
 *   project whose style frames can be drawn, so nothing here builds one.
 * - **One call, one image**, and the bill is said before it is paid: a run
 *   buys every missing `Snn` of the decided count and nothing else.
 * - **A track is a directory level**: what seedream drew is not gpt-image's.
 * - **The gate is stage 0 accepted and a Style Bible with no TODO left**; a
 *   dry run reports both and still shows the prompt.
 */

const PROJECT = "seria";

/** The rules with every marker answered, the Style Bible included. */
const RULES = `# Seria, zasady wspólne

## Bohaterowie i wygląd

- Główny bohater: Ewa, sześć lat.

## Style Bible

- Style line: flat 2D cutout, thick ink outline, gouache fill, soft grain, warm dusk light.
- Palette: #1B2A41, #F2C14E, #F78154, #4D9078, #FDF6EC.
- Linework rule: 4 px outer line, 2 px inner, no taper, #1B2A41.
- Always / never: always flat fills; never gradients.

## Obraz i ciągłość

- Powracająca sceneria: salon z niską kanapą.
`;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

async function makeProject(
  options: { approve?: boolean; count?: number; rules?: string } = {}
): Promise<void> {
  const { approve = true, count = 2, rules = RULES } = options;

  await initProject({
    aspectRatio: "16:9",
    mode: "apply",
    projectId: PROJECT,
    title: "Seria",
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
  await writeFile(join(root, "projects", PROJECT, "project.md"), rules, "utf8");
  await setStyle({
    decision: { basis: "generated", count },
    mode: "apply",
    projectId: PROJECT,
    workspace,
  });

  if (approve) {
    await approveStage0({
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "t",
      workspace,
    });
  }
}

function generate(overrides: Partial<Parameters<typeof generateStyle>[0]> = {}) {
  return generateStyle({
    apiKey: API_KEY,
    artifacts: [],
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function accept(artifacts: readonly string[], track: ImageTrack = "gpt-image") {
  return approveStyle({
    artifacts,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "t",
    track,
    workspace,
  });
}

async function stageFile(track: ImageTrack = "gpt-image"): Promise<{
  artifacts: Record<string, { outputs: { path: string; sha256: string }[] } | undefined>;
}> {
  return JSON.parse(
    await readFile(join(root, "projects", PROJECT, "style", track, "style.stage.json"), "utf8")
  );
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-style-stage-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateStyle --dry-run", () => {
  it("should name stage 0 as the obstacle, spend nothing and still show the prompt", async () => {
    await makeProject({ approve: false });
    const call = recorder();
    const result = await generate({ fetch: call.fetch, mode: "dry-run" });
    const report = result.ok ? result.data : null;

    expect(call.calls).toHaveLength(0);
    expect(report?.paidCalls).toBe(0);
    expect(report?.problems.join("\n")).toContain(`aimator approve ${PROJECT}`);
    expect(report?.artifacts.map((one) => one.id)).toEqual(["S01", "S02"]);
    expect(report?.artifacts[0]?.prompt).toContain("style frame 1 of 2");
    expect(report?.artifacts[0]?.prompt?.endsWith(RULES)).toBe(true);
  });

  it("should name a Style Bible still marked TODO as the obstacle", async () => {
    await makeProject({
      approve: false,
      rules: RULES.replace("- Palette: #1B2A41", "- Palette: TODO(etap-0) #1B2A41"),
    });
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.paidCalls : null).toBe(0);
    expect(result.ok ? result.data.problems.join("\n") : "").toContain("Style Bible");
    expect(result.ok ? result.data.artifacts[1]?.prompt : null).toContain("style frame 2 of 2");
  });

  it("should state the bill before paying it, one call per missing image", async () => {
    await makeProject();
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.paidCalls : null).toBe(2);
  });

  /** The style is the series' look, never its cast. */
  it("should ask for the world of the series with nobody from the cast in it", async () => {
    await makeProject();
    const result = await generate({ mode: "dry-run" });
    const prompt = result.ok ? (result.data.artifacts[0]?.prompt ?? "") : "";

    expect(prompt).toContain("No character from the cast appears in it");
    expect(prompt).toContain("Ewa");
    expect(prompt).toContain("2816x1584 pixels, the 16:9 film frame");
  });
});

describe("generateStyle", () => {
  it("should buy exactly the missing images, each with a record on that track", async () => {
    await makeProject();
    const first = recorder();
    const second = recorder();

    await generate({ artifacts: ["S01"], fetch: first.fetch });
    const rest = await generate({ fetch: second.fetch });
    const records = (await stageFile()).artifacts;

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(rest.ok ? rest.data.paidCalls : null).toBe(1);
    expect(Object.keys(records)).toEqual(["S01", "S02"]);
    expect(records.S02?.outputs[0]?.path).toBe(`projects/${PROJECT}/style/gpt-image/S02.png`);
    await expect(stageFile("seedream")).rejects.toThrow();
  });

  it("should refuse to pay before stage 0 is accepted", async () => {
    await makeProject({ approve: false });
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain(`aimator approve ${PROJECT}`);
  });

  it("should refuse a project whose style frames are not generated", async () => {
    await makeProject();
    await setStyle({ decision: { basis: "none" }, mode: "apply", projectId: PROJECT, workspace });
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? null : result.error.message).toContain("--generated");
  });

  it("should require a named target for a new charge", async () => {
    await makeProject();
    const result = await generate({ regenerate: true });

    expect(result.ok ? null : result.error.message).toContain("--artifact");
  });
});

describe("approveStyle", () => {
  it("should refuse without --artifact, because each image is its own judgement", async () => {
    await makeProject();
    await generate();
    const result = await accept([]);

    expect(result.ok ? null : result.error.message).toContain("--artifact");
  });

  it("should bind the approval to the bytes it was given", async () => {
    await makeProject();
    await generate();
    await accept(["S01"]);

    const approved = await checkStyle({ projectId: PROJECT, track: "gpt-image", workspace });
    const path = join(root, "projects", PROJECT, "style", "gpt-image", "S01.png");
    const recorded = (await stageFile()).artifacts.S01?.outputs[0]?.sha256;

    expect(recorded).toBe(sha256Of(await readFile(path)));
    expect(approved.ok && approved.data.artifacts.map((one) => one.approved)).toEqual([
      true,
      false,
    ]);

    await writeFile(path, png(2816, 1584, 7));
    const tampered = await checkStyle({ projectId: PROJECT, track: "gpt-image", workspace });

    expect(tampered.ok && tampered.data.artifacts[0]?.approved).toBe(false);
    expect(tampered.ok && tampered.data.problems.join("\n")).toContain("zmieniony poza narzędziem");
  });
});
