import { env } from "../../lib/env.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  approveVersions,
  type BindingReport,
  bindFaces,
  checkVersions,
  type FacesReport,
  findFaces,
  generateLipSync,
  type LipSyncReport,
  type VersionsStatus,
} from "../../lib/versions/index.js";
import type { ImageTrack, Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
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

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "versions";

/** Stage 12: the cast's mouths moved to the language of the mouths, per track. */
export const USAGE = `Etap 12. Wersje językowe (płatny; per tor, klip po klipie):
  versions faces <id> <episode-id> --track <gpt-image|seedream> --artifact C01
                 [--dry-run] [--json] [--regenerate]
    Rozpoznaje twarze w jednym przyjętym klipie jednym płatnym wywołaniem Kling
    (KLING_API_KEY) i zapisuje versions/faces/C01/faces.json oraz obrazek każdej
    twarzy, żeby człowiek widział, kogo przypisuje. Klip wyrenderowany przez
    Kling w ciągu 30 dni idzie po jego video_id; każdy inny jest pożyczany
    z prywatnego bucketu R2 (AIMATOR_LIPSYNC_BUCKET) i zabierany po wywołaniu.
    Lip-syncu potrzebuje klip, w którym mówi postać widoczna w ujęciu; reszta
    przechodzi do wersji bez zmian. Bez lip-sync.json odcinka każde polecenie
    etapu odmawia; dialogue-and-narration nie ma wersji (narracja poza zakresem).
  versions bind <id> <episode-id> --track <tor> --artifact C01
                --face <twarz>=<postać>[,<twarz>=<postać>] [--dry-run] [--json]
    Zapisuje, która twarz jest którą postacią, w versions/faces/C01/binding.json.
    Zawsze jawnie, także przy jednej twarzy. Twarz spoza faces.json albo postać
    spoza obsady to błąd. Ponowne rozpoznanie twarzy cofa przypisanie.
  versions lip-sync <id> <episode-id> --track <tor> [--artifact C01[,C02]]
                    [--dry-run] [--json] [--regenerate]
    Rusza usta każdej mówiącej postaci klipu do jej przyjętych kwestii w języku
    ust: jedna twarz na zadanie Kling, a kolejne idzie na wyniku poprzedniego,
    po jego video_id, przez nowe rozpoznanie twarzy pod tym samym face_id.
    Czeka na przyjęty klip, przyjęte kwestie, rozpoznane twarze i przypisanie
    każdej postaci mówiącej w kadrze. Podgląd podaje zadania per postać z oknem
    w ms oraz rachunek osobno: rozpoznania i zadania lip-sync. Postać mówiąca
    spoza kadru zostaje bez lip-syncu, z meldunkiem. Wynik:
    versions/clips/C01.mp4, zatwierdzany per klip.`;

function renderFaces(
  report: FacesReport,
  scope: { readonly episodeId: string; readonly projectId: string; readonly track: string },
  mode: "apply" | "dry-run"
): string {
  const named = `Twarze ${scope.projectId}/${scope.episodeId}, tor ${scope.track}, klip ${report.clip}`;
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. ${named}`,
          `  płatnych rozpoznań do wykonania: ${report.paidCalls}`,
        ]
      : [named, `  płatnych rozpoznań wykonanych: ${report.paidCalls}`];

  for (const face of report.faces) {
    lines.push(
      `      twarz ${face.id}: od ${face.start} ms do ${face.end} ms${face.image === null ? ", bez obrazka" : `, ${face.image}`}`
    );
  }

  return finish(lines, report);
}

/** What every report of this stage ends with: what it made, what stops it, what next. */
function finish(
  lines: string[],
  report: {
    readonly created: readonly string[];
    readonly nextStep: string;
    readonly notices: readonly string[];
    readonly problems?: readonly string[];
  }
): string {
  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const problem of report.problems ?? []) {
    lines.push(`  ! ${problem}`);
  }

  for (const notice of report.notices) {
    lines.push(`  · ${notice}`);
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

function renderBinding(report: BindingReport, mode: "apply" | "dry-run"): string {
  const bound = Object.entries(report.faces).map(([face, cast]) => `${face}=${cast}`);
  const lines = [
    `${mode === "dry-run" ? "Próba na sucho: nic nie zapisano. " : ""}Przypisanie twarzy, klip ${report.clip}: ${bound.join(", ")}`,
  ];

  return finish(lines, report);
}

/** Two counts, because a clip with two speakers costs a face call beside each job. */
function renderLipSync(
  report: LipSyncReport,
  scope: { readonly episodeId: string; readonly projectId: string; readonly track: string },
  mode: "apply" | "dry-run"
): string {
  const named = `Lip-sync ${scope.projectId}/${scope.episodeId}, tor ${scope.track}`;
  const bill = `rozpoznań: ${report.paidFaces}, zadań lip-sync: ${report.paidLipSyncs}`;
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. ${named}`,
          `  płatnych wywołań do wykonania, ${bill}`,
        ]
      : [named, `  płatnych wywołań wykonanych, ${bill}`];

  for (const clip of report.clips) {
    lines.push(`  ${clip.id}:`);

    for (const job of clip.jobs) {
      lines.push(
        `      ${job.key}: ${job.cast}, twarz ${job.face}, od ${job.start} ms do ${job.end} ms, ${job.lines.join(", ")}, ${job.state}`
      );
    }
  }

  return finish(lines, report);
}

function renderStatus(headline: string, status: VersionsStatus): string {
  const lines = [headline];

  for (const clip of status.clips) {
    lines.push(`  ${clip.id}: ${clip.approved ? "zatwierdzony" : clip.state}, ${clip.note}`);
  }

  if (status.untouched.length > 0) {
    lines.push(`  bez zmian: ${status.untouched.join(", ")}`);
  }

  return finish(lines, { ...status, created: [] });
}

