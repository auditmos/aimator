import { env } from "../../lib/env.js";
import { ffmpeg } from "../../lib/muxer.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  approveMaster,
  approveSoundDesign,
  checkMaster,
  checkSoundDesign,
  generateMaster,
  generateSoundDesign,
  type LevelsReport,
  type MasterReport,
  type MasterStatus,
  type SoundDesignReport,
  type SoundDesignStatus,
  setLevels,
} from "../../lib/sound-design/index.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  answerFlag,
  asJson,
  maxOutputTokensOf,
  modeOf,
  numberFlag,
  type Parsed,
  parse,
  referenceIdsOf,
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/**
 * Which stage this file answers for, in the word `--stage` takes.
 *
 * One stage written by three commands, which is why `command` carries the
 * subcommand rather than the stage: `generate` writes the sheet and buys the
 * stems it authorises, `mix` lays them on one track, and `levels` decides how
 * loud the result sits. A field that said the same word for all three would
 * answer "which command wrote this" with a guess, the reason stage 0's is two
 * words and stage 9's is a subcommand.
 */
const STAGE = "sound-design";

/** Stage 10: music and effects, and the film with everything in it. */
export const USAGE = `Etap 10. Muzyka i efekty (płatny; stemy wspólne, miks per tor):
  sound-design generate <id> <episode-id> [--model <id>] [--music-model <id>]
                        [--effects-model <id>] [--max-output-tokens <n>]
                        [--artifact cues|M01[,E02]] [--dry-run] [--json]
                        [--regenerate]
    Pisze arkusz cue z zatwierdzonej listy ujęć, a potem kupuje to, co arkusz
    autoryzuje: podkład z /v1/music i efekty z /v1/sound-generation (klucz
    ELEVENLABS_API_KEY, ten sam co mowa, to czwarte i piąte miejsce wywołania
    u dostawcy, którego potok już ma, nie czwarty dostawca).
    Arkusz jest INSTRUKCJĄ, więc idzie po angielsku (reguła 9), a lista ujęć
    jedzie obok niego dosłownie, po swojemu. Nie ma tu odpowiednika reguły
    „podnoszone, nie pisane" z etapu 9 i nie da się go mieć: prompt muzyczny
    trzeba napisać, a nie przepisać. Zamiast niego jest werdykt okablowania
    etapu 4, każde ujęcie policzone, podkład kafelkujący film bez dziur,
    każda długość taka, jaką dostawca zrenderuje, i człowiek, który to czyta.
    ElevenLabs wycenia muzykę i efekty ZA MINUTĘ dźwięku i nalicza przy
    GENERACJI, więc podgląd podaje wywołania I sekundy, a --regenerate to druga
    pełna opłata.
  sound-design levels <id> [--music-db <n>] [--effects-db <n>] [--duck-db <n>]
                      [--duck-release <ms>] [--dry-run] [--json]
    Jak głośno siedzi podkład i jak mocno ustępuje pod mową. Mieszka
    w projects/<id>/mix.json, nie w project.json, bo suwak unieważniałby zgody
    na bajty, których nie dotknął, i nie w narration.json, bo głośność muzyki
    nie mówi nic o tym, jak narrator czytał, więc nie może unieważniać nagrań.
    Wartości startowe są, bo tej decyzji nie da się podjąć, zanim się ją usłyszy;
    jadą jawnie do silnika i lądują w archiwum.
  sound-design mix <id> <episode-id> --track <gpt-image|seedream>
                   [--dry-run] [--json] [--regenerate]
    Składa <tor>/mixed.mp4 z episode.mp4 i stemów, NIE z narrated.mp4. Dzięki
    temu mowa koduje się dokładnie raz, a muzyka w ogóle może ustąpić pod
    głosem. narrated.mp4 nie jest nadpisywany ani unieważniany: zostaje
    przyjętym produktem pośrednim i jedynym miejscem, gdzie słychać samo
    umieszczenie narracji, i to od tej zgody ten etap bramkuje.
    Efekt, który wychodzi poza koniec filmu, jest ODMOWĄ; podkład, który kończy
    się przed nim, jest MELDUNKIEM, pierwsze to zderzenie, drugie to dryf.`;

