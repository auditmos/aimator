import { userInfo } from "node:os";
import { type ParseArgsConfig, parseArgs } from "node:util";
import {
  approveCharacter,
  CHARACTER_ARTIFACTS,
  type CharacterArtifact,
  type CharacterReport,
  type CharacterStatus,
  checkCharacter,
  generateCharacter,
  isCharacterArtifact,
} from "./lib/character/index.js";
import { env } from "./lib/env.js";
import {
  addCharacter,
  addCharacterSources,
  addEpisode,
  approveStage0,
  checkStage0,
  initProject,
  type Stage0Report,
  setCharacterBasis,
  setEpisodeSettings,
} from "./lib/project/index.js";
import {
  approvePromptPackage,
  checkPromptPackage,
  generatePromptPackage,
  type PromptPackageReport,
  type PromptPackageStatus,
} from "./lib/prompt-package/index.js";
import { err, ok, type Result } from "./lib/result.js";
import {
  approveScreenplay,
  checkScreenplay,
  generateScreenplay,
  type ScreenplayReport,
  type ScreenplayStatus,
} from "./lib/screenplay/index.js";
import {
  approveShotList,
  checkShotList,
  generateShotList,
  type ShotListReport,
  type ShotListStatus,
} from "./lib/shot-list/index.js";
import { type ImageTrack, imageTracks, resolveWorkspace, type Workspace } from "./lib/workspace.js";

const USAGE = `Usage: aimator <command>

Etap 0 — przygotowanie projektu i odcinka:
  project init <id> --title <tytuł> [--aspect-ratio <w:h>]
  character new <id> <character-id> --name <nazwa>
  character add <id> <character-id> --source <plik> [--source <plik>...]
  character describe <id> <character-id>
  episode add <id> --source <NN-tytul.md> [--duration <s>] [--audio <tryb>]
                   [--language <kod>] [--subtitles <kod|none>] [--nature <rodzaj>]
                   [--max-clip <s>]
  episode set <id> <episode-id> [te same flagi decyzji]

Etap 1 — scenariusz (płatny):
  screenplay generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                                        [--dry-run] [--regenerate]

Etap 2 — postać (płatny; niezależny od etapu 1, może biec równolegle):
  character generate <id> <character-id> --track <gpt-image|seedream>
                     [--artifact card|hero|<widok>,...] [--model <id>]
                     [--dry-run] [--regenerate]

Etap 3 — lista ujęć (płatny; wspólna dla obu torów, bez poziomu katalogu na tor):
  shot-list generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                                       [--dry-run] [--regenerate]

Etap 4 — pakiet promptów (płatny; wspólny dla obu torów, ale czeka na oba):
  prompt-package generate <id> <episode-id> [--model <id>]
                          [--max-output-tokens <n>] [--dry-run] [--regenerate]
                          [--republish]   ← publikuje zapisaną odpowiedź, nic nie wysyła

Wspólne:
  check <id> [<episode-id>]
  check <id> <character-id> --stage character --track <tor>
  approve <id> [<episode-id>] [--stage prepare|screenplay|shot-list|prompt-package]
               [--note <uzasadnienie>] [--reviewer <kto>]
  approve <id> <character-id> --stage character --track <tor>
               --artifact <klucz>[,<klucz>...]

  --audio      music-and-effects | dialogue | narration | dialogue-and-narration
  --nature     law-or-idea | synopsis | screenplay
  --max-clip   najdłuższy planowany klip w sekundach (1–60); decyzja odcinka bez
               wartości domyślnej, wymagana dopiero przez etap 3
  --stage      zakres akceptacji; domyślnie prepare (etap 0)
  --track      tor modelu obrazowego; bez wartości domyślnej, bo każdy kosztuje osobno
  --artifact   card, hero albo nazwa widoku: front, slight-left, slight-right,
               three-quarter-left, three-quarter-right, profile-left,
               profile-right, rear

Obsada jest jawną decyzją: wymień każdą powracającą postać przez "character new".
Postać widziana raz to referencja etapu 5, nie postać. Każda ma własną podstawę —
zdjęcia ("character add") albo opis w project.md ("character describe").

Globalne:
  --workspace <ścieżka>  katalog artefaktów (domyślnie AIMATOR_WORKSPACE)
  --dry-run              pokaż, co powstanie, nie zapisuj niczego
  --help                 ten komunikat

Etapy 1 i 2 odmawiają płatnego wywołania, dopóki etap 0 nie ma review.status =
"approved". W etapie 2 osiem widoków czeka na zatwierdzoną kartę, a hero na
zatwierdzone widoki. Etap 3 czeka na zatwierdzony scenariusz i nie zależy od
etapu 2. Etap 4 czeka na zatwierdzoną listę ujęć i na zatwierdzony hero.png
każdej postaci, którą lista ujęć stawia w kadrze — na obu torach naraz, bo
pakiet jest jeden dla obu. Nic nie ponawia się samo; nową płatną próbę zaczyna
wyłącznie --regenerate, zachowując poprzedni wynik.`;

