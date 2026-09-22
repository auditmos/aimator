import {
  type AssemblyReport,
  type AssemblyStatus,
  approveAssembly,
  checkAssembly,
  generateAssembly,
} from "../../lib/assembly/index.js";
import { env } from "../../lib/env.js";
import { ffmpeg } from "../../lib/muxer.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  answerFlag,
  asJson,
  modeOf,
  type Parsed,
  parse,
  referenceIdsOf,
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 8: the cut, bought from nobody and rendered by a local engine. */
export const USAGE = `Etap 8. Montaż (darmowy; per tor, jeden artefakt):
  assembly generate <id> <episode-id> --track <gpt-image|seedream>
                    [--dry-run] [--json] [--regenerate]
    Skleja zatwierdzone klipy w <tor>/episode.mp4 bez przekodowania, w
    kolejności z zatwierdzonej listy ujęć, planu montażowego nie ma jako pliku,
    bo lista ujęć już go niesie. Nic nie kupuje i nie potrzebuje modelu ani
    klucza; potrzebuje ffmpeg (PATH albo AIMATOR_FFMPEG), a gdy go nie ma,
    odmawia zamiast przekodowywać. Klipy nie wracają co do sekundy, więc skleja
    to, co wróciło, i melduje różnicę wobec planu, nigdy nie przycina.
    Jeden artefakt na tor, więc --artifact niczego nie zawęża i nie jest
    wymagane; --regenerate jest, bo gotowy montaż nosi zgodę człowieka.
    episode.mp4 jest NIEMY: ścieżka dźwiękowa musi powstać wobec sklejonego
    filmu, a nie wobec planu, więc należy do etapu poniżej montażu.
    --json wypisuje raport etapu: plan cięcia wyprowadzony z listy ujęć, klip
    po klipie, sumy planu i klipów oraz silnik. Rachunku w nim nie ma i nie
    będzie, bo ten etap niczego nie kupuje.`;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "assembly";

/**
 * Stage 8 reports no bill and one arithmetic instead: what the approved plan
 * asked for, what the clips actually run, and the difference between them. That
 * difference is the number a person is being asked to accept, because nothing
 * here trims a frame to make it go away.
 */
function renderAssembly(
  report: AssemblyReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Montaż ${projectId}/${episodeId}, tor ${report.track}`;
  const lines = [
    mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
    `  silnik: ${report.engine ?? "nieustalony"}`,
    `  plan ${report.plannedSeconds}s, klipy ${report.actualSeconds}s`,
    `  ${report.artifact.id}: ${report.artifact.state}, ${report.artifact.note}`,
  ];

  for (const clip of report.cut) {
    lines.push(`      ${clip.id}: plan ${clip.plannedSeconds}s, wynik ${clip.seconds ?? "?"}s`);
  }

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  for (const notice of report.notices) {
    lines.push(`  · ${notice}`);
  }

  if (report.artifact.state === "published") {
    lines.push("  ! odcinek przeszedł walidację; to nie to samo co obejrzenie go przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

function renderAssemblyStatus(headline: string, status: AssemblyStatus): string {
  const lines = [
    headline,
    `  ${status.artifact.id}: ${status.artifact.approved ? "zatwierdzony" : status.artifact.state}, ${status.artifact.note}`,
  ];

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  for (const notice of status.notices) {
    lines.push(`  · ${notice}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

/**
 * Stage 8, the only generate command with no model flag and no key.
 *
 * It buys nothing, so there is nothing to choose a model for; what it needs is
 * a program on this machine, which `AIMATOR_FFMPEG` points at when it is not
 * simply `ffmpeg` on PATH. `--artifact` narrows nothing either, because the
 * stage makes one file per track, but a wrong value is still refused rather
 * than ignored.
 */
export async function runAssembly(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: assembly ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    artifact: { type: "string" },
    json: { type: "boolean" },
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

  const mode = modeOf(parsed.data);
  const result = await generateAssembly({
    artifacts: referenceIdsOf(parsed.data),
    episodeId: episodeId.data,
    mode,
    mux: ffmpeg(env.AIMATOR_FFMPEG ?? "ffmpeg"),
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    track: track.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? asJson("generate", STAGE, result.data)
      : renderAssembly(result.data, projectId.data, episodeId.data, mode)
  );
}

/** `check --stage assembly` reports one episode's cut, per track. */
export async function checkAssemblyStage(
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

  const result = await checkAssembly({
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
      : renderAssemblyStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 8${result.data.approved ? ", przyjęty w całości" : ""}`,
          result.data
        )
  );
}

/**
 * Stage 8's approval, and the only one with no `--artifact` to demand.
 *
 * A flag is required upstream for two reasons: several candidates exist, so a
 * bare command is ambiguous, and accepting one of them opens a gate that spends
 * money. Neither holds at the last row, one artifact per track, and nothing
 * below it to buy. Written anyway; it is still checked.
 */
export async function approveAssemblyStage(
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

  const result = await approveAssembly({
    ...approval,
    artifacts: referenceIdsOf(parsed),
    episodeId: episodeId.data,
    track: track.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderAssemblyStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, całość przyjęta`,
          result.data
        )
  );
}
