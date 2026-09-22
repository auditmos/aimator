import {
  approveReferences,
  checkReferences,
  generateReferences,
  type ReferencesReport,
  type ReferencesStatus,
} from "../../lib/references/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  asJson,
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

/** Stage 5: the reference images, per track, several to a command. */
export const USAGE = `Etap 5. Obrazy referencyjne (płatny; per tor, kilka obrazów na polecenie):
  reference generate <id> <episode-id> --track <gpt-image|seedream>
                     [--artifact R01,R02] [--model <id>] [--dry-run] [--json]
                     [--regenerate]
    Bez --artifact rysuje wszystkie referencje, których zależności są już
    zatwierdzone NA TYM TORZE, i mówi, ile płatnych wywołań wykona.`;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "references";

/**
 * `--dry-run` prints every prompt in full and the number of paid calls.
 *
 * Stage 5 is the first where one command can buy several images, so the count
 * is printed before anything is sent rather than discovered from an invoice.
 */
function renderReferences(
  report: ReferencesReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Obrazy referencyjne ${projectId}/${episodeId}, tor ${report.track}, kadr ${report.size}`;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
    mode === "dry-run"
      ? `  płatnych wywołań do wykonania: ${report.paidCalls}`
      : `  płatnych wywołań wykonanych: ${report.paidCalls}`,
  ];

  for (const one of report.artifacts) {
    lines.push(`  ${one.id}: ${one.state}, ${one.note}`);

    for (const attachment of one.attachments) {
      lines.push(`      ← ${attachment.path}  ${attachment.sha256.slice(0, 12)}`);
    }
  }

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (report.created.length > 0) {
    lines.push("  ! obrazy przeszły walidację; to nie to samo co przyjęcie ich przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  for (const one of report.artifacts) {
    if (one.prompt !== null) {
      lines.push("", `--- prompt dla ${one.id} (dokładnie ten tekst) ---`, one.prompt);
    }
  }

  return lines.join("\n");
}

function renderReferencesStatus(headline: string, status: ReferencesStatus): string {
  const lines = [headline];

  for (const one of status.artifacts) {
    lines.push(`  ${one.id}: ${one.approved ? "zatwierdzona" : one.state}, ${one.note}`);
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

export async function runReference(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: reference ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    artifact: { type: "string" },
    json: { type: "boolean" },
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
  const result = await generateReferences({
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

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderReferences(result.data, projectId.data, episodeId.data, mode)
  );
}

/**
 * `check --stage references` reports one episode on one track. It writes
 * nothing, like every other check: drift is reported, never recorded.
 */
export async function checkReferencesStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");
  const track = trackOf(parsed);

  if (!episodeId.ok) {
    return episodeId;
  }
  if (!track.ok) {
    return track;
  }

  const result = await checkReferences({
    episodeId: episodeId.data,
    projectId,
    track: track.data,
    workspace,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderReferencesStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 5${result.data.approved ? ", zatwierdzony w całości" : ""}`,
          result.data
        )
  );
}

/**
 * Stage 5 accepts one reference at a time, bound to its bytes.
 *
 * There is no "approve everything" here, for the reason stage 2 gives about the
 * card: accepting R03 is what lets R04 be bought, so it has to be a thing
 * somebody typed rather than a side effect of accepting something else.
 */
export async function approveReferencesStage(
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

  const artifacts = referenceIdsOf(parsed);
  const result = await approveReferences({
    ...approval,
    artifacts,
    episodeId: episodeId.data,
    track: track.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderReferencesStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, zatwierdzono: ${artifacts.join(", ")}`,
          result.data
        )
  );
}
