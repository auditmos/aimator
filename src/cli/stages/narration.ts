import { env } from "../../lib/env.js";
import { ffmpeg } from "../../lib/muxer.js";
import {
  approveMix,
  approveNarration,
  checkMix,
  checkNarration,
  type DirectionReport,
  generateMix,
  generateNarration,
  type MixReport,
  type MixStatus,
  type NarrationReport,
  type NarrationStatus,
  setDirection,
} from "../../lib/narration/index.js";
import { err, ok, type Result } from "../../lib/result.js";
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
 * subcommand rather than the stage: `generate` lifts the words, `mix` lays
 * them on one track, and `direction` decides how the narrator reads. A field
 * that said the same word for all three would answer "which command wrote
 * this" with a guess, the reason stage 0's is two words.
 */
const STAGE = "soundtrack";

/** Stage 9: the words, shared by both tracks, and a mix that is not. */
export const USAGE = `Etap 9. Dźwięk (płatny; słowa wspólne, miks per tor):
  narration generate <id> <episode-id> [--model <id>] [--voice-model <id>]
                     [--max-output-tokens <n>] [--artifact script|N01[,N02]]
                     [--dry-run] [--json] [--regenerate]
    Podnosi narrację z zatwierdzonej listy ujęć i kupuje ją głosem z project.json.
    Narracji nie pisze: każde zdanie musi wystąpić dosłownie w polu Audio swojego
    ujęcia, a walidator to sprawdza, jeśli film ma powiedzieć coś nowego,
    poprawka należy do etapu 1. Skrypt i nagrania są WSPÓLNE dla obu torów, bo
    głos czytający zdanie nie wie, nad którym filmem usiądzie.
    ElevenLabs rozlicza ZNAKI, nie wywołania, więc podgląd podaje jedno i drugie.
  narration direction <id> [--stability <0-1>] [--style <0-1>] [--speed <0.7-1.2>]
                      [--similarity <0-1>] [--speaker-boost] [--dry-run] [--json]
    Jak narrator serii CZYTA. Bez tej decyzji każde wywołanie szło na domyślnych
    ustawieniach dostawcy, stability 0.5 i style 0, które sam dostawca opisuje
    jako skłonne do monotonii; płaskie brzmienie nie było wadą głosu, tylko
    brakiem miejsca na decyzję. Mieszka w narration.json OBOK project.json, a nie
    w nim: plik etapu 0 jest zapisanym wejściem niemal wszystkiego, więc suwak,
    który ma się kręcić, unieważniałby zgody na bajty, których nie dotknął. Tutaj
    unieważnia dokładnie te nagrania, które powstały pod starym brzmieniem.
    Głos to obsada (etap 0), sposób czytania to reżyseria (etap 9).
  narration mix <id> <episode-id> --track <gpt-image|seedream>
                [--dry-run] [--json] [--regenerate]
    Kładzie przyjęte kwestie na zatwierdzonym episode.mp4 i zapisuje
    <tor>/narrated.mp4. Obraz idzie kopią strumieniową, episode.mp4 nie jest
    nadpisywany ani przekodowywany. Kotwice z planu przelicza na oś TEGO toru,
    bo klipy wróciły z dryfem. Kwestia, która nachodziłaby na następną albo nie
    mieści się w filmie, jest ODMOWĄ, nie przesunięciem.
    Narracja to nie cała ścieżka: muzykę i efekty dokłada etap 10, więc ich brak
    jest tu meldowany, dokładnie jak cisza w etapie 8.`;

/**
 * Stage 9's shared half: the script, then the lines it authorises buying.
 *
 * Two model flags rather than one, because this stage buys from two providers
 * and a flag that did not say which model it meant would be worse than none,
 * the same refusal stage 7 makes about `--model`.
 */
