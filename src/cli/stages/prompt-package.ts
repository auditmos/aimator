import { env } from "../../lib/env.js";
import { type Attachment, readSendPlan, type SendPlan } from "../../lib/media-prompt/index.js";
import {
  approvePromptPackage,
  checkPromptPackage,
  generatePromptPackage,
  type PromptPackageReport,
  type PromptPackageStatus,
} from "../../lib/prompt-package/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  type Answer,
  type Approval,
  asJson,
  type EpisodeScope,
  MODEL_ID,
  maxOutputTokensOf,
  modeOf,
  type Parsed,
  parse,
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 4: the package both tracks read, and the free preview of a send. */
export const USAGE = `Etap 4. Pakiet promptów (płatny; wspólny dla obu torów, ale czeka na oba):
  prompt-package generate <id> <episode-id> [--model <id>]
                          [--max-output-tokens <n>] [--dry-run] [--json]
                          [--regenerate]
                          [--republish]   ← publikuje zapisaną odpowiedź, nic nie wysyła
  prompt-package show <id> <episode-id> --track <tor> [--json]
                      [--artifact R02|opening-frame|C03|entry:C03,...]
    Darmowe. Drukuje dokładnie to, co poleci do modelu obrazu albo wideo:
    numerowany blok załączników w kolejności bajtów, treść pliku z prompts/,
    blok o medium, kadr, dosłowne ujęcia z listy i project.md. Bez --artifact
    wypisuje sam plan: co pakiet planuje, ile referencji i czy są zatwierdzone.`;

/**
 * The package is one direction per reference, per clip and per entry frame, so
 * it is the longest answer any text stage asks for. A ceiling, not a creative
 * decision, which is why it has a default where the model does not.
 */
const DEFAULT_PROMPT_PACKAGE_MAX_OUTPUT_TOKENS = 32_000;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "prompt-package";

/**
 * `--dry-run` prints the prompt itself, not a byte count, the same promise
 * stages 1 and 3 make. It also names the gate stage 4 alone has: the canonical
 * images, which are checked on both tracks and never sent.
 */
function renderPackageGenerate(
  report: PromptPackageReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. Pakiet promptów ${projectId}/${episodeId}`,
          `  płatnych wywołań do wykonania: ${report.paidCalls}`,
          "  OPENAI_API_KEY nie był czytany, bo próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
          "  obrazy postaci nie są wysyłane: pakiet jest wspólny dla obu torów, więc niesie same identyfikatory hero:<id>",
        ]
      : [
          `Pakiet promptów ${projectId}/${episodeId}, próba ${report.runId ?? ""}`,
          `  płatnych wywołań wykonanych: ${report.paidCalls}`,
        ];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    lines.push(...describePackage(report.verdict));
    lines.push("  ! graf i przypisania się zgadzają; kierunek wymaga oceny człowieka");
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${report.nextStep}`);

  if (report.prompt !== null) {
    lines.push("", "--- prompt wysłany do modelu (dokładnie ten tekst) ---", report.prompt);
  }

  return lines.join("\n");
}

/** The package as a person reads it: what exists, and what depends on what. */
function describePackage(verdict: PromptPackageStatus["verdict"]): readonly string[] {
  if (verdict === null) {
    return [];
  }

  const lines = [
    `  referencje: ${verdict.references.length}, klipy: ${verdict.clips.length}, obrazy postaci: ${verdict.heroes.join(", ") || "brak"}`,
  ];

  for (const reference of verdict.references) {
    lines.push(
      `    ${reference.id} (${reference.kind}) ${reference.subject} ← ${reference.dependsOn.join(", ")}`
    );
  }

  return lines;
}

function renderPackageStatus(
  headline: string,
  status: PromptPackageStatus,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines = [mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline];

  lines.push(...describePackage(status.verdict));

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (status.status === "completed" && !status.approved && status.problems.length === 0) {
    lines.push(
      `  ! pliki przeszły walidację; to nie to samo co przyjęcie ich przez człowieka: aimator approve ${projectId} ${episodeId} --stage prompt-package`
    );
  }

  return lines.join("\n");
}

/** `--model` wins over the environment; neither has a default. */
function promptsModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_PROMPTS_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

/**
 * `prompt-package show`: exactly what a later stage would send, for free.
 *
 * Stage 4 publishes half a prompt, the direction for one frame, so a person
 * approving the package is approving something they cannot see in the shape it
 * will be sent in. This closes that gap, and it is the same composer stages 5
 * to 7 send with: one implementation, two readers.
 */