const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
/**
 * The shot list is two to three times the length of the screenplay it plans:
 * every scene becomes several shots and every shot carries ten fields. A cap is
 * a ceiling rather than a creative decision, so unlike the model it has one.
 */
const DEFAULT_SHOT_LIST_MAX_OUTPUT_TOKENS = 24_000;
/**
 * The package is one direction per reference, per clip and per entry frame, so
 * it is the longest answer any text stage asks for. A ceiling, not a creative
 * decision, which is why it has a default where the model does not.
 */
const DEFAULT_PROMPT_PACKAGE_MAX_OUTPUT_TOKENS = 32_000;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

const SETTINGS_OPTIONS = {
  audio: { type: "string" },
  duration: { type: "string" },
  language: { type: "string" },
  "max-clip": { type: "string" },
  nature: { type: "string" },
  subtitles: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

const COMMON_OPTIONS = {
  "dry-run": { type: "boolean" },
  workspace: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface Parsed {
  readonly positionals: readonly string[];
  readonly values: Record<string, boolean | string | string[] | undefined>;
}

function parse(argv: readonly string[], options: ParseArgsConfig["options"]): Result<Parsed> {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: [...argv],
      options: { ...COMMON_OPTIONS, ...options },
      strict: true,
    });

    return ok({ positionals, values });
  } catch (cause) {
    return err(new UsageError(cause instanceof Error ? cause.message : String(cause)));
  }
}

function requireFlag(parsed: Parsed, name: string): Result<string> {
  const value = parsed.values[name];

  return typeof value === "string" && value !== ""
    ? ok(value)
    : err(new UsageError(`brakuje wymaganej flagi --${name}`));
}

function requirePositional(parsed: Parsed, index: number, label: string): Result<string> {
  const value = parsed.positionals[index];

  return value === undefined ? err(new UsageError(`brakuje argumentu <${label}>`)) : ok(value);
}

function workspaceOf(parsed: Parsed): Result<Workspace> {
  const flag = parsed.values.workspace;

  return resolveWorkspace(typeof flag === "string" ? flag : env.AIMATOR_WORKSPACE);
}

function modeOf(parsed: Parsed): "apply" | "dry-run" {
  return parsed.values["dry-run"] === true ? "dry-run" : "apply";
}

/** Who ran the command. An approval with no name attached is worth nothing. */
function reviewerOf(parsed: Parsed): string {
  const flag = parsed.values.reviewer;

  return typeof flag === "string" && flag !== "" ? flag : userInfo().username;
}

/** Only the flags the user actually passed become decisions; the rest stay undecided. */
function settingsOf(parsed: Parsed): Record<string, number | string> {
  const patch: Record<string, number | string> = {};
  const { duration } = parsed.values;
  const maxClip = parsed.values["max-clip"];
  const pairs = [
    ["audio", parsed.values.audio],
    ["language", parsed.values.language],
    ["sourceNature", parsed.values.nature],
    ["subtitles", parsed.values.subtitles],
  ] as const;

  if (typeof duration === "string") {
    patch.durationSeconds = Number(duration);
  }

  if (typeof maxClip === "string") {
    patch.maxClipSeconds = Number(maxClip);
  }

  for (const [key, value] of pairs) {
    if (typeof value === "string") {
      patch[key] = value;
    }
  }

  return patch;
}

