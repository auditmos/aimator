import {
  approveOpeningFrame,
  checkOpeningFrame,
  generateOpeningFrame,
  type OpeningFrameReport,
  type OpeningFrameStatus,
} from "../../lib/opening-frame/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Approval,
  imageModelOf,
  keyFor,
  modeOf,
  type Parsed,
  parse,
  referenceIdsOf,
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 6: the first frame of the film, one artifact per track. */
export const USAGE = `Etap 6. Klatka otwarcia (płatny; per tor, dokładnie jedno wywołanie):
  opening-frame generate <id> <episode-id> --track <gpt-image|seedream>
                         [--model <id>] [--dry-run] [--regenerate]
    Czeka na referencje, które pakiet wpisał w opening.referenceIds, i na hero
    każdej postaci w kadrze, zatwierdzone NA TYM TORZE. Jeden artefakt, więc
    --artifact niczego nie zawęża i nie jest wymagane nawet przy --regenerate.`;

/**
 * Stage 6 prints one artifact instead of a set, and still prints the count.
 *
 * It is always zero or one, which is exactly why it is worth printing: the
 * person running `--dry-run` is asking whether this command is about to buy an
 * image or tell them it cannot.
 */
function renderOpeningFrame(
  report: OpeningFrameReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Klatka otwarcia ${projectId}/${episodeId}, tor ${report.track}, kadr ${report.size}`;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
    mode === "dry-run"
      ? `  płatnych wywołań do wykonania: ${report.paidCalls}`
      : `  płatnych wywołań wykonanych: ${report.paidCalls}`,
    `  ${report.artifact.id}: ${report.artifact.state}, ${report.artifact.note}`,
  ];

  for (const attachment of report.artifact.attachments) {
    lines.push(`      ← ${attachment.path}  ${attachment.sha256.slice(0, 12)}`);
  }

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (report.created.length > 0) {
    lines.push("  ! klatka przeszła walidację; to nie to samo co przyjęcie jej przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  if (report.artifact.prompt !== null) {
    lines.push("", "--- prompt klatki otwarcia (dokładnie ten tekst) ---", report.artifact.prompt);
  }

  return lines.join("\n");
}

function renderOpeningFrameStatus(headline: string, status: OpeningFrameStatus): string {
  const lines = [
    headline,
    `  ${status.artifact.id}: ${status.artifact.approved ? "zatwierdzona" : status.artifact.state}, ${status.artifact.note}`,
  ];

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

export async function runOpeningFrame(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: opening-frame ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    artifact: { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    track: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);
  const track = trackOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!track.ok) {
    return track;
  }

  const model = imageModelOf(parsed.data, track.data);

  if (!model.ok) {
    return model;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateOpeningFrame({
    apiKey: mode === "dry-run" ? null : (keyFor(track.data) ?? null),
    artifacts: referenceIdsOf(parsed.data),
    episodeId: episodeId.data,
    fetch,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    track: track.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(renderOpeningFrame(result.data, projectId.data, episodeId.data, mode))
    : result;
}

/**
 * `check --stage opening-frame` reports one episode on one track, and writes
 * nothing. Stage 6 has one artifact, so there is no `--artifact` to narrow it.
 */
export async function checkOpeningFrameStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");
  const track = trackOf(parsed);

  if (!episodeId.ok) {
    return episodeId;
  }
  if (!track.ok) {
    return track;
  }

  const result = await checkOpeningFrame({
    episodeId: episodeId.data,
    projectId,
    track: track.data,
    workspace,
  });

  return result.ok
    ? ok(
        renderOpeningFrameStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 6${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data
        )
      )
    : result;
}

/**
 * Stage 6 accepts its one frame, bound to its bytes.
 *
 * No `--artifact` is required, and that is not a relaxation of the rule stage 5
 * follows. Stage 5 demands the flag because it has six candidates and accepting
 * the wrong one buys an image; here the command already says which stage and
 * which track, and there is nothing else it could mean.
 */
export async function approveOpeningFrameStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");
  const track = trackOf(parsed);

  if (!episodeId.ok) {
    return episodeId;
  }
  if (!track.ok) {
    return track;
  }

  const result = await approveOpeningFrame({
    ...approval,
    artifacts: referenceIdsOf(parsed),
    episodeId: episodeId.data,
    track: track.data,
  });

  return result.ok
    ? ok(
        renderOpeningFrameStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, zatwierdzono klatkę otwarcia`,
          result.data
        )
      )
    : result;
}