/**
 * Stage 10's shared half: the cue sheet, then the stems it authorises buying.
 *
 * Three model flags, because this stage buys from three call sites, one text
 * model writes the sheet, one music model composes a bed and one effect model
 * renders a sound. A flag that did not say which model it meant would be worse
 * than none, which is the refusal stage 7 already makes about `--model`.
 */
async function runSoundDesignGenerate(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    artifact: { type: "string" },
    "effects-model": { type: "string" },
    json: { type: "boolean" },
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    "music-model": { type: "string" },
    regenerate: { type: "boolean" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);
  const maxOutputTokens = maxOutputTokensOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!maxOutputTokens.ok) {
    return maxOutputTokens;
  }

  const { "effects-model": effects, model, "music-model": music } = parsed.data.values;
  const mode = modeOf(parsed.data);
  const result = await generateSoundDesign({
    artifacts: referenceIdsOf(parsed.data),
    audioKey: mode === "dry-run" ? null : (env.ELEVENLABS_API_KEY ?? null),
    effectsModel: typeof effects === "string" ? effects : (env.AIMATOR_EFFECTS_MODEL ?? null),
    episodeId: episodeId.data,
    fetch,
    maxOutputTokens: maxOutputTokens.data,
    mode,
    model: typeof model === "string" ? model : (env.AIMATOR_SOUND_MODEL ?? null),
    musicModel: typeof music === "string" ? music : (env.AIMATOR_MUSIC_MODEL ?? null),
    openAiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? asJson("generate", STAGE, result.data)
      : renderSoundDesign(result.data, projectId.data, episodeId.data, mode)
  );
}

