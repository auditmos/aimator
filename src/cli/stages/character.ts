import type { ParseArgsConfig } from "node:util";
import {
  approveCharacter,
  CHARACTER_ARTIFACTS,
  type CharacterArtifact,
  type CharacterReport,
  type CharacterStatus,
  checkCharacter,
  generateCharacter,
  isCharacterArtifact,
} from "../../lib/character/index.js";
import {
  approveVoice,
  checkVoice,
  generateSample,
  type SampleReport,
  setVoice,
  type VoiceDecision,
  type VoiceStatus,
} from "../../lib/character-voice/index.js";
import { env } from "../../lib/env.js";
import { addCharacter, addCharacterSources, setCharacterBasis } from "../../lib/project/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  answerFlag,
  answerStage0,
  asJson,
  correctionLines,
  imageModelOf,
  keyFor,
  modeOf,
  type Parsed,
  parse,
  requireFlag,
  requirePositional,
  singleInstructionOf,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/**
 * The cast, declared one entry at a time, which is a stage-0 decision.
 *
 * It sits in this file rather than beside the project's own commands because
 * the `character` command is one grammar with four subcommands, and splitting
 * it by stage would put its dispatch across a module boundary. The usage text
 * is what knows about stages, so the fragment goes to stage 0's block and the
 * one below to stage 2's.
 */
export const CAST_USAGE = `  character new <id> <character-id> --name <nazwa> [--json]
  character add <id> <character-id> --source <plik> [--source <plik>...] [--json]
  character describe <id> <character-id> [--json]
  character voice <id> <character-id> --language <kod> --voice-id <id głosu> [--json]
    Obsadza głos postaci w jednym języku: id głosu dostawcy, dosłownie, w
    characters/<postać>/voices/<język>/voice.json. Darmowe. Głos nie mieszka w
    project.json, więc jego zmiana cofa wyłącznie zgodę na próbkę tego języka;
    obrazy, klipy, inne języki i inne postacie zostają nietknięte.
  character sample <id> <character-id> --language <kod> --text <zdanie>
                   [--model <id>] [--dry-run] [--json] [--regenerate]
    Kupuje próbkę głosu: jedno płatne wywołanie czytające podane zdanie, które
    nie ma wartości domyślnej. ElevenLabs rozlicza znaki, więc podgląd podaje
    wywołania i znaki osobno. Model: --model albo AIMATOR_DIALOGUE_VOICE_MODEL.
    Nie czeka na zgodę na etap 0: próbka służy do wybrania głosu. Przyjmuje ją
    approve --stage voice --language <kod>.`;

/** Stage 2: the card, the eight views and the hero, per track. */
export const USAGE = `Etap 2. Postać (płatny; niezależny od etapu 1, może biec równolegle):
  character generate <id> <character-id> --track <gpt-image|seedream>
                     [--artifact card|hero|<widok>,...] [--model <id>]
                     [--dry-run] [--json] [--regenerate [--instruction <uwaga>]]`;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "character";

/** The voices this file also answers for: casting, beside stage 0. */
const VOICE_STAGE = "voice";

/** Project id, character id and the workspace, what every cast command needs. */
function castScope(
  parsed: Parsed
): Result<{ characterId: string; projectId: string; workspace: Workspace }> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const characterId = requirePositional(parsed, 1, "character-id");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!characterId.ok) {
    return characterId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  return ok({
    characterId: characterId.data,
    projectId: projectId.data,
    workspace: workspace.data,
  });
}

async function runCharacterNew(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const name = requireFlag(parsed, "name");

  if (!scope.ok) {
    return scope;
  }
  if (!name.ok) {
    return name;
  }

  const mode = modeOf(parsed);
  const result = await addCharacter({ ...scope.data, mode, name: name.data });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed),
          "character new",
          `Postać "${name.data}" dopisana do obsady`,
          result.data,
          mode
        )
      )
    : result;
}

