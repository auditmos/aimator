import { emptyStage, readJson, type StageFile, stageFileSchema } from "../artifact/index.js";
import { frameSize } from "../image-model/index.js";
import { readStage0Style, type Stage0Style } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type ImageTrack,
  projectPaths,
  type StyleTrackPaths,
  styleTrackPaths,
  type Workspace,
} from "../workspace.js";
import { styleIds } from "./prompt.js";

/**
 * Internal to the style module: what generating style frames reads, and whether
 * it may pay.
 *
 * Everything comes from stage 0 through its entry: the decision, the count, the
 * frame and the rules. What is this module's own is the track's stage file and
 * the gate, which is stage 0 accepted and a Style Bible with nothing left to
 * answer, because these images are drawn from that block and nothing else.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "style";

export interface StyleScope {
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class StyleBlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `obrazy stylu nie mogą wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "StyleBlockedError";
    this.problems = problems;
  }
}

/**
 * A project whose style frames are not generated: nothing here to draw, check
 * or approve. Its own class rather than a blocked payment, because `check` and
 * `approve` meet it too, and neither was about to pay.
 */
class StyleBasisError extends Error {
  readonly basis: string | null;

  constructor(projectId: string, basis: string | null) {
    super(
      `podstawa obrazów stylu projektu "${projectId}" to ${basis ?? "nierozstrzygnięta"}, a generuje się je tylko przy: aimator project style ${projectId} --generated --count <1-4>`
    );
    this.name = "StyleBasisError";
    this.basis = basis;
  }
}

export interface StyleInputs {
  /** The frames the decision names, `S01` to `Snn`, in order. */
  readonly ids: readonly string[];
  readonly paths: StyleTrackPaths;
  /** The film frame, the same one stages 5 and 6 draw in. */
  readonly size: string;
  /** This track's own stage file, empty when it has drawn nothing yet. */
  readonly stage: StageFile;
  readonly stage0: Stage0Style;
}

/**
 * Everything a run or a check reads. A project whose style frames are not
 * generated has nothing here to draw, and is told which decision would.
 */
export async function readStyleInputs(input: StyleScope): Promise<Result<StyleInputs>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const stage0 = await readStage0Style(input);

  if (!stage0.ok) {
    return stage0;
  }

  const { aspectRatio, basis, count } = stage0.data;

  if (basis !== "generated" || count === null) {
    return err(new StyleBasisError(input.projectId, basis));
  }

  if (aspectRatio === null) {
    return err(new StyleBlockedError(["project.json: aspectRatio nie jest ustalony"]));
  }

  const size = frameSize(aspectRatio);

  if (!size.ok) {
    return size;
  }

  const paths = styleTrackPaths(project.data, input.track);
  const stage = await readJson(paths.stage, stageFileSchema);

  return ok({
    ids: styleIds(count),
    paths,
    size: size.data,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
    stage0: stage0.data,
  });
}

/** Why nothing may be drawn at all: stage 0 unaccepted, or a Style Bible unanswered. */
export function gate(input: StyleScope, inputs: StyleInputs): readonly string[] {
  const { approved, problems, styleBible } = inputs.stage0;

  return [
    ...styleBible,
    ...(approved
      ? []
      : [
          ...problems,
          `etap 0 musi mieć review.status = "approved" zanim obrazy stylu wydadzą pieniądze: aimator approve ${input.projectId}`,
        ]),
  ];
}
