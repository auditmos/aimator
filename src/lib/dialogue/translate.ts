import {
  AnswerFormatError,
  applyWrites,
  nowIso,
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
import { dialogueTranslation, type Workspace } from "../workspace.js";
import type { DialogueReport } from "./generate.js";
import {
  readStage11Inputs,
  readTranslationTarget,
  SCRIPT,
  STAGE,
  Stage11BlockedError,
  type Stage11Inputs,
  type TranslationTarget,
  translationKey,
} from "./plan.js";
import { buildTranslationPrompt, TRANSLATION_PROMPT_VERSION } from "./prompt.js";
import { checkDialogue, type DialogueStatus } from "./review.js";
import { type DialogueLine, type DialogueScript, validateTranslation } from "./validate.js";

/**
 * Internal to the dialogue module: the script in a second language.
 *
 * The one deliberate translation of material in this pipeline. Rule 9 forbids
 * translating what a model works from, because a translation is a second
 * version of the same truth; here a second version is exactly what is wanted,
 * so it is bought as a **new artifact with its own yes**, `dialogue.<lang>.md`
 * beside the script it came from, never as a re-encoding of that script.
 *
 * One paid text call, in `lib/text-model`'s order of operations, and only once
 * the script in the film's language is accepted and the episode has said which
 * language the mouths move in. Each line goes out with its window, because a
 * line that cannot be said inside it cannot be lip-synced.
 */

interface TranslateInput {
  /** The text model's key. A dry run never reads it. */
  readonly apiKey: string | null;
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  /** A note correcting the published translation; only with `regenerate`. */
  readonly instruction?: string | null;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  /** The text model that translates. */
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly workspace: Workspace;
}

/** Everything one translation reads, once there is a language to translate into. */
interface Translation {
  readonly key: string;
  readonly language: string;
  readonly path: string;
  readonly prompt: string;
  /** The accepted script as data: what every translated block must match. */
  readonly source: readonly DialogueLine[];
  readonly stage11: Stage11Inputs;
  readonly target: TranslationTarget;
}

/** Why the script in the film's language does not yet open its translation. */
function sourceProblems(input: TranslateInput, status: DialogueStatus): readonly string[] {
  if (status.script.approved) {
    return [];
  }

  return status.script.state === "completed"
    ? [
        `skrypt dialogu w języku filmu nie ma ważnej zgody, a przekład tłumaczy właśnie jego: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`,
      ]
    : [
        `nie ma jeszcze skryptu dialogu w języku filmu, przekład nie ma czego tłumaczyć: aimator dialogue generate ${input.projectId} ${input.episodeId}`,
      ];
}

/** Why the paid call may not happen. A dry run never reads the key. */
function blockers(input: TranslateInput, found: Translation | null): readonly string[] {
  const problems: string[] = [];
  const record = found === null ? undefined : found.stage11.stage.artifacts[found.key];

  if (record?.status === "completed" && !input.regenerate) {
    problems.push(
      `przekład (${found?.language}) już istnieje; zachowano go, nowy kupuje wyłącznie: aimator dialogue translate ${input.projectId} ${input.episodeId} --regenerate`
    );
  }

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_TRANSLATION_MODEL"
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

/**
 * What the translation reads, or the reasons it cannot be read yet. The source
 * script is taken through `checkDialogue`, so it opens a translation exactly
 * when the check prints it as accepted.
 */
async function readTranslation(
  input: TranslateInput
): Promise<Result<{ readonly found: Translation | null; readonly gate: readonly string[] }>> {
  const stage11 = await readStage11Inputs(input);

  if (!stage11.ok) {
    return stage11;
  }

  const status = await checkDialogue(input);
  const target = await readTranslationTarget(input, stage11.data);

  if (!status.ok) {
    return status;
  }
  if (!target.ok) {
    return target;
  }

  const gate = [...target.data.problems, ...sourceProblems(input, status.data)];
  const { language } = target.data;
  const { plan } = stage11.data;
  const script = await readDigest(stage11.data.episode.dialogueScript);

  if (language === null || plan === null || !script.ok || status.data.lines.length === 0) {
    return ok({ found: null, gate });
  }

  const path = dialogueTranslation(stage11.data.episode, language);

  if (!path.ok) {
    return path;
  }

  return ok({
    found: {
      key: translationKey(language),
      language,
      path: path.data,
      prompt: buildTranslationPrompt({
        cast: stage11.data.cast,
        lines: status.data.lines,
        rules: stage11.data.rules,
        script: script.data.bytes.toString("utf8"),
        shots: plan.shots,
        source: stage11.data.language,
        target: language,
      }),
      source: status.data.lines,
      stage11: stage11.data,
      target: target.data,
    },
    gate,
  });
}

function report(
  fields: Partial<DialogueReport> & Pick<DialogueReport, "nextStep">
): DialogueReport {
  return {
    characters: 0,
    correction: null,
    created: [],
    lines: [],
    notices: [],
    paidCalls: 0,
    problems: [],
    prompt: null,
    ready: false,
    runId: null,
    verdict: null,
    ...fields,
  };
}

export async function translateDialogue(input: TranslateInput): Promise<Result<DialogueReport>> {
  const read = await readTranslation(input);

  if (!read.ok) {
    return read;
  }

  const { found, gate } = read.data;
  const problems = [...gate, ...blockers(input, found)];

  if (input.mode === "dry-run") {
    return await preview(input, found, problems);
  }

  if (problems.length > 0 || found === null) {
    return err(new Stage11BlockedError(problems));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: found.stage11.episode,
      fetch: input.fetch,
      format: null,
      instruction: input.instruction ?? null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      republish: false,
      workspace: input.workspace,
    },
    textStage(input, found)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok(
    report({
      correction: attempt.data.correction,
      created: attempt.data.created,
      nextStep: `przeczytaj przekład i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${found.key}`,
      // One, including a resumed attempt: its answer was already paid for.
      paidCalls: 1,
      ready: true,
      runId: attempt.data.runId,
      verdict: attempt.data.value,
    })
  );
}

/** The bill and the exact prompt, with nothing sent and nothing written. */
async function preview(
  input: TranslateInput,
  found: Translation | null,
  problems: readonly string[]
): Promise<Result<DialogueReport>> {
  const sent =
    found === null
      ? { correction: null, problems: [], prompt: null }
      : await textPrompt(textStage(input, found), {
          instruction: input.instruction ?? null,
          regenerate: input.regenerate,
        });
  const blocked = [...problems, ...sent.problems];

  return ok(
    report({
      correction: sent.correction,
      nextStep:
        blocked.length === 0
          ? `aimator dialogue translate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      paidCalls: blocked.length === 0 ? 1 : 0,
      problems: blocked,
      prompt: sent.prompt,
      ready: blocked.length === 0,
    })
  );
}

/** The half of the text attempt that is about this translation rather than about paying. */
function textStage(input: TranslateInput, found: Translation): TextStage<DialogueScript> {
  const { episode } = found.stage11;
  const name = `dialogue.${found.language}.md`;

  return {
    artifact: STAGE,
    blocked: (problems) => new Stage11BlockedError(problems),
    inputs: found.target.inputs,
    key: found.key,
    // The lock of the whole stage file: the script, its lines and this record
    // all live in one `dialogue.stage.json`.
    lock: episode.dialogueLock,
    prompt: found.prompt,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    publish: (publication) => publish(input, found, publication),
    replaced: async (): Promise<readonly Replaced[]> => {
      const previous = await readDigest(found.path);

      return previous.ok ? [{ name, text: previous.data.bytes.toString("utf8") }] : [];
    },
    result: found.path,
    stagePath: episode.dialogueStage,
    what: `przekład skryptu dialogu (${found.language})`,
  };
}

async function publish(
  input: TranslateInput,
  found: Translation,
  publication: Publication
): Promise<Result<Published<DialogueScript>>> {
  const { archive, text } = publication;
  const verdict = validateTranslation({ source: found.source, text });

  await writeNew(
    archive.validation,
    serialize({
      checkedAt: nowIso(),
      promptVersion: TRANSLATION_PROMPT_VERSION,
      ...(verdict.ok
        ? { lines: verdict.data.lines.length, structuralValidation: "passed" }
        : { reason: verdict.error.message, structuralValidation: "failed" }),
    })
  );

  if (!verdict.ok) {
    return err(
      new AnswerFormatError(
        verdict.error.message,
        toWorkspacePath(input.workspace.root, archive.response)
      )
    );
  }

  const written = await applyWrites([{ kind: "text", text, to: found.path }], "apply");
  const path = toWorkspacePath(input.workspace.root, found.path);

  return written.ok
    ? ok({
        created: [path],
        outputs: [{ path, sha256: sha256Of(Buffer.from(text)) }],
        value: verdict.data,
      })
    : written;
}