async function runCharacterAdd(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const sources = parsed.values.source;

  if (!scope.ok) {
    return scope;
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return err(new UsageError("brakuje wymaganej flagi --source"));
  }

  const mode = modeOf(parsed);
  const result = await addCharacterSources({ ...scope.data, mode, sourcePaths: sources });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed),
          "character add",
          `Materiały postaci "${scope.data.characterId}"`,
          result.data,
          mode
        )
      )
    : result;
}

async function runCharacterDescribe(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);

  if (!scope.ok) {
    return scope;
  }

  const mode = modeOf(parsed);
  const result = await setCharacterBasis({ ...scope.data, basis: "description", mode });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed),
          "character describe",
          `Postać "${scope.data.characterId}" powstaje z opisu w project.md, bez zdjęć`,
          result.data,
          mode
        )
      )
    : result;
}

/**
 * Casts a character's voice in one language. Free: it writes `voice.json` and
 * nothing else, so a person can change their mind before buying a sample.
 */
async function runCharacterVoice(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const language = requireFlag(parsed, "language");
  const voiceId = requireFlag(parsed, "voice-id");

  if (!scope.ok) {
    return scope;
  }
  if (!language.ok) {
    return language;
  }
  if (!voiceId.ok) {
    return voiceId;
  }

  const mode = modeOf(parsed);
  const result = await setVoice({
    ...scope.data,
    language: language.data,
    mode,
    voiceId: voiceId.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed) === "json"
      ? asJson("voice", VOICE_STAGE, result.data)
      : renderVoiceDecision(result.data, mode)
  );
}

/**
 * Buys one sample of a cast voice. `--text` is required: a sentence nobody
 * chose would be the tool deciding what a character says.
 */
async function runCharacterSample(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const language = requireFlag(parsed, "language");
  const text = requireFlag(parsed, "text");

  if (!scope.ok) {
    return scope;
  }
  if (!language.ok) {
    return language;
  }
  if (!text.ok) {
    return text;
  }

  const { model } = parsed.values;
  const mode = modeOf(parsed);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateSample({
    ...scope.data,
    apiKey: mode === "dry-run" ? null : (env.ELEVENLABS_API_KEY ?? null),
    fetch,
    language: language.data,
    mode,
    model: typeof model === "string" ? model : (env.AIMATOR_DIALOGUE_VOICE_MODEL ?? null),
    regenerate: parsed.values.regenerate === true,
    text: text.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed) === "json"
      ? asJson("sample", VOICE_STAGE, result.data)
      : renderSample(result.data, mode)
  );
}

/**
 * Calls and characters on one line, before the outcome: the provider bills
 * the sentence, so the count of calls alone would understate what is spent.
 */
function renderSample(report: SampleReport, mode: "apply" | "dry-run"): string {
  const headline = `Próbka głosu postaci "${report.characterId}" (${report.language}): ${report.voiceId ?? "głos nieobsadzony"}`;

  return [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
    `  ${mode === "dry-run" ? "do kupienia" : "kupiono"}: ${report.paidCalls} wywołań, ${report.characters} znaków`,
    `  sample: ${report.state}, ${report.note}`,
    ...report.created.map((path) => `  + ${path}`),
    ...report.problems.map((problem) => `  ! ${problem}`),
    ...(report.created.length > 0
      ? ["  ! nagranie przeszło walidację; to nie to samo co przyjęcie go przez człowieka"]
      : []),
    `Dalej: ${report.nextStep}`,
  ].join("\n");
}

/** The language a voice question is about, required: there is no default one. */
function voiceScopeOf(
  parsed: Parsed
): Result<{ readonly characterId: string; readonly language: string }> {
  const characterId = requirePositional(parsed, 1, "character-id");
  const language = requireFlag(parsed, "language");

  if (!characterId.ok) {
    return characterId;
  }

  return language.ok ? ok({ characterId: characterId.data, language: language.data }) : language;
}