/** `--face 0=ewa,1=tata`: face id to cast id, refused rather than guessed at when malformed. */
function facesOf(parsed: Parsed): Result<Readonly<Record<string, string>>> {
  const flag = parsed.values.face;
  const pairs = typeof flag === "string" ? flag.split(",").map((one) => one.trim()) : [];
  const faces: Record<string, string> = {};

  for (const pair of pairs.filter((one) => one !== "")) {
    const [face = "", cast = "", ...rest] = pair.split("=");

    if (face === "" || cast === "" || rest.length > 0) {
      return err(new UsageError(`--face "${pair}": oczekiwano <twarz>=<postać>, np. 0=ewa`));
    }

    if (Object.hasOwn(faces, face)) {
      return err(new UsageError(`--face: twarz ${face} przypisana dwa razy`));
    }

    faces[face] = cast;
  }

  return ok(faces);
}

/** The one clip a face call or a binding is about: `--artifact` with exactly one id. */
function clipOf(parsed: Parsed): Result<string> {
  const ids = referenceIdsOf(parsed);
  const [only] = ids;

  return ids.length === 1 && only !== undefined
    ? ok(only)
    : err(new UsageError("--artifact: dokładnie jeden klip, np. C01"));
}

interface Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

function scopeOf(parsed: Parsed): Result<Scope> {
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

  return track.ok
    ? ok({
        episodeId: episodeId.data,
        projectId: projectId.data,
        track: track.data,
        workspace: workspace.data,
      })
    : track;
}

/** The private bucket a clip is lent from, read only on the paid path. */
function hosting(mode: "apply" | "dry-run") {
  return {
    AIMATOR_LIPSYNC_BUCKET: mode === "dry-run" ? undefined : env.AIMATOR_LIPSYNC_BUCKET,
    R2_ACCESS_KEY_ID: mode === "dry-run" ? undefined : env.R2_ACCESS_KEY_ID,
    R2_ACCOUNT_ID: mode === "dry-run" ? undefined : env.R2_ACCOUNT_ID,
    R2_SECRET_ACCESS_KEY: mode === "dry-run" ? undefined : env.R2_SECRET_ACCESS_KEY,
  };
}

async function runFaces(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    artifact: { type: "string" },
    json: { type: "boolean" },
    regenerate: { type: "boolean" },
    track: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const scope = scopeOf(parsed.data);
  const clip = clipOf(parsed.data);

  if (!scope.ok) {
    return scope;
  }
  if (!clip.ok) {
    return clip;
  }

  const mode = modeOf(parsed.data);
  // Keys are read only on the paid path: a dry run must never need a secret.
  const result = await findFaces({
    ...scope.data,
    apiKey: mode === "dry-run" ? null : (env.KLING_API_KEY ?? null),
    artifact: clip.data,
    fetch,
    hosting: hosting(mode),
    mode,
    regenerate: parsed.data.values.regenerate === true,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("faces", STAGE, result.data)
      : renderFaces(result.data, scope.data, mode)
  );
}

async function runBind(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    artifact: { type: "string" },
    face: { type: "string" },
    json: { type: "boolean" },
    track: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const scope = scopeOf(parsed.data);
  const clip = clipOf(parsed.data);
  const faces = facesOf(parsed.data);

  if (!scope.ok) {
    return scope;
  }
  if (!clip.ok) {
    return clip;
  }
  if (!faces.ok) {
    return faces;
  }

  const mode = modeOf(parsed.data);
  const result = await bindFaces({ ...scope.data, artifact: clip.data, faces: faces.data, mode });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("bind", STAGE, result.data)
      : renderBinding(result.data, mode)
  );
}

async function runLipSync(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    artifact: { type: "string" },
    json: { type: "boolean" },
    regenerate: { type: "boolean" },
    track: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const scope = scopeOf(parsed.data);

  if (!scope.ok) {
    return scope;
  }

  const mode = modeOf(parsed.data);
  // Keys are read only on the paid path: a dry run must never need a secret.
  const result = await generateLipSync({
    ...scope.data,
    apiKey: mode === "dry-run" ? null : (env.KLING_API_KEY ?? null),
    artifacts: referenceIdsOf(parsed.data),
    fetch,
    hosting: hosting(mode),
    mode,
    regenerate: parsed.data.values.regenerate === true,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("lip-sync", STAGE, result.data)
      : renderLipSync(result.data, scope.data, mode)
  );
}

export async function runVersions(argv: readonly string[]): Promise<Result<string>> {
  const [command, ...rest] = argv;

  if (command === "faces") {
    return await runFaces(rest);
  }

  if (command === "bind") {
    return await runBind(rest);
  }

  if (command === "lip-sync") {
    return await runLipSync(rest);
  }

  return err(new UsageError(`nieznane polecenie: versions ${command ?? ""}`.trim()));
}

/** `check --stage versions` reports one episode's language version, per track. */
export async function checkVersionsStage(
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

  const result = await checkVersions({
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
      : renderStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 12${result.data.approved ? ", zatwierdzony w całości" : ""}`,
          result.data
        )
  );
}

/** `approve --stage versions`: a person watched the mouths land on the lines, clip by clip. */
export async function approveVersionsStage(
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

  const result = await approveVersions({
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
      : renderStatus(
          `Odcinek "${episodeId.data}", tor ${track.data}, etap 12, zatwierdzono: ${referenceIdsOf(parsed).join(", ")}`,
          result.data
        )
  );
}
