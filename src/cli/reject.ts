import {
  applyWrites,
  readJson,
  rejectArtifacts,
  serialize,
  stageFileSchema,
} from "../lib/artifact/index.js";
import { checkAssembly } from "../lib/assembly/index.js";
import { checkCharacter } from "../lib/character/index.js";
import type { Check } from "../lib/checklist.js";
import { checkClips } from "../lib/clips/index.js";
import { checkMix, checkNarration } from "../lib/narration/index.js";
import { checkOpeningFrame } from "../lib/opening-frame/index.js";
import { checkPromptPackage } from "../lib/prompt-package/index.js";
import { checkReferences } from "../lib/references/index.js";
import { err, ok, type Result } from "../lib/result.js";
import { checkScreenplay } from "../lib/screenplay/index.js";
import { checkShotList } from "../lib/shot-list/index.js";
import { checkMaster, checkSoundDesign } from "../lib/sound-design/index.js";
import { checkStyle } from "../lib/style/index.js";
import {
  characterPaths,
  characterTrackPaths,
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  type ProjectPaths,
  projectPaths,
  styleTrackPaths,
  type Workspace,
} from "../lib/workspace.js";
import {
  answerOf,
  asJson,
  failedOf,
  modeOf,
  type Parsed,
  parse,
  referenceIdsOf,
  requirePositional,
  reviewerOf,
  trackOf,
  UsageError,
  workspaceOf,
} from "./common.js";

/** A no with a reason, in the words the usage text promises. */
export const USAGE = `  reject <id> <episode-id> --stage <etap> [--track <tor>] [--artifact <klucz>[,...]]
              --note <uwaga> [--fail <kryteria>] [--reviewer <kto>] [--json]
  reject <id> <character-id> --stage character --track <tor> --artifact <klucz>
              --note <uwaga> [--json]
  reject <id> --stage style --track <tor> --artifact S01[,S02] --note <uwaga> [--json]
    Zapisuje "nie" z powodem: review.status "rejected", uwagę, kto i kiedy, z tymi
    samymi zakresami co approve (bez etapu 0). Bramki traktują odrzucony artefakt
    jak niezatwierdzony; approve może go potem przyjąć. --fail tylko na klatkach
    z checklistą QC (opening-frame, entry:Cnn). --regenerate odrzuconego
    artefaktu bez --instruction poprawia go według tej uwagi.`;

/** A stage that has produced nothing here yet: there is no result to say no to. */
class NothingToRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToRejectError";
  }
}

/** Where one stage's rejection is written, and what it prints afterwards. */
interface Located {
  /** The stage's own object after the write, what `--json` prints. */
  readonly check: () => Promise<Result<object>>;
  /** Whether a key is a frame judged against the QC checklist, the only ones `--fail` fits. */
  readonly checklisted: (key: string) => boolean;
  /** The stage file the rejection is written into. */
  readonly file: string;
  /** What a person runs next: the same artifacts, bought again. */
  readonly regenerate: (keys: readonly string[]) => string;
  /** How the headline names the scope, after the stage. */
  readonly where: string;
}

interface Scope {
  readonly parsed: Parsed;
  readonly projectId: string;
  readonly workspace: Workspace;
}

type Locate = (scope: Scope) => Result<Located>;

const NO_CHECKLIST = (): boolean => false;

function projectOf(scope: Scope): Result<ProjectPaths> {
  return projectPaths(scope.workspace, scope.projectId);
}

/** The episode a stage below the project is asked about, and its paths. */
function episodeOf(
  scope: Scope
): Result<{ readonly episodeId: string; readonly paths: EpisodePaths }> {
  const episodeId = requirePositional(scope.parsed, 1, "episode-id");
  const project = projectOf(scope);

  if (!episodeId.ok) {
    return episodeId;
  }
  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, episodeId.data);

  return paths.ok ? ok({ episodeId: episodeId.data, paths: paths.data }) : paths;
}

