import {
  approveClips,
  type ClipsReport,
  type ClipsStatus,
  checkClips,
  generateClips,
} from "../../lib/clips/index.js";
import { env } from "../../lib/env.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { ImageTrack, Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  asJson,
  keyFor,
  MODEL_ID,
  modeOf,
  type Parsed,
  parse,
  referenceIdsOf,
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 7: two media in one command, and a chain of human yeses. */
export const USAGE = `Etap 7. Klipy (płatny; per tor, dwa media w jednym poleceniu):
  clip generate <id> <episode-id> --track <gpt-image|seedream>
               [--artifact C01,entry:C02] [--image-model <id>] [--video-model <id>]
               [--dry-run] [--json] [--regenerate]
               [--republish --artifact C01]  ← publikuje z archiwum, nic nie wysyła
    Kupuje dwie rzeczy: klatki wejściowe (obraz, modelem obrazowym tego toru)
    i klipy (wideo, jednym modelem dla obu torów, AIMATOR_VIDEO_MODEL, klucz
    BYTEPLUS_MODELARK). Bramka jest łańcuchem: klip C01 czeka na zatwierdzoną
    klatkę otwarcia, klatka wejściowa C02 na zatwierdzoną końcówkę C01 (gdy
    lista ujęć mówi previous-end-frame), a klip C02 na tę klatkę. Raport podaje
    liczbę wywołań OSOBNO dla obrazów i dla wideo, zanim cokolwiek wyśle.
    Długość klipu bierze się z listy ujęć; klipu, którego model nie renderuje,
    narzędzie nie zaokrągli, odmówi i wskaże poprawkę w etapie 3.`;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "clips";

/**
 * Stage 7 prints two counts, because it buys two media and they do not cost
 * the same. A person reading a preview is deciding whether to spend on a video.
 */
function renderClips(
  report: ClipsReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const headline = `Klipy ${projectId}/${episodeId}, tor ${report.track}, kadr ${report.size}`;
  const bill = `obrazów: ${report.paidImages}, wideo: ${report.paidVideos}`;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
    mode === "dry-run"
      ? `  płatnych wywołań do wykonania, ${bill}`
      : `  płatnych wywołań wykonanych, ${bill}`,
  ];

  for (const outcome of report.artifacts) {
    lines.push(`  ${outcome.id} (${outcome.kind}): ${outcome.state}, ${outcome.note}`);

    for (const attachment of outcome.attachments) {
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
    lines.push("  ! wyniki przeszły walidację; to nie to samo co przyjęcie ich przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  for (const outcome of report.artifacts) {
    if (outcome.prompt !== null) {
      lines.push("", `--- prompt ${outcome.id} (dokładnie ten tekst) ---`, outcome.prompt);
    }
  }

  return lines.join("\n");
}

function renderClipsStatus(headline: string, status: ClipsStatus): string {
  const lines = [headline];

  for (const artifact of status.artifacts) {
    lines.push(
      `  ${artifact.id} (${artifact.kind}): ${artifact.approved ? "zatwierdzony" : artifact.state}, ${artifact.note}`
    );
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

/**
 * Stage 7 is the first command with two paid call sites, so it has two model
 * flags and no bare `--model`: one image model per track draws its entry
 * frames, and one video model, the same on both tracks, renders its clips.
 */
function imageModelFlagOf(parsed: Parsed, track: ImageTrack): Result<string | null> {
  const flag = parsed.values["image-model"];
  const fallback =
    track === "gpt-image"
      ? (env.AIMATOR_IMAGE_MODEL_GPT_IMAGE ?? null)
      : (env.AIMATOR_IMAGE_MODEL_SEEDREAM ?? null);
  const value = typeof flag === "string" ? flag : fallback;

  return value !== null && !MODEL_ID.test(value)
    ? err(new UsageError(`niepoprawny identyfikator modelu "${value}"`))
    : ok(value);
}

function videoModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values["video-model"];
  const value = typeof flag === "string" ? flag : (env.AIMATOR_VIDEO_MODEL ?? null);

  return value !== null && !MODEL_ID.test(value)
    ? err(new UsageError(`niepoprawny identyfikator modelu "${value}"`))
    : ok(value);
}

export async function runClip(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: clip ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    artifact: { type: "string" },
    "image-model": { type: "string" },
    json: { type: "boolean" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    republish: { type: "boolean" },
    track: { type: "string" },
    "video-model": { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  // `--model` is accepted by the parser only so it can be refused with a
  // sentence: two paid call sites mean the flag does not say which model.
  if (typeof parsed.data.values.model === "string") {
    return err(
      new UsageError(
        "--model nie wystarczy w etapie 7, są dwa płatne wywołania: --image-model <id> rysuje klatki wejściowe, --video-model <id> renderuje klipy"
      )
    );
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

  const imageModel = imageModelFlagOf(parsed.data, track.data);
  const videoModel = videoModelOf(parsed.data);

  if (!imageModel.ok) {
    return imageModel;
  }
  if (!videoModel.ok) {
    return videoModel;
  }

  const mode = modeOf(parsed.data);
  // Keys are read only on the paid path: a dry run must never need a secret.
  // The video key is BytePlus on both tracks, because the model is one.
  const result = await generateClips({
    artifacts: referenceIdsOf(parsed.data),
    episodeId: episodeId.data,
    fetch,
    imageKey: mode === "dry-run" ? null : (keyFor(track.data) ?? null),
    imageModel: imageModel.data,
    mode,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    republish: parsed.data.values.republish === true,
    track: track.data,
    videoKey: mode === "dry-run" ? null : (env.BYTEPLUS_MODELARK ?? null),
    videoModel: videoModel.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderClips(result.data, projectId.data, episodeId.data, mode)
  );
}

/** `check --stage clips` reports one episode's clips and entry frames, per track. */
export async function checkClipsStage(
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

  const result = await checkClips({
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
      : renderClipsStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 7${result.data.approved ? ", zatwierdzony w całości" : ""}`,
          result.data
        )
  );
}

export async function approveClipsStage(
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

  const result = await approveClips({
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
      : renderClipsStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, zatwierdzono`,
          result.data
        )
  );
}
