import {
  applyWrites,
  readJson,
  rejectArtifacts,
  serialize,
  stageFileSchema,
} from "../lib/artifact/index.js";
import { checkAssembly } from "../lib/assembly/index.js";
import { checkCharacter } from "../lib/character/index.js";
import { type Check, FRAME_CHECKS } from "../lib/checklist.js";
import { checkClips } from "../lib/clips/index.js";
import { checkDialogue } from "../lib/dialogue/index.js";
import { checkMix, checkNarration } from "../lib/narration/index.js";
import { checkOpeningFrame } from "../lib/opening-frame/index.js";
import { checkPromptPackage } from "../lib/prompt-package/index.js";
import { checkReferences } from "../lib/references/index.js";
import { err, ok, type Result } from "../lib/result.js";
import { checkScreenplay } from "../lib/screenplay/index.js";
import { checkShotList } from "../lib/shot-list/index.js";
import { checkMaster, checkSoundDesign } from "../lib/sound-design/index.js";
import { checkStyle } from "../lib/style/index.js";
import { checkVersions } from "../lib/versions/index.js";
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
    jak niezatwierdzony; approve może go potem przyjąć. --fail tylko tam, gdzie
    zgoda idzie z checklistą QC, i tylko z jej kryteriów: klatki (opening-frame,
    entry:Cnn) i film w języku ust (versions). --regenerate odrzuconego
    artefaktu bez --instruction poprawia go według tej uwagi. W soundtrack
    i sound-design bez --track, dialogue i versions --artifact jest wymagane,
    jak w approve; versions odrzuca klip wersji (C01) i gotowy film (en), nie
    twarze, kroki pośrednie ani wspólny obraz.`;

/** A stage that has produced nothing here yet: there is no result to say no to. */
class NothingToRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToRejectError";
  }
}

/** Where a no has to name what it refuses, as a yes there does: the keys it may name. */
interface Named {
  /** What `--artifact` takes here, in the words a refusal prints. */
  readonly allowed: string;
  readonly takes: (key: string) => boolean;
}

/** Where one stage's rejection is written, and what it prints afterwards. */
interface Located {
  /** The stage's own object after the write, what `--json` prints. */
  readonly check: () => Promise<Result<object>>;
  /** The QC checklist a key's yes is given against, the only criteria `--fail` fits; empty where none. */
  readonly checklist: (key: string) => Promise<readonly Check[]>;
  /** The stage file the rejection is written into. */
  readonly file: string;
  /** Set where one file holds artifacts of several kinds, so "every one" is nobody's decision. */
  readonly named?: Named;
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

const NO_CHECKLIST = async (): Promise<readonly Check[]> => [];

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
  readonly named?: Named;
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
      checklist: NO_CHECKLIST,
      file: spec.file(episode.data.paths),
      ...(spec.named === undefined ? {} : { named: spec.named }),
      regenerate: (keys) => spec.regenerate(on, keys),
      where: `odcinek ${on.episodeId}`,
    });
  };
}

type TrackOn = EpisodeOn & { readonly track: ImageTrack };

/** A stage whose file lives once per episode per track. */
function trackStage(spec: {
  readonly check: (on: TrackOn) => Promise<Result<object>>;
  readonly checklist?: (on: TrackOn, key: string) => Promise<readonly Check[]>;
  readonly file: (paths: EpisodeTrackPaths) => string;
  readonly named?: Named;
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
      checklist: (key) => (spec.checklist ?? NO_CHECKLIST)(on, key),
      file: spec.file(episodeTrackPaths(episode.data.paths, track.data)),
      ...(spec.named === undefined ? {} : { named: spec.named }),
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

/** A clip of stage 12, `C01`: one of the two keys there a no may name. */
const CLIP_VERSION = /^C\d{2,}$/;

/** A finished film of stage 12, keyed by its language: `en`, `pt-BR`. */
const FILM = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * A film's checklist as the stage answers it: the film whose mouths moved has
 * one and the other none, which `check` already derives, so it is read there
 * rather than decided twice. A clip's version is accepted against none.
 */
async function filmChecklist(on: TrackOn, key: string): Promise<readonly Check[]> {
  if (CLIP_VERSION.test(key)) {
    return [];
  }

  const status = await checkVersions(on);

  return status.ok ? (status.data.finals.find((film) => film.id === key)?.checks ?? []) : [];
}

/**
 * Stage 12's keys, each sent back to what makes it: a clip's version is a new
 * lip-sync job, and a film is laid again over the picture, one per language.
 */
function versionsAgain(on: TrackOn, keys: readonly string[]): string {
  const scope = `${on.projectId} ${on.episodeId} --track ${on.track}`;
  const clips = keys.filter((key) => CLIP_VERSION.test(key));
  const films = keys.filter((key) => !CLIP_VERSION.test(key));

  return [
    ...(clips.length > 0
      ? [`aimator versions lip-sync ${scope} --regenerate ${artifactFlag(clips)}`]
      : []),
    ...films.map(
      (language) => `aimator versions final ${scope} --language ${language} --regenerate`
    ),
  ].join("; ");
}

/**
 * Stage 11's keys, each sent back to the command that buys it again: the
 * script is lifted, a translation is translated, and lines are spoken in
 * their own language, one command per language.
 */
function dialogueAgain(on: EpisodeOn, keys: readonly string[]): string {
  const scope = `${on.projectId} ${on.episodeId}`;
  const commands: string[] = [];
  const lines = new Map<string, string[]>();

  for (const key of keys) {
    if (key === "script") {
      commands.push(`aimator dialogue generate ${scope} --regenerate --artifact script`);
    } else if (key.startsWith("script-")) {
      commands.push(`aimator dialogue translate ${scope} --regenerate`);
    } else {
      const language = key.includes(":") ? (key.split(":")[0] ?? "") : "";

      lines.set(language, [...(lines.get(language) ?? []), key]);
    }
  }

  for (const [language, ids] of lines) {
    const spoken = language === "" ? "" : ` --language ${language}`;

    commands.push(`aimator dialogue generate ${scope}${spoken} --regenerate ${artifactFlag(ids)}`);
  }

  return commands.join("; ");
}

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
      checklist: NO_CHECKLIST,
      file: characterTrackPaths(paths.data, track.data).stage,
      regenerate: (keys) =>
        `aimator character generate ${on.projectId} ${on.characterId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
      where: `postać ${on.characterId}, tor ${on.track}`,
    });
  },
  clips: trackStage({
    check: checkClips,
    checklist: async (_on, key) => (key.startsWith("entry:") ? FRAME_CHECKS : []),
    file: (paths) => paths.clipsStage,
    regenerate: (on, keys) =>
      `aimator clip generate ${on.projectId} ${on.episodeId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
  }),
  dialogue: episodeStage({
    check: checkDialogue,
    file: (paths) => paths.dialogueStage,
    named: { allowed: "script, script-<kod>, D01[,D02] albo <kod>:D01", takes: () => true },
    regenerate: dialogueAgain,
  }),
  "opening-frame": trackStage({
    check: checkOpeningFrame,
    checklist: async () => FRAME_CHECKS,
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
      named: { allowed: "cues albo M01[,E02]", takes: () => true },
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
      named: { allowed: "script albo N01[,N02]", takes: () => true },
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
      checklist: NO_CHECKLIST,
      file: styleTrackPaths(project.data, track.data).stage,
      regenerate: (keys) =>
        `aimator style generate ${on.projectId} --track ${on.track} --regenerate ${artifactFlag(keys)}`,
      where: `projekt, tor ${on.track}`,
    });
  },
  versions: trackStage({
    check: checkVersions,
    checklist: filmChecklist,
    file: (paths) => paths.versionsStage,
    // What a person watches is all they reject here: a clip's version and a
    // finished film. `faces:C01` is what the provider found, `C01:ewa` a step
    // with one face moved and not the next, and the picture under both films
    // (`episode`) is a silent cut nobody watches, remade whenever a clip is.
    named: {
      allowed: "C01[,C02] (wersja klipu) albo <kod> (film w tym języku)",
      takes: (key) => CLIP_VERSION.test(key) || FILM.test(key),
    },
    regenerate: versionsAgain,
  }),
};

/** The keys a no is about, where it has to name them: at least one, each of a kind it may name. */
function namedFor(located: Located, keys: readonly string[], stage: string): Result<null> {
  const { named } = located;

  if (named === undefined) {
    return ok(null);
  }

  if (keys.length === 0) {
    return err(
      new UsageError(
        `--artifact jest wymagane: ${named.allowed}; "nie" o wszystkim naraz to decyzja, której nikt nie podjął`
      )
    );
  }

  const foreign = keys.filter((key) => !named.takes(key));

  return foreign.length > 0
    ? err(
        new UsageError(
          `nie da się odrzucić ${foreign.join(", ")} w --stage ${stage}: --artifact przyjmuje ${named.allowed}`
        )
      )
    : ok(null);
}

/** `--fail` only where a checklist was the yes it stands in for, and only from that checklist. */
async function failedFor(
  located: Located,
  keys: readonly string[],
  failed: readonly Check[] | null
): Promise<Result<Readonly<Record<string, readonly Check[]>>>> {
  if (failed === null) {
    return ok({});
  }

  const lists = await Promise.all(
    keys.map(async (key) => ({ checks: await located.checklist(key), key }))
  );
  const plain = lists.filter((one) => one.checks.length === 0).map((one) => one.key);
  const foreign = lists.flatMap(({ checks, key }) => {
    const outside = failed.filter((check) => !checks.includes(check));

    return checks.length > 0 && outside.length > 0
      ? [`${outside.join(", ")} nie ma w checkliście ${key} (${checks.join(", ")})`]
      : [];
  });

  if (plain.length > 0) {
    return err(
      new UsageError(
        `--fail dotyczy tylko artefaktów z checklistą QC (opening-frame, entry:Cnn, film w języku ust), a ${plain.join(", ")} jej nie ma`
      )
    );
  }

  return foreign.length > 0
    ? err(new UsageError(`--fail spoza checklisty: ${foreign.join("; ")}`))
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
 * exactly one wherever `approve` does not ask for the flag either; where it
 * does, so does this.
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
  const named = namedFor(located, input.named, input.stage);

  if (!named.ok) {
    return named;
  }

  const file = await readJson(located.file, stageFileSchema);

  if (!file.ok) {
    return err(
      new NothingToRejectError(
        `nie ma czego odrzucić: etap ${input.stage} nie ma tu jeszcze wyników`
      )
    );
  }

  const keys = input.named.length > 0 ? input.named : Object.keys(file.data.artifacts);
  const failures = await failedFor(located, keys, input.failed);

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