function renderVoiceStatus(headline: string, status: VoiceStatus): string {
  const { sample } = status;
  const state = sample.approved ? "zatwierdzona" : sample.state;

  return [
    headline,
    `  głos: ${status.voiceId ?? "nieobsadzony"}`,
    `  sample: ${state}, ${sample.note}`,
    ...status.problems.map((problem) => `  ! ${problem}`),
    `Dalej: ${status.nextStep}`,
  ].join("\n");
}

/** `check --stage voice`: one character's voice in one language. Writes nothing. */
export async function checkVoiceStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const scope = voiceScopeOf(parsed);

  if (!scope.ok) {
    return scope;
  }

  const result = await checkVoice({ ...scope.data, projectId, workspace });

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", VOICE_STAGE, result.data)
      : renderVoiceStatus(
          `Głos postaci "${scope.data.characterId}" (${scope.data.language})${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data
        )
  );
}

/** `approve --stage voice`: the sample heard and the voice accepted, bound to its bytes. */
export async function approveVoiceStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const scope = voiceScopeOf(parsed);

  if (!scope.ok) {
    return scope;
  }

  const result = await approveVoice({ ...approval, ...scope.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", VOICE_STAGE, result.data)
      : renderVoiceStatus(
          `Głos postaci "${scope.data.characterId}" (${scope.data.language}), zatwierdzono próbkę`,
          result.data
        )
  );
}

function renderVoiceDecision(decision: VoiceDecision, mode: "apply" | "dry-run"): string {
  const headline = `Głos postaci "${decision.characterId}" (${decision.language}): ${decision.voiceId}`;

  return [
    mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
    ...decision.written.map((path) => `  + ${path}`),
    ...decision.problems.map((problem) => `  ! ${problem}`),
    `Dalej: ${decision.nextStep}`,
  ].join("\n");
}

const CHARACTER_OPTIONS = {
  add: { json: { type: "boolean" }, source: { multiple: true, type: "string" } },
  describe: { json: { type: "boolean" } },
  generate: {
    artifact: { type: "string" },
    instruction: { type: "string" },
    json: { type: "boolean" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    track: { type: "string" },
  },
  new: { json: { type: "boolean" }, name: { type: "string" } },
  sample: {
    json: { type: "boolean" },
    language: { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    text: { type: "string" },
  },
  voice: {
    json: { type: "boolean" },
    language: { type: "string" },
    "voice-id": { type: "string" },
  },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

function isAction(action: string | undefined): action is keyof typeof CHARACTER_OPTIONS {
  return action !== undefined && Object.hasOwn(CHARACTER_OPTIONS, action);
}

export async function runCharacter(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (!isAction(action)) {
    return err(new UsageError(`nieznane polecenie: character ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), CHARACTER_OPTIONS[action]);

  if (!parsed.ok) {
    return parsed;
  }

  if (action === "new") {
    return await runCharacterNew(parsed.data);
  }

  if (action === "voice") {
    return await runCharacterVoice(parsed.data);
  }

  if (action === "sample") {
    return await runCharacterSample(parsed.data);
  }

  if (action === "generate") {
    return await runCharacterGenerate(parsed.data);
  }

  return action === "add"
    ? await runCharacterAdd(parsed.data)
    : await runCharacterDescribe(parsed.data);
}

/** `--artifact` accepts the same words the stage file uses as keys. */
function artifactsOf(parsed: Parsed): Result<readonly CharacterArtifact[]> {
  const flag = parsed.values.artifact;

  if (typeof flag !== "string") {
    return ok([]);
  }

  const names = flag.split(",").map((name) => name.trim());
  const known = names.filter((name) => isCharacterArtifact(name));
  const unknown = names.filter((name) => !isCharacterArtifact(name));

  return unknown.length === 0
    ? ok(known)
    : err(
        new UsageError(
          `--artifact "${unknown.join(", ")}", dozwolone: ${CHARACTER_ARTIFACTS.join(", ")}`
        )
      );
}

