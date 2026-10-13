import {
  applyWrites,
  type Correction,
  nowIso,
  type RecordedFile,
  readDigest,
  serialize,
  sha256Of,
  toWorkspacePath,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type Publication,
  type Published,
  type Replaced,
  runTextStage,
  type TextStage,
  textPrompt,
} from "../text-model/index.js";
import type { Workspace } from "../workspace.js";
import {
  readStage11Inputs,
  SCRIPT,
  STAGE,
  Stage11BlockedError,
  type Stage11Inputs,
} from "./plan.js";
import { PROMPT_VERSION } from "./prompt.js";
import { type DialogueScript, validateDialogue } from "./validate.js";

/**
 * Internal to the dialogue module: the one command that spends money.
 *
 * Today it buys one thing, the script, in one paid text call. The order of
 * operations is `lib/text-model`'s; what stays here is the gate, the verdict
 * and the file this stage publishes.
 */

export interface DialogueReport {
  /** The note this attempt corrects by, and where it came from; `null` for none. */
  readonly correction: Correction | null;
  readonly created: readonly string[];
  readonly nextStep: string;
  /** What the published script says without refusing: a voice from off screen. */
  readonly notices: readonly string[];
  /** The bill, in text calls: one, or zero when something blocks it. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  readonly verdict: DialogueScript | null;
}

interface GenerateInput {
  readonly apiKey: string | null;
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  /** A note correcting the published version; only with `regenerate`. */
  readonly instruction?: string | null;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly workspace: Workspace;
}

/**
 * Why a paid call may not happen. Empty means it may. A dry run never reads
 * the key, so it never claims one is missing.
 */
function blockers(input: GenerateInput, stage11: Stage11Inputs): readonly string[] {
  const problems = [...stage11.gate];

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_DIALOGUE_MODEL"
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

export async function generateDialogue(input: GenerateInput): Promise<Result<DialogueReport>> {
  const stage11 = await readStage11Inputs(input);

  if (!stage11.ok) {
    return stage11;
  }

  const problems = blockers(input, stage11.data);
  const { prompt } = stage11.data;

  if (input.mode === "dry-run") {
    const sent =
      prompt === null
        ? { correction: null, problems: [], prompt: null }
        : await textPrompt(textStage(input, stage11.data, prompt), {
            instruction: input.instruction ?? null,
            regenerate: input.regenerate,
          });
    const blocked = [...problems, ...sent.problems];

    return ok({
      correction: sent.correction,
      created: [],
      nextStep:
        blocked.length === 0
          ? `aimator dialogue generate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      notices: [],
      paidCalls: blocked.length === 0 ? 1 : 0,
      problems: blocked,
      prompt: sent.prompt,
      ready: blocked.length === 0,
      runId: null,
      verdict: null,
    });
  }

  if (problems.length > 0 || prompt === null) {
    return err(new Stage11BlockedError(problems));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: stage11.data.episode,
      fetch: input.fetch,
      format: null,
      instruction: input.instruction ?? null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      // Published exactly as the model returned it, so nothing to repair.
      republish: false,
      workspace: input.workspace,
    },
    textStage(input, stage11.data, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    correction: attempt.data.correction,
    created: attempt.data.created,
    nextStep: `przeczytaj skrypt i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`,
    notices: attempt.data.value.notices,
    // One, including a resumed attempt: its answer was already paid for.
    paidCalls: 1,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    verdict: attempt.data.value,
  });
}

/** The half of the text attempt that is about a script rather than about paying. */
function textStage(
  input: GenerateInput,
  stage11: Stage11Inputs,
  prompt: string
): TextStage<DialogueScript> {
  const { episode } = stage11;

  return {
    artifact: STAGE,
    blocked: (problems) => new Stage11BlockedError(problems),
    inputs: stage11.inputs,
    // The file will hold the bought lines beside the script, as stage 9's does.
    key: SCRIPT,
    lock: episode.dialogueLock,
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, stage11, publication),
    replaced: () => replaced(episode.dialogueScript),
    result: episode.dialogueScript,
    stagePath: episode.dialogueStage,
    what: "skrypt dialogu",
  };
}

async function replaced(from: string): Promise<readonly Replaced[]> {
  const previous = await readDigest(from);

  return previous.ok ? [{ name: "dialogue.md", text: previous.data.bytes.toString("utf8") }] : [];
}

async function publish(
  input: GenerateInput,
  stage11: Stage11Inputs,
  publication: Publication
): Promise<Result<Published<DialogueScript>>> {
  const { archive, text } = publication;
  const { episode, plan } = stage11;

  if (plan === null) {
    return err(new Stage11BlockedError(["lista ujęć nie przechodzi walidacji"]));
  }

  const verdict = validateDialogue({
    cast: stage11.cast.map((member) => member.id),
    shotList: plan,
    text,
  });

  if (!verdict.ok) {
    await writeNew(
      archive.validation,
      serialize({
        checkedAt: nowIso(),
        promptVersion: PROMPT_VERSION,
        reason: verdict.error.message,
        structuralValidation: "failed",
      })
    );

    return err(
      new Error(
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(input.workspace.root, archive.response)}, to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  await writeNew(
    archive.validation,
    serialize({
      checkedAt: nowIso(),
      lines: verdict.data.lines.length,
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, episode.dialogueScript),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];
  const written = await applyWrites([{ kind: "text", text, to: episode.dialogueScript }], "apply");

  return written.ok
    ? ok({
        created: [toWorkspacePath(input.workspace.root, episode.dialogueScript)],
        outputs,
        value: verdict.data,
      })
    : written;
}