async function runPromptPackageShow(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const episodeId = requirePositional(parsed, 1, "episode-id");
  const workspace = workspaceOf(parsed);
  const track = trackOf(parsed);

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

  const flag = parsed.values.artifact;
  const result = await readSendPlan({
    episodeId: episodeId.data,
    projectId: projectId.data,
    targets: typeof flag === "string" ? flag.split(",").map((name) => name.trim()) : [],
    track: track.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.values.json === true
      ? asJson("show", STAGE, printable(result.data))
      : renderSendPlan(result.data, projectId.data, episodeId.data)
  );
}

/**
 * The send plan as a document, which is the plan without the files in it.
 *
 * `bytes` exists so the stage that pays can POST the attachment, and a JSON
 * document has no bytes: serialising a Buffer would put a megabyte of decimal
 * numbers into a plan somebody asked to read. Dropping it is the only field
 * this command decides anything about, and the file is not lost by it, the
 * digest identifies it exactly as it does everywhere else here.
 */
function printable(plan: SendPlan): object {
  return {
    ...plan,
    artifacts: plan.artifacts.map((one) => ({
      ...one,
      attachments: one.attachments.map(({ bytes: _bytes, ...rest }) => rest),
    })),
  };
}

/** The state of one attachment, in the word a person reads. */
const ATTACHMENT_STATE: Record<Attachment["state"], string> = {
  absent: "jeszcze nie istnieje",
  approved: "zatwierdzony",
  changed: "zmieniony poza narzędziem",
  pending: "czeka na ocenę",
};

function renderSendPlan(plan: SendPlan, projectId: string, episodeId: string): string {
  const lines = [
    `Pakiet promptów ${projectId}/${episodeId}, tor ${plan.track}, nic nie wysłano, nic nie zapisano`,
    `  kadr ${plan.size} (${plan.aspectRatio}); tor przyjmuje najwyżej ${plan.limit} referencji; składacz w wersji ${plan.promptVersion}`,
  ];
  // Naming an artifact narrows the summary to it: somebody who asked to read
  // one prompt did not ask for the state of the other twenty.
  const composed = plan.artifacts.filter((one) => one.text !== null);
  const listed = composed.length > 0 ? composed : plan.artifacts;

  for (const one of listed) {
    const ready = one.blockers.length === 0 ? "gotowy" : "zablokowany";
    lines.push(`  ${one.name} (${one.kind}): ${ready}, ${one.attachments.length} referencji`);

    for (const [index, attachment] of one.attachments.entries()) {
      lines.push(
        `      Image ${index + 1} = ${attachment.id} → ${attachment.path}, ${ATTACHMENT_STATE[attachment.state]}`
      );
    }

    for (const blocker of one.blockers) {
      lines.push(`    ! ${blocker}`);
    }
  }

  for (const problem of plan.problems) {
    lines.push(`  ! ${problem}`);
  }

  for (const one of composed) {
    lines.push("", `--- prompt dla ${one.name} (dokładnie ten tekst) ---`, one.text ?? "");
  }

  return lines.join("\n");
}

export async function runPromptPackage(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "show") {
    const parsed = parse(argv.slice(1), {
      artifact: { type: "string" },
      json: { type: "boolean" },
      track: { type: "string" },
    });

    return parsed.ok ? await runPromptPackageShow(parsed.data) : parsed;
  }

  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: prompt-package ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    json: { type: "boolean" },
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    republish: { type: "boolean" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  if (parsed.data.values.regenerate === true && parsed.data.values.republish === true) {
    return err(
      new UsageError(
        "--regenerate i --republish wykluczają się: pierwsze płaci za nową odpowiedź, drugie publikuje zapisaną"
      )
    );
  }

  const model = promptsModelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data, DEFAULT_PROMPT_PACKAGE_MAX_OUTPUT_TOKENS);

  if (!model.ok) {
    return model;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generatePromptPackage({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    episodeId: episodeId.data,
    fetch,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    republish: parsed.data.values.republish === true,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderPackageGenerate(result.data, projectId.data, episodeId.data, mode)
  );
}

/** The stage-4 half of `check <id> <episode-id>`, in prose or as the object. */
export async function checkPromptPackageStage(
  scope: EpisodeScope,
  answer: Answer
): Promise<Result<string>> {
  const result = await checkPromptPackage(scope);

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderPackageStatus(
          `Odcinek "${scope.episodeId}", etap 4: ${result.data.status}${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data,
          scope.projectId,
          scope.episodeId,
          "apply"
        )
  );
}

/** `approve --stage prompt-package`: the manifest and every prompt file. */
export async function approvePromptPackageStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const result = await approvePromptPackage({ ...approval, episodeId: episodeId.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderPackageStatus(
          `Pakiet promptów odcinka "${episodeId.data}" zatwierdzony`,
          result.data,
          approval.projectId,
          episodeId.data,
          approval.mode
        )
  );
}