async function runCharacterGenerate(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const track = trackOf(parsed);
  const artifacts = artifactsOf(parsed);

  if (!scope.ok) {
    return scope;
  }
  if (!track.ok) {
    return track;
  }
  if (!artifacts.ok) {
    return artifacts;
  }

  const instruction = singleInstructionOf(parsed, artifacts.data);

  if (!instruction.ok) {
    return instruction;
  }

  const model = imageModelOf(parsed, track.data);

  if (!model.ok) {
    return model;
  }

  const mode = modeOf(parsed);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateCharacter({
    apiKey: mode === "dry-run" ? null : (keyFor(track.data) ?? null),
    artifacts: artifacts.data,
    characterId: scope.data.characterId,
    fetch,
    instruction: instruction.data,
    mode,
    model: model.data,
    projectId: scope.data.projectId,
    regenerate: parsed.values.regenerate === true,
    track: track.data,
    workspace: scope.data.workspace,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderCharacter(result.data, scope.data, mode)
  );
}

/**
 * `--dry-run` prints every prompt in full, not a byte count. On a stage that
 * spends money ten times over, the point of a preview is to let a person read
 * what would be sent.
 */
function renderCharacter(
  report: CharacterReport,
  scope: { characterId: string; projectId: string },
  mode: "apply" | "dry-run"
): string {
  const headline = `Postać "${report.name}" (${scope.characterId}), tor ${report.track}`;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
    // One call is one image here, so this is the count of pictures too, and
    // it stands before the outcomes rather than after them: it is the number
    // somebody reads to decide whether to run the command at all.
    mode === "dry-run"
      ? `  płatnych wywołań do wykonania: ${report.paidCalls}`
      : `  płatnych wywołań wykonanych: ${report.paidCalls}`,
    ...correctionLines(report.correction),
  ];

  for (const outcome of report.artifacts) {
    lines.push(`  ${outcome.artifact}: ${outcome.state}, ${outcome.note}`);

    for (const reference of outcome.references) {
      lines.push(`      ← ${reference.path}  ${reference.sha256.slice(0, 12)}`);
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

  for (const outcome of report.artifacts) {
    if (outcome.prompt !== null) {
      lines.push(
        "",
        `--- prompt dla ${outcome.artifact} (dokładnie ten tekst) ---`,
        outcome.prompt
      );
    }
  }

  return lines.join("\n");
}

function renderCharacterStatus(headline: string, status: CharacterStatus): string {
  const lines = [headline];

  for (const entry of status.artifacts) {
    const mark = entry.approved ? "zatwierdzony" : entry.state;
    lines.push(`  ${entry.artifact}: ${mark}, ${entry.note}`);
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

/**
 * `check --stage character` reports one character on one track. It writes
 * nothing, like every other check: drift is reported, never recorded.
 */
export async function checkCharacterStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const characterId = requirePositional(parsed, 1, "character-id");
  const track = trackOf(parsed);

  if (!characterId.ok) {
    return characterId;
  }
  if (!track.ok) {
    return track;
  }

  const result = await checkCharacter({
    characterId: characterId.data,
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
      : renderCharacterStatus(
          `Postać "${result.data.name}" (${characterId.data}), tor ${track.data}, etap 2${result.data.approved ? ", zatwierdzony w całości" : ""}`,
          result.data
        )
  );
}

export async function approveCharacterStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const characterId = requirePositional(parsed, 1, "character-id");
  const track = trackOf(parsed);
  const artifacts = artifactsOf(parsed);

  if (!characterId.ok) {
    return characterId;
  }
  if (!track.ok) {
    return track;
  }
  if (!artifacts.ok) {
    return artifacts;
  }

  const result = await approveCharacter({
    ...approval,
    artifacts: artifacts.data,
    characterId: characterId.data,
    track: track.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderCharacterStatus(
          `Postać "${characterId.data}" na torze ${track.data}, zatwierdzono: ${artifacts.data.join(", ")}`,
          result.data
        )
  );
}