async function runNarrationGenerate(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    artifact: { type: "string" },
    json: { type: "boolean" },
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    "voice-model": { type: "string" },
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

  const { model, "voice-model": voiceModel } = parsed.data.values;
  const mode = modeOf(parsed.data);
  const result = await generateNarration({
    artifacts: referenceIdsOf(parsed.data),
    episodeId: episodeId.data,
    fetch,
    maxOutputTokens: maxOutputTokens.data,
    mode,
    model: typeof model === "string" ? model : (env.AIMATOR_NARRATION_MODEL ?? null),
    openAiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    voiceKey: mode === "dry-run" ? null : (env.ELEVENLABS_API_KEY ?? null),
    voiceModel: typeof voiceModel === "string" ? voiceModel : (env.AIMATOR_VOICE_MODEL ?? null),
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? asJson("generate", STAGE, result.data)
      : renderNarration(result.data, projectId.data, episodeId.data, mode)
  );
}

/** Stage 9's per-track half: no model, no key, one program on this machine. */
async function runNarrationMix(argv: readonly string[]): Promise<Result<string>> {
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
  const result = await generateMix({
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
      : renderMix(result.data, projectId.data, episodeId.data, mode)
  );
}

/**
 * Stage 9's direction: how the narrator of this series performs.
 *
 * A project-level command because a reading recurs between episodes, and one
 * that writes stage 9's own file rather than stage 0's because a knob somebody
 * is expected to turn must not lapse approvals its bytes never touched.
 */
async function runNarrationDirection(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    json: { type: "boolean" },
    similarity: { type: "string" },
    "speaker-boost": { type: "boolean" },
    speed: { type: "string" },
    stability: { type: "string" },
    style: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);
  const similarityBoost = numberFlag(parsed.data, "similarity");
  const speed = numberFlag(parsed.data, "speed");
  const stability = numberFlag(parsed.data, "stability");
  const style = numberFlag(parsed.data, "style");

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  for (const flag of [similarityBoost, speed, stability, style]) {
    if (!flag.ok) {
      return flag;
    }
  }

  const mode = modeOf(parsed.data);
  const boost = parsed.data.values["speaker-boost"];
  const result = await setDirection({
    mode,
    projectId: projectId.data,
    similarityBoost: similarityBoost.ok ? similarityBoost.data : null,
    speakerBoost: typeof boost === "boolean" ? boost : null,
    speed: speed.ok ? speed.data : null,
    stability: stability.ok ? stability.data : null,
    style: style.ok ? style.data : null,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? asJson("direction", STAGE, result.data)
      : renderDirection(result.data, projectId.data, mode)
  );
}

/**
 * Five numbers, each said in the words that make it actionable.
 *
 * The labels carry the direction of each knob because the provider's own
 * defaults are the flat ones: somebody reading this after a flat take needs to
 * know which way to move, not merely what the value currently is.
 */
function renderDirection(
  report: DirectionReport,
  projectId: string,
  mode: "apply" | "dry-run"
): string {
  const { delivery } = report;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano. Narrator projektu "${projectId}"`
      : `Narrator projektu "${projectId}" czyta tak:`,
    `  stability ${delivery.stability}, niżej znaczy szerszy zakres emocji, wyżej monotonnie`,
    `  style ${delivery.style}, wyżej znaczy mocniejszy charakter głosu`,
    `  speed ${delivery.speed}, poniżej 1 zwalnia czytanie`,
    `  similarity ${delivery.similarityBoost}`,
    `  speaker-boost ${delivery.speakerBoost ? "tak" : "nie"}`,
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

export async function runNarration(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "generate") {
    return await runNarrationGenerate(argv.slice(1));
  }

  if (argv[0] === "mix") {
    return await runNarrationMix(argv.slice(1));
  }

  if (argv[0] === "direction") {
    return await runNarrationDirection(argv.slice(1));
  }

  return err(new UsageError(`nieznane polecenie: narration ${argv[0] ?? ""}`.trim()));
}

/**
 * The bill, in the unit this provider charges in.
 *
 * Calls and characters are printed together because neither alone is the
 * number a person needs: every other stage's call count is its bill, and here
 * it is not. No price; that is the account holder's business, and this tool
 * has never guessed one.
 */
function renderNarration(
  report: NarrationReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Narracja ${projectId}/${episodeId}`;
  const lines = [
    mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
    `  skrypt: ${report.script.state}, ${report.script.note}`,
    `  do kupienia: ${report.calls} wywołań, ${report.characters} znaków`,
  ];

  // Beside the bill, never inside it: the provider documents the continuity
  // parameters but does not say whether it charges for them, and this tool does
  // not guess with somebody else's account.
  if (report.contextCharacters > 0) {
    lines.push(
      `  + ${report.contextCharacters} znaków kontekstu (previous_text/next_text), dostawca nie podaje, czy je rozlicza`
    );
  }

  for (const line of report.lines) {
    lines.push(
      `      ${line.id}: ${line.state}, ${line.note}, ${line.characters} znaków${line.seconds === null ? "" : `, ${line.seconds}s`}`
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

  if (report.prompt !== null) {
    lines.push("", "--- prompt ---", report.prompt);
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

function renderMix(
  report: MixReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Miks ${projectId}/${episodeId}, tor ${report.track}`;
  const lines = [
    mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
    `  silnik: ${report.engine ?? "nieustalony"}`,
    `  film trwa ${report.actualSeconds}s`,
    `  narrated.mp4: ${report.state}`,
  ];

  for (const line of report.lines) {
    lines.push(
      `      ${line.id}: plan ${line.plannedSeconds}s → film ${line.atSeconds}s, ${line.seconds}s`
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

  if (report.state === "published") {
    lines.push("  ! plik przeszedł walidację; to nie to samo co odsłuchanie go przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

function renderNarrationStatus(headline: string, status: NarrationStatus): string {
  const lines = [
    headline,
    `  script: ${status.script.approved ? "zatwierdzony" : status.script.state}, ${status.script.note}, ${status.totalCharacters} znaków`,
  ];

  for (const line of status.lines) {
    lines.push(`      ${line.id}: ${line.approved ? "zatwierdzona" : line.state}, ${line.note}`);
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

function renderMixStatus(headline: string, status: MixStatus): string {
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
 * `check --stage soundtrack` reports the shared half, or one track's mix.
 *
 * `--track` is what decides which: stage 9 is the first stage whose artifacts
 * live at two levels, so the flag is not a narrowing here but a choice of
 * question. Without it the words are reported; with it, the film.
 */
export async function checkSoundtrackStage(
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
    const result = await checkNarration(scope);

    if (!result.ok) {
      return result;
    }

    return ok(
      answer === "json"
        ? asJson("check", STAGE, result.data)
        : renderNarrationStatus(
            `Odcinek "${episodeId.data}", etap 9, słowa${result.data.approved ? ", zatwierdzone" : ""}`,
            result.data
          )
    );
  }

  const track = trackOf(parsed);

  if (!track.ok) {
    return track;
  }

  const result = await checkMix({ ...scope, track: track.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderMixStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 9, miks${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data
        )
  );
}

/** `approve --stage soundtrack`: the script and the lines, or one track's mix. */
export async function approveSoundtrackStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  if (parsed.values.track === undefined) {
    const result = await approveNarration({
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
        : renderNarrationStatus(
            `Odcinek "${episodeId.data}", zatwierdzono słowa etapu 9`,
            result.data
          )
    );
  }

  const track = trackOf(parsed);

  if (!track.ok) {
    return track;
  }

  const result = await approveMix({
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
      : renderMixStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, zatwierdzono miks`,
          result.data
        )
  );
}