interface EpisodeOn {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

/** A stage whose file lives once per episode. */
function episodeStage(spec: {
  readonly check: (on: EpisodeOn) => Promise<Result<object>>;
  readonly file: (paths: EpisodePaths) => string;
  readonly regenerate: (on: EpisodeOn, keys: readonly string[]) => string;
}): Locate {
  return (scope) => {
    const episode = episodeOf(scope);

    if (!episode.ok) {
      return episode;
    }

    const on = { ...scope, episodeId: episode.data.episodeId };

    return ok({
      check: () => spec.check(on),
      checklisted: NO_CHECKLIST,
      file: spec.file(episode.data.paths),
      regenerate: (keys) => spec.regenerate(on, keys),
      where: `odcinek ${on.episodeId}`,
    });
  };
}

type TrackOn = EpisodeOn & { readonly track: ImageTrack };

/** A stage whose file lives once per episode per track. */
function trackStage(spec: {
  readonly check: (on: TrackOn) => Promise<Result<object>>;
  readonly checklisted?: (key: string) => boolean;
  readonly file: (paths: EpisodeTrackPaths) => string;
  readonly regenerate: (on: TrackOn, keys: readonly string[]) => string;
}): Locate {
  return (scope) => {
    const episode = episodeOf(scope);
    const track = trackOf(scope.parsed);

    if (!episode.ok) {
      return episode;
    }
    if (!track.ok) {
      return track;
    }

    const on = { ...scope, episodeId: episode.data.episodeId, track: track.data };

    return ok({
      check: () => spec.check(on),
      checklisted: spec.checklisted ?? NO_CHECKLIST,
      file: spec.file(episodeTrackPaths(episode.data.paths, track.data)),
      regenerate: (keys) => spec.regenerate(on, keys),
      where: `tor ${track.data}`,
    });
  };
}

/** Stages 9 and 10: the shared words without `--track`, the track's mix with it. */
function twoLevels(episode: Locate, track: Locate): Locate {
  return (scope) => (scope.parsed.values.track === undefined ? episode(scope) : track(scope));
}

const artifactFlag = (keys: readonly string[]): string => `--artifact ${keys.join(",")}`;

/**
 * One table, so whatever can be accepted can be refused the same way.
 *
 * Every stage `approve` accepts is here but stage 0, whose records are a
 * person's own decisions rather than anything made for them: there is nothing
 * to say no to that the same person would not simply edit and approve.
 */
const STAGES: Readonly<Record<string, Locate>> = {
  assembly: trackStage({
    check: checkAssembly,
    file: (paths) => paths.assemblyStage,
    regenerate: (on) =>
      `aimator assembly generate ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate`,
  }),
  character: (scope) => {
    const characterId = requirePositional(scope.parsed, 1, "character-id");
    const track = trackOf(scope.parsed);
    const project = projectOf(scope);

    if (!characterId.ok) {
      return characterId;
    }
    if (!track.ok) {
      return track;
    }
    if (!project.ok) {
      return project;
    }

    const paths = characterPaths(project.data, characterId.data);

    if (!paths.ok) {
      return paths;
    }

    const on = { ...scope, characterId: characterId.data, track: track.data };

    return ok({
      check: () => checkCharacter(on),
      checklisted: NO_CHECKLIST,
      file: characterTrackPaths(paths.data, track.data).stage,
      regenerate: (keys) =>
        `aimator character generate ${on.projectId} ${on.characterId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
      where: `postać ${on.characterId}, tor ${on.track}`,
    });
  },
  clips: trackStage({
    check: checkClips,
    checklisted: (key) => key.startsWith("entry:"),
    file: (paths) => paths.clipsStage,
    regenerate: (on, keys) =>
      `aimator clip generate ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
  }),
  "opening-frame": trackStage({
    check: checkOpeningFrame,
    checklisted: () => true,
    file: (paths) => paths.openingFrameStage,
    regenerate: (on) =>
      `aimator opening-frame generate ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate`,
  }),
  "prompt-package": episodeStage({
    check: checkPromptPackage,
    file: (paths) => paths.promptPackageStage,
    regenerate: (on) =>
      `aimator prompt-package generate ${on.projectId} ${on.episodeId} --regenerate`,
  }),
  references: trackStage({
    check: checkReferences,
    file: (paths) => paths.referencesStage,
    regenerate: (on, keys) =>
      `aimator reference generate ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
  }),
  screenplay: episodeStage({
    check: checkScreenplay,
    file: (paths) => paths.screenplayStage,
    regenerate: (on) => `aimator screenplay generate ${on.projectId} ${on.episodeId} --regenerate`,
  }),
  "shot-list": episodeStage({
    check: checkShotList,
    file: (paths) => paths.shotListStage,
    regenerate: (on) => `aimator shot-list generate ${on.projectId} ${on.episodeId} --regenerate`,
  }),
  "sound-design": twoLevels(
    episodeStage({
      check: checkSoundDesign,
      file: (paths) => paths.soundDesignStage,
      regenerate: (on, keys) =>
        `aimator sound-design generate ${on.projectId} ${on.episodeId} --regenerate ${artifactFlag(keys)}`,
    }),
    trackStage({
      check: checkMaster,
      file: (paths) => paths.soundDesignStage,
      regenerate: (on) =>
        `aimator sound-design mix ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate`,
    })
  ),
  soundtrack: twoLevels(
    episodeStage({
      check: checkNarration,
      file: (paths) => paths.soundtrackStage,
      regenerate: (on, keys) =>
        `aimator narration generate ${on.projectId} ${on.episodeId} --regenerate ${artifactFlag(keys)}`,
    }),
    trackStage({
      check: checkMix,
      file: (paths) => paths.soundtrackStage,
      regenerate: (on) =>
        `aimator narration mix ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate`,
    })
  ),
  style: (scope) => {
    const track = trackOf(scope.parsed);
    const project = projectOf(scope);

    if (!track.ok) {
      return track;
    }
    if (!project.ok) {
      return project;
    }

    const on = { ...scope, track: track.data };

    return ok({
      check: () => checkStyle(on),
      checklisted: NO_CHECKLIST,
      file: styleTrackPaths(project.data, track.data).stage,
      regenerate: (keys) =>
        `aimator style generate ${on.projectId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
      where: `projekt, tor ${on.track}`,
    });
  },
};

/** `--fail` only where a checklist was the yes it stands in for. */
function failedFor(
  located: Located,
  keys: readonly string[],
  failed: readonly Check[] | null
): Result<Readonly<Record<string, readonly Check[]>>> {
  if (failed === null) {
    return ok({});
  }

  const plain = keys.filter((key) => !located.checklisted(key));

  return plain.length > 0
    ? err(
        new UsageError(
          `--fail dotyczy tylko klatek z checklistą QC (opening-frame, entry:Cnn), a ${plain.join(", ")} jej nie ma`
        )
      )
    : ok(Object.fromEntries(keys.map((key) => [key, failed])));
}

/**
 * Records a human saying no, with the reason, bound to nothing but the record.
 *
 * Unlike `approve` it verifies no bytes: a no needs no proof that the result is
 * intact, and refusing to record one over a broken file would leave a person
 * no way to say what is wrong with it. What it does refuse is a no about
 * nothing: an artifact the stage file does not hold, or an attempt that never
 * finished. With no `--artifact` it means every artifact in the file, which is
 * exactly one wherever `approve` does not ask for the flag either.
 */
export async function runReject(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    artifact: { type: "string" },
    fail: { type: "string" },
    json: { type: "boolean" },
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
  const answer = answerOf(parsed.data);
  const failed = failedOf(parsed.data);
  const { note, stage } = parsed.data.values;

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!answer.ok) {
    return answer;
  }
  if (!failed.ok) {
    return failed;
  }

  const locate = typeof stage === "string" ? STAGES[stage] : undefined;

  if (locate === undefined || typeof stage !== "string") {
    return err(
      new UsageError(`--stage "${String(stage)}", dozwolone: ${Object.keys(STAGES).join(", ")}`)
    );
  }

  if (typeof note !== "string" || note.trim() === "") {
    return err(
      new UsageError("brakuje --note: odrzucenie bez powodu nie ma czym zasilić poprawki")
    );
  }

  const located = locate({
    parsed: parsed.data,
    projectId: projectId.data,
    workspace: workspace.data,
  });

  if (!located.ok) {
    return located;
  }

  const mode = modeOf(parsed.data);
  const done = await writeRejection({
    failed: failed.data,
    located: located.data,
    mode,
    named: referenceIdsOf(parsed.data),
    note,
    reviewer: reviewerOf(parsed.data),
    stage,
  });

  if (!done.ok) {
    return done;
  }

  const { keys, status } = done.data;

  return ok(
    answer.data === "json"
      ? asJson("reject", stage, status)
      : [
          `${mode === "dry-run" ? "Próba na sucho: nic nie zapisano. " : ""}Odrzucono ${keys.join(", ")} (${stage}, ${located.data.where}): ${note}`,
          ...(failed.data === null ? [] : [`  niezaliczone: ${failed.data.join(", ")}`]),
          `Dalej: popraw z tą uwagą: ${located.data.regenerate(keys)}`,
        ].join("\n")
  );
}

/** The no itself: which artifacts, whether `--fail` fits them, the write, the stage's answer after. */
async function writeRejection(input: {
  readonly failed: readonly Check[] | null;
  readonly located: Located;
  readonly mode: "apply" | "dry-run";
  readonly named: readonly string[];
  readonly note: string;
  readonly reviewer: string;
  readonly stage: string;
}): Promise<Result<{ readonly keys: readonly string[]; readonly status: object }>> {
  const { located } = input;
  const file = await readJson(located.file, stageFileSchema);

  if (!file.ok) {
    return err(
      new NothingToRejectError(
        `nie ma czego odrzucić: etap ${input.stage} nie ma tu jeszcze wyników`
      )
    );
  }

  const keys = input.named.length > 0 ? input.named : Object.keys(file.data.artifacts);
  const failures = failedFor(located, keys, input.failed);

  if (!failures.ok) {
    return failures;
  }

  const rejected = rejectArtifacts(file.data, keys, {
    failed: failures.data,
    note: input.note,
    reviewer: input.reviewer,
  });

  if (!rejected.ok) {
    return rejected;
  }

  const written = await applyWrites(
    [{ kind: "text", text: serialize(rejected.data), to: located.file }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const status = await located.check();

  return status.ok ? ok({ keys, status: status.data }) : status;
}
