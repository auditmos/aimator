import {
  approveStage0,
  checkStage0,
  initProject,
  setNarratorVoice,
} from "../../lib/project/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  answerFlag,
  answerStage0,
  modeOf,
  parse,
  requireFlag,
  requirePositional,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 0's project half: the rules a series shares, and who narrates it. */
export const USAGE = `  project init <id> --title <tytuł> [--aspect-ratio <w:h>] [--json]
  project voice <id> --voice-id <id głosu> [--json]
    Obsadza narratora serii. Głos jest obsadą, nie konfiguracją: powraca między
    odcinkami, więc mieszka w project.json obok postaci, a nie w zmiennej, która
    dałaby drugiemu odcinkowi innego lektora bez śladu na dysku. Bramkuje sam
    etap 9, film bez narracji nigdy nie musi tej decyzji podejmować.`;

/**
 * Casts the narrator. A stage-0 command because a voice recurs between episodes
 * exactly as a character does, which is the one criterion that decides whether
 * a decision belongs to the project rather than to an episode or a shell.
 */
async function runProjectVoice(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" }, "voice-id": { type: "string" } });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const voiceId = requireFlag(parsed.data, "voice-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!voiceId.ok) {
    return voiceId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed.data);
  const result = await setNarratorVoice({
    mode,
    projectId: projectId.data,
    voiceId: voiceId.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed.data),
          "project voice",
          `Narratorem projektu "${projectId.data}" jest głos ${voiceId.data}`,
          result.data,
          mode
        )
      )
    : result;
}

export async function runProject(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "voice") {
    return runProjectVoice(argv.slice(1));
  }

  if (argv[0] !== "init") {
    return err(new UsageError(`nieznane polecenie: project ${argv[0] ?? ""}`.trim()));
  }

  // No `--character` here on purpose: the cast is declared by `character new`,
  // one entry at a time. A flag accepted and discarded would let somebody
  // believe they had named a character when nothing was written.
  const parsed = parse(argv.slice(1), {
    "aspect-ratio": { type: "string" },
    json: { type: "boolean" },
    title: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const title = requireFlag(parsed.data, "title");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!title.ok) {
    return title;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const ratio = parsed.data.values["aspect-ratio"];
  const mode = modeOf(parsed.data);
  const result = await initProject({
    aspectRatio: typeof ratio === "string" ? ratio : null,
    mode,
    projectId: projectId.data,
    title: title.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed.data),
          "project init",
          `Utworzono projekt "${projectId.data}"`,
          result.data,
          mode
        )
      )
    : result;
}

/**
 * `check` with no `--stage`, and `--stage prepare`: whether stage 0 is ready,
 * and whether it is accepted.
 *
 * What to print travels in rather than being defaulted, for the reason stage 1
 * gives: both callers are in `check.ts`, the wide question renders prose and
 * the narrow one renders whichever the flag asked for, and a default would
 * decide for the next caller silently.
 */
export async function checkPrepareStage(
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const result = await checkStage0({ projectId, workspace });

  return result.ok
    ? ok(
        answerStage0(answer, "check", `Projekt "${projectId}", etap 0 gotowy`, result.data, "apply")
      )
    : result;
}

/** `approve` with no `--stage`, and `--stage prepare`: the default acceptance. */
export async function approvePrepareStage(approval: Approval): Promise<Result<string>> {
  const result = await approveStage0(approval);

  return result.ok
    ? ok(
        answerStage0(
          approval.answer,
          "approve",
          `Etap 0 projektu "${approval.projectId}" zatwierdzony`,
          result.data,
          approval.mode
        )
      )
    : result;
}
