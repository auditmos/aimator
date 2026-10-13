import { err, ok, type Result } from "../../lib/result.js";
import {
  approveStyle,
  checkStyle,
  generateStyle,
  type StyleReport,
  type StyleStatus,
} from "../../lib/style/index.js";
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
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/**
 * Generated style frames: the paid command, per track, at the project level.
 *
 * Not a numbered stage, so its block in the usage text says where it sits
 * rather than opening with `Etap N.`: beside stage 2, for a project whose
 * style decision is `generated`, and consumed by every frame from stage 5 on.
 */
export const USAGE = `Obrazy stylu (płatne; per tor, przy podstawie generated; obok etapu 2):
  style generate <id> --track <gpt-image|seedream> [--artifact S01,...] [--model <id>]
                 [--dry-run] [--json] [--regenerate]
    Rysuje z bloku Style Bible każdy brakujący obraz stylu Snn tego toru, jedno
    płatne wywołanie na obraz, i podaje ich liczbę przed wysyłką. Czeka na
    zatwierdzony etap 0 i Style Bible bez TODO(etap-0). Każdy obraz przyjmuje się
    osobno; etapy 5, 6 i 7 dołączają wyłącznie przyjęte obrazy swojego toru.`;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "style";

/** `--artifact` as a list of ids; the module says whether each is one it draws. */
function artifactsOf(parsed: Parsed): readonly string[] {
  const flag = parsed.values.artifact;

  return typeof flag === "string" ? flag.split(",").map((id) => id.trim()) : [];
}

export async function runStyle(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: style ${argv[0] ?? ""}`.trim()));
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
  const workspace = workspaceOf(parsed.data);
  const track = trackOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
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
  const result = await generateStyle({
    apiKey: mode === "dry-run" ? null : (keyFor(track.data) ?? null),
    artifacts: artifactsOf(parsed.data),
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
      : renderStyle(result.data, projectId.data, mode)
  );
}

/**
 * `--dry-run` prints every prompt in full and the number of paid calls first:
 * on a command that buys several images, that number is what a person reads to
 * decide whether to run it at all.
 */
function renderStyle(report: StyleReport, projectId: string, mode: "apply" | "dry-run"): string {
  const headline = `Obrazy stylu projektu "${projectId}", tor ${report.track}, kadr ${report.size}`;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
    mode === "dry-run"
      ? `  płatnych wywołań do wykonania: ${report.paidCalls}`
      : `  płatnych wywołań wykonanych: ${report.paidCalls}`,
    ...report.artifacts.map((one) => `  ${one.id}: ${one.state}, ${one.note}`),
    ...report.created.map((path) => `  + ${path}`),
    ...report.problems.map((problem) => `  ! ${problem}`),
  ];

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

function renderStatus(headline: string, status: StyleStatus): string {
  return [
    headline,
    ...status.artifacts.map(
      (one) => `  ${one.id}: ${one.approved ? "zatwierdzony" : one.state}, ${one.note}`
    ),
    ...status.problems.map((problem) => `  ! ${problem}`),
    `Dalej: ${status.nextStep}`,
  ].join("\n");
}

/** `check --stage style`: one track's style frames. Writes nothing. */
export async function checkStyleStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const track = trackOf(parsed);

  if (!track.ok) {
    return track;
  }

  const result = await checkStyle({ projectId, track: track.data, workspace });

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderStatus(
          `Obrazy stylu projektu "${projectId}", tor ${track.data}${result.data.approved ? ", zatwierdzone w całości" : ""}`,
          result.data
        )
  );
}

/** `approve --stage style`: the named frames, bound to their bytes. */
export async function approveStyleStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const track = trackOf(parsed);

  if (!track.ok) {
    return track;
  }

  const artifacts = artifactsOf(parsed);
  const result = await approveStyle({ ...approval, artifacts, track: track.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderStatus(
          `Obrazy stylu projektu "${approval.projectId}" na torze ${track.data}, zatwierdzono: ${artifacts.join(", ")}`,
          result.data
        )
  );
}