function render(headline: string, report: Stage0Report, mode: "apply" | "dry-run"): string {
  const lines = [mode === "dry-run" ? `Próba na sucho — nic nie zapisano. ${headline}` : headline];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const path of report.reused) {
    lines.push(`  = ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (report.ready && !report.approved) {
    lines.push("  ! pliki przeszły walidację — to nie to samo co przyjęcie ich przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

/**
 * `--dry-run` prints the prompt itself, not a byte count. The whole point of
 * the preview is to let a person read what a paid call would send.
 */
function renderGenerate(
  report: ScreenplayReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho — nic nie zapisano, nic nie wysłano. Scenariusz ${projectId}/${episodeId}`,
          `  wymagane co najmniej ${report.minimumScenes} scen, każda 1–15 s, suma dokładnie równa durationSeconds`,
          "  OPENAI_API_KEY nie był czytany — próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
        ]
      : [`Scenariusz ${projectId}/${episodeId} — próba ${report.runId ?? ""}`];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    lines.push(
      `  sceny: ${report.verdict.scenes}, suma ${report.verdict.durationSeconds} s, najdłuższa ${report.verdict.longestSceneSeconds} s`
    );
    lines.push("  ! struktura i suma czasów się zgadzają — fabuła wymaga oceny człowieka");
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

function renderScreenplay(
  headline: string,
  status: ScreenplayStatus,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines = [mode === "dry-run" ? `Próba na sucho — nic nie zapisano. ${headline}` : headline];

  if (status.verdict !== null) {
    lines.push(
      `  sceny: ${status.verdict.scenes}, suma ${status.verdict.durationSeconds} s, najdłuższa ${status.verdict.longestSceneSeconds} s`
    );
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (status.status === "completed" && !status.approved && status.problems.length === 0) {
    lines.push(
      `  ! plik przeszedł walidację — to nie to samo co przyjęcie go przez człowieka: aimator approve ${projectId} ${episodeId} --stage screenplay`
    );
  }

  return lines.join("\n");
}

async function runProject(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "init") {
    return err(new UsageError(`nieznane polecenie: project ${argv[0] ?? ""}`.trim()));
  }

  // No `--character` here on purpose: the cast is declared by `character new`,
  // one entry at a time. A flag accepted and discarded would let somebody
  // believe they had named a character when nothing was written.
  const parsed = parse(argv.slice(1), {
    "aspect-ratio": { type: "string" },
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
    ? ok(render(`Utworzono projekt "${projectId.data}"`, result.data, mode))
    : result;
}

/** Project id, character id and the workspace — what every cast command needs. */
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
    ? ok(render(`Postać "${name.data}" dopisana do obsady`, result.data, mode))
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
    ? ok(render(`Materiały postaci "${scope.data.characterId}"`, result.data, mode))
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
        render(
          `Postać "${scope.data.characterId}" powstaje z opisu w project.md, bez zdjęć`,
          result.data,
          mode
        )
      )
    : result;
}

const CHARACTER_OPTIONS = {
  add: { source: { multiple: true, type: "string" } },
  describe: {},
  generate: {
    artifact: { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    track: { type: "string" },
  },
  new: { name: { type: "string" } },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

async function runCharacter(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "describe" && action !== "new" && action !== "generate") {
    return err(new UsageError(`nieznane polecenie: character ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), CHARACTER_OPTIONS[action]);

  if (!parsed.ok) {
    return parsed;
  }

  if (action === "new") {
    return await runCharacterNew(parsed.data);
  }

  if (action === "generate") {
    return await runCharacterGenerate(parsed.data);
  }

  return action === "add"
    ? await runCharacterAdd(parsed.data)
    : await runCharacterDescribe(parsed.data);
}

const TRACKS = new Set<string>(imageTracks);

/** The track is never guessed: the two cost money separately. */
function trackOf(parsed: Parsed): Result<ImageTrack> {
  const flag = parsed.values.track;

  return typeof flag === "string" && TRACKS.has(flag)
    ? ok(flag as ImageTrack)
    : err(new UsageError(`--track — dozwolone: ${imageTracks.join(", ")}`));
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
          `--artifact "${unknown.join(", ")}" — dozwolone: ${CHARACTER_ARTIFACTS.join(", ")}`
        )
      );
}

/** `--model` wins over the environment; neither has a default. */
function imageModelOf(parsed: Parsed, track: ImageTrack): Result<string | null> {
  const flag = parsed.values.model;
  const fallback =
    track === "gpt-image"
      ? (env.AIMATOR_IMAGE_MODEL_GPT_IMAGE ?? null)
      : (env.AIMATOR_IMAGE_MODEL_SEEDREAM ?? null);
  const value = typeof flag === "string" ? flag : fallback;

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
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
    mode,
    model: model.data,
    projectId: scope.data.projectId,
    regenerate: parsed.values.regenerate === true,
    track: track.data,
    workspace: scope.data.workspace,
  });

  return result.ok ? ok(renderCharacter(result.data, scope.data, mode)) : result;
}

function keyFor(track: ImageTrack): string | undefined {
  return track === "gpt-image" ? env.OPENAI_API_KEY : env.BYTEPLUS_MODELARK;
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
      ? `Próba na sucho — nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
  ];

  for (const outcome of report.artifacts) {
    lines.push(`  ${outcome.artifact}: ${outcome.state} — ${outcome.note}`);

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
    lines.push("  ! obrazy przeszły walidację — to nie to samo co przyjęcie ich przez człowieka");
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
    lines.push(`  ${entry.artifact}: ${mark} — ${entry.note}`);
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
async function checkCharacterStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace
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

  return result.ok
    ? ok(
        renderCharacterStatus(
          `Postać "${result.data.name}" (${characterId.data}), tor ${track.data} — etap 2${result.data.approved ? ", zatwierdzony w całości" : ""}`,
          result.data
        )
      )
    : result;
}

/** Who is accepting what, and where. The stage decides the rest. */
interface Approval {
  readonly mode: "apply" | "dry-run";
  readonly note: string | null;
  readonly projectId: string;
  readonly reviewer: string;
  readonly workspace: Workspace;
}

async function approveCharacterStage(parsed: Parsed, approval: Approval): Promise<Result<string>> {
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

  return result.ok
    ? ok(
        renderCharacterStatus(
          `Postać "${characterId.data}" na torze ${track.data} — zatwierdzono: ${artifacts.data.join(", ")}`,
          result.data
        )
      )
    : result;
}

/** The three text stages an episode carries. Each accepts its whole result. */
async function approveEpisodeStage(
  parsed: Parsed,
  approval: Approval,
  stage: "prompt-package" | "screenplay" | "shot-list"
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const scope = { ...approval, episodeId: episodeId.data };

  if (stage === "prompt-package") {
    const packaged = await approvePromptPackage(scope);

    return packaged.ok
      ? ok(
          renderPackageStatus(
            `Pakiet promptów odcinka "${episodeId.data}" zatwierdzony`,
            packaged.data,
            approval.projectId,
            episodeId.data,
            approval.mode
          )
        )
      : packaged;
  }

  if (stage === "shot-list") {
    const planned = await approveShotList(scope);

    return planned.ok
      ? ok(
          renderShotList(
            `Lista ujęć odcinka "${episodeId.data}" zatwierdzona`,
            planned.data,
            approval.projectId,
            episodeId.data,
            approval.mode
          )
        )
      : planned;
  }

  const result = await approveScreenplay(scope);

  return result.ok
    ? ok(
        renderScreenplay(
          `Scenariusz odcinka "${episodeId.data}" zatwierdzony`,
          result.data,
          approval.projectId,
          episodeId.data,
          approval.mode
        )
      )
    : result;
}

async function runApprove(argv: readonly string[]): Promise<Result<string>> {
  // `--stage character` narrows acceptance to one track and to named images,
  // so both flags belong to every approve call rather than to a separate
  // command. Declared here because a reader that is never parsed is a flag the
  // usage promises and the parser rejects.
  const parsed = parse(argv, {
    artifact: { type: "string" },
    note: { type: "string" },
    reviewer: { type: "string" },
    stage: { type: "string" },
    track: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const { note, stage } = parsed.data.values;
  const mode = modeOf(parsed.data);
  const approval = {
    mode,
    note: typeof note === "string" ? note : null,
    projectId: projectId.data,
    reviewer: reviewerOf(parsed.data),
    workspace: workspace.data,
  };

  if (stage === undefined || stage === "prepare") {
    const result = await approveStage0(approval);

    return result.ok
      ? ok(render(`Etap 0 projektu "${projectId.data}" zatwierdzony`, result.data, mode))
      : result;
  }

  if (stage === "character") {
    return await approveCharacterStage(parsed.data, approval);
  }

  if (stage !== "screenplay" && stage !== "shot-list" && stage !== "prompt-package") {
    return err(
      new UsageError(
        `--stage "${String(stage)}" — dozwolone: prepare, screenplay, character, shot-list, prompt-package`
      )
    );
  }

  return await approveEpisodeStage(parsed.data, approval, stage);
}

async function runScreenplay(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: screenplay ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
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

  const model = modelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data);

  if (!model.ok) {
    return model;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateScreenplay({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    episodeId: episodeId.data,
    fetch,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    workspace: workspace.data,
  });

  return result.ok ? ok(renderGenerate(result.data, projectId.data, episodeId.data, mode)) : result;
}

/** `--model` wins over the environment; neither has a default. */
function modelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_SCREENPLAY_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

function maxOutputTokensOf(parsed: Parsed, fallback = DEFAULT_MAX_OUTPUT_TOKENS): Result<number> {
  const flag = parsed.values["max-output-tokens"];

  if (typeof flag !== "string") {
    return ok(fallback);
  }

  const value = Number(flag);

  return Number.isSafeInteger(value) && value >= 256 && value <= 100_000
    ? ok(value)
    : err(new UsageError("--max-output-tokens: liczba całkowita od 256 do 100000"));
}

/**
 * `--dry-run` prints the prompt itself, not a byte count — the same promise
 * stage 1 makes, for the same reason: the preview exists so a person can read
 * what a paid call would send.
 */
function renderShotListGenerate(
  report: ShotListReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho — nic nie zapisano, nic nie wysłano. Lista ujęć ${projectId}/${episodeId}`,
          "  OPENAI_API_KEY nie był czytany — próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
        ]
      : [`Lista ujęć ${projectId}/${episodeId} — próba ${report.runId ?? ""}`];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    const { verdict } = report;
    lines.push(
      `  ujęcia: ${verdict.shots.length} w ${verdict.scenes.length} scenach, klipy: ${verdict.clips.length}, suma ${verdict.durationSeconds} s, najdłuższy klip ${verdict.longestClipSeconds} s (limit ${verdict.maxClipSeconds} s)`
    );
    lines.push(
      `  obsada w kadrze: ${verdict.castSeen.length === 0 ? "nikt z obsady" : verdict.castSeen.join(", ")}`
    );
    lines.push("  ! pokrycie i sumy czasów się zgadzają — inscenizacja wymaga oceny człowieka");
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

function renderShotList(
  headline: string,
  status: ShotListStatus,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines = [mode === "dry-run" ? `Próba na sucho — nic nie zapisano. ${headline}` : headline];

  if (status.verdict !== null) {
    lines.push(
      `  ujęcia: ${status.verdict.shots.length}, klipy: ${status.verdict.clips.length}, suma ${status.verdict.durationSeconds} s`
    );
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (status.status === "completed" && !status.approved && status.problems.length === 0) {
    lines.push(
      `  ! plik przeszedł walidację — to nie to samo co przyjęcie go przez człowieka: aimator approve ${projectId} ${episodeId} --stage shot-list`
    );
  }

  return lines.join("\n");
}

/** `--model` wins over the environment; neither has a default. */
function shotListModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_SHOTLIST_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

async function runShotList(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: shot-list ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
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

  const model = shotListModelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data, DEFAULT_SHOT_LIST_MAX_OUTPUT_TOKENS);

  if (!model.ok) {
    return model;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateShotList({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    episodeId: episodeId.data,
    fetch,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(renderShotListGenerate(result.data, projectId.data, episodeId.data, mode))
    : result;
}

/**
 * `--dry-run` prints the prompt itself, not a byte count — the same promise
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
          `Próba na sucho — nic nie zapisano, nic nie wysłano. Pakiet promptów ${projectId}/${episodeId}`,
          "  OPENAI_API_KEY nie był czytany — próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
          "  obrazy postaci nie są wysyłane: pakiet jest wspólny dla obu torów, więc niesie same identyfikatory hero:<id>",
        ]
      : [`Pakiet promptów ${projectId}/${episodeId} — próba ${report.runId ?? ""}`];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    lines.push(...describePackage(report.verdict));
    lines.push("  ! graf i przypisania się zgadzają — kierunek wymaga oceny człowieka");
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
  const lines = [mode === "dry-run" ? `Próba na sucho — nic nie zapisano. ${headline}` : headline];

  lines.push(...describePackage(status.verdict));

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (status.status === "completed" && !status.approved && status.problems.length === 0) {
    lines.push(
      `  ! pliki przeszły walidację — to nie to samo co przyjęcie ich przez człowieka: aimator approve ${projectId} ${episodeId} --stage prompt-package`
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

async function runPromptPackage(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: prompt-package ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
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

  return result.ok
    ? ok(renderPackageGenerate(result.data, projectId.data, episodeId.data, mode))
    : result;
}

async function runEpisodeAdd(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const source = requireFlag(parsed, "source");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!source.ok) {
    return source;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed);
  const result = await addEpisode({
    mode,
    projectId: projectId.data,
    settings: settingsOf(parsed),
    sourcePath: source.data,
    workspace: workspace.data,
  });

  return result.ok ? ok(render("Dodano odcinek", result.data, mode)) : result;
}

async function runEpisodeSet(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const episodeId = requirePositional(parsed, 1, "episode-id");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed);
  const result = await setEpisodeSettings({
    episodeId: episodeId.data,
    mode,
    projectId: projectId.data,
    settings: settingsOf(parsed),
    workspace: workspace.data,
  });

  return result.ok
    ? ok(render(`Ustawienia odcinka "${episodeId.data}"`, result.data, mode))
    : result;
}

async function runEpisode(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "set") {
    return err(new UsageError(`nieznane polecenie: episode ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    ...SETTINGS_OPTIONS,
    ...(action === "add" ? { source: { type: "string" as const } } : {}),
  });

  if (!parsed.ok) {
    return parsed;
  }

  return action === "add" ? await runEpisodeAdd(parsed.data) : await runEpisodeSet(parsed.data);
}

async function runCheck(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { stage: { type: "string" }, track: { type: "string" } });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  if (parsed.data.values.stage === "character") {
    return await checkCharacterStage(parsed.data, projectId.data, workspace.data);
  }

  const result = await checkStage0({ projectId: projectId.data, workspace: workspace.data });

  if (!result.ok) {
    return result;
  }

  const stage0 = render(`Projekt "${projectId.data}" — etap 0 gotowy`, result.data, "apply");
  const [, episodeId] = parsed.data.positionals;

  if (episodeId === undefined) {
    return ok(stage0);
  }

  // Naming an episode widens the check to its text stages. Nothing is written —
  // a check reports drift, it never records it.
  const scope = { episodeId, projectId: projectId.data, workspace: workspace.data };
  const stage1 = await checkScreenplay(scope);

  if (!stage1.ok) {
    return stage1;
  }

  const lines = [
    stage0,
    renderScreenplay(
      `Odcinek "${episodeId}" — etap 1: ${stage1.data.status}${stage1.data.approved ? ", zatwierdzony" : ""}`,
      stage1.data,
      projectId.data,
      episodeId,
      "apply"
    ),
  ];

  const stage3 = await checkShotList(scope);

  if (!stage3.ok) {
    return stage3;
  }

  lines.push(
    renderShotList(
      `Odcinek "${episodeId}" — etap 3: ${stage3.data.status}${stage3.data.approved ? ", zatwierdzony" : ""}`,
      stage3.data,
      projectId.data,
      episodeId,
      "apply"
    )
  );

  const stage4 = await checkPromptPackage(scope);

  if (!stage4.ok) {
    return stage4;
  }

  lines.push(
    renderPackageStatus(
      `Odcinek "${episodeId}" — etap 4: ${stage4.data.status}${stage4.data.approved ? ", zatwierdzony" : ""}`,
      stage4.data,
      projectId.data,
      episodeId,
      "apply"
    )
  );

  return ok(lines.join("\n"));
}

/**
 * argv in, outcome out. Filesystem effects live in lib/project; streams and
 * exit codes live in bin.ts — which is what keeps this testable by calling a
 * function instead of spawning a process.
 */
export async function run(argv: string[]): Promise<Result<string>> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help") {
    return ok(USAGE);
  }

  if (command === "project") {
    return await runProject(rest);
  }

  if (command === "character") {
    return await runCharacter(rest);
  }

  if (command === "episode") {
    return await runEpisode(rest);
  }

  if (command === "screenplay") {
    return await runScreenplay(rest);
  }

  if (command === "shot-list") {
    return await runShotList(rest);
  }

  if (command === "prompt-package") {
    return await runPromptPackage(rest);
  }

  if (command === "check") {
    return await runCheck(rest);
  }

  if (command === "approve") {
    return await runApprove(rest);
  }

  return err(new UsageError(`unknown command: ${command}`));
}