/** Stage 10's per-track half: no model, no key, one program on this machine. */
async function runSoundDesignMix(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
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
  const result = await generateMaster({
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
      ? asJson("mix", STAGE, result.data)
      : renderMaster(result.data, projectId.data, episodeId.data, mode)
  );
}

/**
 * Stage 10's levels: how loud this series sits and how far the bed gives way.
 *
 * A project-level command, like stage 9's direction and for the same reason,
 * and it writes its own file rather than stage 9's, because how loud the music
 * is says nothing about how the narrator read, and must not lapse a recording.
 */
async function runSoundDesignLevels(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    "duck-db": { type: "string" },
    "duck-release": { type: "string" },
    "effects-db": { type: "string" },
    json: { type: "boolean" },
    "music-db": { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);
  const duckDb = numberFlag(parsed.data, "duck-db");
  const duckReleaseMs = numberFlag(parsed.data, "duck-release");
  const effectsDb = numberFlag(parsed.data, "effects-db");
  const musicDb = numberFlag(parsed.data, "music-db");

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  for (const flag of [duckDb, duckReleaseMs, effectsDb, musicDb]) {
    if (!flag.ok) {
      return flag;
    }
  }

  const mode = modeOf(parsed.data);
  const result = await setLevels({
    duckDb: duckDb.ok ? duckDb.data : null,
    duckReleaseMs: duckReleaseMs.ok ? duckReleaseMs.data : null,
    effectsDb: effectsDb.ok ? effectsDb.data : null,
    mode,
    musicDb: musicDb.ok ? musicDb.data : null,
    projectId: projectId.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? asJson("levels", STAGE, result.data)
      : renderLevels(result.data, projectId.data, mode)
  );
}

/** Four numbers, each said in the words that make it actionable. */
function renderLevels(report: LevelsReport, projectId: string, mode: "apply" | "dry-run"): string {
  const { levels } = report;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano. Miks projektu "${projectId}"`
      : `Miks projektu "${projectId}" siedzi tak:`,
    `  music-db ${levels.musicDb}, podkład względem tego, jak go kupiono; niżej znaczy dalej`,
    `  effects-db ${levels.effectsDb}, efekty; one mają być słyszalne`,
    `  duck-db ${levels.duckDb}, o tyle podkład ustępuje, kiedy ktoś mówi`,
    `  duck-release ${levels.duckReleaseMs} ms, jak szybko wraca po kwestii`,
  ];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }
  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

export async function runSoundDesign(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "generate") {
    return await runSoundDesignGenerate(argv.slice(1));
  }

  if (argv[0] === "mix") {
    return await runSoundDesignMix(argv.slice(1));
  }

  if (argv[0] === "levels") {
    return await runSoundDesignLevels(argv.slice(1));
  }

  return err(new UsageError(`nieznane polecenie: sound-design ${argv[0] ?? ""}`.trim()));
}

/**
 * Stage 10's report, with **two numbers** before anything is spent.
 *
 * The count of calls is not the bill here: this provider rates music and
 * effects per minute of generated audio, so one call for a ninety-second bed
 * and one for a half-second click are the same number and nothing like the
 * same money. Both are printed, per cue and in total, and neither is a price.
 */
function renderSoundDesign(
  report: SoundDesignReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Dźwięk ${projectId}/${episodeId}`;
  const lines = [
    mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
    `  arkusz: ${report.sheet.state}, ${report.sheet.note}`,
    `  do kupienia: ${report.calls} wywołań, ${report.seconds}s dźwięku`,
  ];

  for (const cue of report.cues) {
    lines.push(`      ${cue.id} (${cue.kind}): ${cue.state}, ${cue.note}, ${cue.seconds}s`);
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

  if (report.prompt !== null) {
    lines.push("", "--- prompt ---", report.prompt);
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

function renderMaster(
  report: MasterReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Pełna ścieżka ${projectId}/${episodeId}, tor ${report.track}`;
  const { levels } = report;
  const lines = [
    mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
    `  ${report.state}, film trwa ${report.actualSeconds}s, silnik ${report.engine ?? "nieznany"}`,
    `  poziomy: music ${levels.musicDb} dB, efekty ${levels.effectsDb} dB, ducking ${levels.duckDb} dB / ${levels.duckReleaseMs} ms`,
  ];

  for (const sound of report.sounds) {
    lines.push(
      `      ${sound.id} (${sound.kind}): ${sound.plannedSeconds}s planu → ${sound.atSeconds}s filmu, ${sound.seconds}s`
    );
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

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

function renderSoundDesignStatus(headline: string, status: SoundDesignStatus): string {
  const lines = [
    headline,
    `  cues: ${status.sheet.approved ? "zatwierdzony" : status.sheet.state}, ${status.sheet.note}, ${status.totalSeconds}s`,
  ];

  for (const cue of status.cues) {
    lines.push(`      ${cue.id}: ${cue.approved ? "zatwierdzony" : cue.state}, ${cue.note}`);
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  for (const notice of status.notices) {
    lines.push(`  · ${notice}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

function renderMasterStatus(headline: string, status: MasterStatus): string {
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
 * `check --stage sound-design` reports the shared half, or one track's mix.
 *
 * `--track` decides which, exactly as it does for stage 9: this stage's
 * artifacts live at two levels, so the flag is a choice of question rather
 * than a narrowing. Without it the cue sheet and the stems; with it, the film.
 */
export async function checkSoundDesignStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const scope = { episodeId: episodeId.data, projectId, workspace };

  if (parsed.values.track === undefined) {
    const result = await checkSoundDesign(scope);

    if (!result.ok) {
      return result;
    }

    return ok(
      answer === "json"
        ? asJson("check", STAGE, result.data)
        : renderSoundDesignStatus(
            `Odcinek "${episodeId.data}", etap 10, muzyka i efekty${result.data.approved ? ", zatwierdzone" : ""}`,
            result.data
          )
    );
  }

  const track = trackOf(parsed);

  if (!track.ok) {
    return track;
  }

  const result = await checkMaster({ ...scope, track: track.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderMasterStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 10, pełna ścieżka${result.data.approved ? ", zatwierdzona" : ""}`,
          result.data
        )
  );
}

/** `approve --stage sound-design`: the sheet and the stems, or one track's mix. */
export async function approveSoundDesignStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  if (parsed.values.track === undefined) {
    const result = await approveSoundDesign({
      ...approval,
      artifacts: referenceIdsOf(parsed),
      episodeId: episodeId.data,
    });

    if (!result.ok) {
      return result;
    }

    return ok(
      approval.answer === "json"
        ? asJson("approve", STAGE, result.data)
        : renderSoundDesignStatus(
            `Odcinek "${episodeId.data}", zatwierdzono muzykę i efekty etapu 10`,
            result.data
          )
    );
  }

  const track = trackOf(parsed);

  if (!track.ok) {
    return track;
  }

  const result = await approveMaster({
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
      : renderMasterStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, zatwierdzono pełną ścieżkę`,
          result.data
        )
  );
}
