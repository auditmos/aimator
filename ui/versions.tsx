import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  Block,
  Checklist,
  Drift,
  Notices,
  PaidCall,
  PickAll,
  PickBox,
  type Priced,
  Problems,
  pickable,
  QC_LEGEND,
  Reject,
  Said,
  type Unit,
  useChecklist,
} from "./panel";
import type {
  ClipFace,
  ClipVersion,
  FacesReport,
  FinalFilm,
  FinalReport,
  LipSyncReport,
  RunDone,
  StatusCell,
  VersionsStatus,
} from "./types";

/**
 * Stage 12: the cast's mouths moved to the language of the mouths, on one
 * track, clip by clip, and the track's two films laid from them.
 *
 * It is stage 7's panel with a person's decision between two purchases, and
 * four things are its own.
 *
 * **A face is bound by looking.** The face call finds faces and the provider
 * numbers them; which one is Ewa is never inferred, not even with one face on
 * screen. So each clip shows the faces found, each with its picture and when
 * it is on screen, and asks of each who it is. The answer is written at once
 * (`versions bind`), because it is a decision rather than a purchase.
 *
 * **Two purchases behind one block.** The face call takes one clip per call;
 * the lip-sync takes whichever clips are chosen, or every clip the gates
 * allow. One paid block with a choice, for stage 11's reason: "Kup" is derived
 * from the last preview. A clip's own "Rozpoznaj twarze" fills that block in
 * for the clip and runs the free preview, so the click that spends is still
 * "Kup" under a bill somebody has read.
 *
 * **Watched twice.** A version is judged against the clip it was made from,
 * so the accepted clip of stage 7 stands above its version.
 *
 * **Two films, bought from nobody.** One picture is cut once from the clips,
 * and each language's lines are laid over it beside the same stems: stage 8's
 * reading, one button and a free dry run that shows the plan, no bill. Each
 * film is its own judgement, so its yes and no stand in its own card, and the
 * one whose mouths moved is accepted against the film's checklist.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The two things stage 12 buys, each counted in its own word and never added up. */
const FACE_CALLS: Unit = ["rozpoznanie twarzy", "rozpoznania twarzy", "rozpoznań twarzy"];
const JOBS: Unit = ["zadanie lip-sync", "zadania lip-sync", "zadań lip-sync"];

/** What the state of a clip's version means, in the word a person reads. */
const CLIP_STATE: Record<ClipVersion["state"], string> = {
  absent: "wersji jeszcze nie ma",
  completed: "gotowa, czeka na ocenę",
  submitted: "próba przerwana",
};

/** A job's state as the preview names it, in Polish; anything else is shown as it came. */
const JOB_STATE: Readonly<Record<string, string>> = {
  completed: "już kupione",
  planned: "do kupienia",
  resumable: "do odebrania bez drugiej opłaty",
};

/**
 * Stage 12's reading of its own report, which is one of two purchases.
 *
 * A face call is billed in face calls. A lip-sync is billed in face calls
 * **and** jobs, counted apart, because a second speaker in a clip costs a
 * face call on the first job's result beside its own job. What a lip-sync
 * would send is no prompt but a plan: who, which face and which window, so the
 * jobs stand where a text stage's prompt would.
 */
export function asVersions(report: FacesReport | LipSyncReport): Priced {
  if (!("paidLipSyncs" in report)) {
    return { billed: [{ count: report.paidCalls, unit: FACE_CALLS }], prompts: [] };
  }

  const jobs = report.clips.flatMap((clip) =>
    clip.jobs.map(
      (job) =>
        `${job.key}: ${job.cast}, twarz ${job.face}, od ${job.start} ms do ${job.end} ms, ${job.lines.join(", ")}, ${JOB_STATE[job.state] ?? job.state}`
    )
  );

  return {
    billed: [
      { count: report.paidFaces, unit: FACE_CALLS },
      { count: report.paidLipSyncs, unit: JOBS },
    ],
    prompts:
      jobs.length === 0
        ? []
        : [{ label: "Zadania: postać, twarz, okno w ms, kwestie", text: jobs.join("\n") }],
  };
}

/** What the paid block buys this time; see the file's comment. */
type Purchase = "faces" | "lip-sync";

interface PurchaseForm {
  /** A person's own choice of what to buy; null follows `suggested`. */
  readonly choice: Purchase | null;
  /** The clip whose faces are found; empty follows `faceClipOf`. */
  readonly clip: string;
  readonly regenerate: boolean;
}

const NO_FORM: PurchaseForm = { choice: null, clip: "", regenerate: false };

/** Faces first, while any clip has none found; then the lip-sync. Only a default. */
function suggested(clips: readonly ClipVersion[]): Purchase {
  return clips.some((clip) => clip.faces === null) ? "faces" : "lip-sync";
}

/** The clip a face call is about: the one chosen, or the first with no faces found. */
function faceClipOf(form: PurchaseForm, clips: readonly ClipVersion[]): string {
  if (clips.some((clip) => clip.id === form.clip)) {
    return form.clip;
  }

  return (clips.find((clip) => clip.faces === null) ?? clips[0])?.id ?? "";
}

/**
 * A face's picture, asked for in the format `check` named it by.
 *
 * The format is the provider's choice and the stage wrote it down; reading it
 * off the path is reading that record, not learning the layout, which is why
 * the extension is all that is taken from it.
 */
function faceArtifact(clip: string, face: ClipFace): string | null {
  const format = face.image?.split(".").at(-1) ?? null;

  return format === null ? null : `face:${clip}:${face.id}.${format}`;
}

/** Who each face is, as chosen on screen before it is written; face id to character. */
type Draft = Readonly<Record<string, string>>;

/**
 * The faces of one clip, each with its picture, its interval and a choice of
 * who it is, and the one command that writes the choice down.
 *
 * The choice starts from what was written last and is remounted whenever
 * that, or the faces themselves, change, so a form never offers a binding of
 * faces a new face call has replaced.
 */
function Faces(props: {
  readonly clip: ClipVersion;
  readonly faces: readonly ClipFace[];
  readonly onRun: (argv: readonly string[]) => void;
  readonly running: boolean;
  readonly scope: {
    readonly episodeId: string;
    readonly projectId: string;
    readonly track: string;
  };
  readonly urlOf: (artifact: string) => string;
}): JSX.Element {
  const { clip, faces, onRun, running, scope, urlOf } = props;
  const [draft, setDraft] = useState<Draft>(clip.binding ?? {});
  const chosen = useMemo(
    () => Object.fromEntries(Object.entries(draft).filter(([, cast]) => cast !== "")),
    [draft]
  );
  const bind = useMemo(
    () => INTENTS.bindFaces({ ...scope, artifact: clip.id, faces: chosen }),
    [chosen, clip.id, scope]
  );
  const faceless = clip.speakers.filter((cast) => !Object.values(chosen).includes(cast));

  return (
    <>
      <ul className="faces">
        {faces.map((face) => (
          <Face
            clip={clip.id}
            face={face}
            key={face.id}
            onCast={setDraft}
            speakers={clip.speakers}
            url={urlOf}
            who={draft[face.id] ?? ""}
          />
        ))}
      </ul>
      <p className="picture-state">
        Zapisane:{" "}
        {clip.binding === null
          ? "nic"
          : Object.entries(clip.binding)
              .map(([face, cast]) => `twarz ${face} = ${cast}`)
              .join(", ")}
        {faceless.length > 0 ? ` · bez twarzy: ${faceless.join(", ")}` : ""}
      </p>
      <Action
        argv={bind}
        disabled={running || Object.keys(chosen).length === 0}
        label="Zapisz przypisanie"
        onRun={onRun}
      />
    </>
  );
}

/** One face: its picture, when it is on screen, and who a person says it is. */
function Face(props: {
  readonly clip: string;
  readonly face: ClipFace;
  readonly onCast: (change: (draft: Draft) => Draft) => void;
  readonly speakers: readonly string[];
  readonly url: (artifact: string) => string;
  readonly who: string;
}): JSX.Element {
  const { clip, face, onCast, speakers, who } = props;
  const id = `face-${clip}-${face.id}`;
  const artifact = faceArtifact(clip, face);
  const change = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const cast = event.target.value;

      onCast((draft) => ({ ...draft, [face.id]: cast }));
    },
    [face.id, onCast]
  );

  return (
    <li className="face">
      {artifact === null ? (
        <p className="picture-empty">bez obrazka</p>
      ) : (
        // biome-ignore lint/correctness/useImageSize: obrazek twarzy ma rozmiar, który wybrał dostawca
        <img alt={`twarz ${face.id} w ${clip}`} loading="lazy" src={props.url(artifact)} />
      )}
      <p className="picture-state">
        twarz {face.id} · od {face.start} ms do {face.end} ms
      </p>
      <div className="field">
        <label htmlFor={id}>Kto to?</label>
        <select id={id} onChange={change} value={who}>
          <option value="">nie mówi</option>
          {speakers.map((cast) => (
            <option key={cast} value={cast}>
              {cast}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

/** One clip whose mouths move: the clip, its faces, its version, and its box. */
function Clip(props: {
  readonly chosen: boolean;
  readonly clip: ClipVersion;
  readonly onFind: (argv: readonly string[], clip: string, again: boolean) => void;
  readonly onRun: (argv: readonly string[]) => void;
  readonly onToggle: (id: string, wanted: boolean) => void;
  readonly running: boolean;
  readonly scope: {
    readonly episodeId: string;
    readonly projectId: string;
    readonly track: string;
  };
  readonly unlocked: boolean;
  readonly urlOf: (stage: "clips" | "versions", artifact: string, revision: string) => string;
}): JSX.Element {
  const { chosen, clip, onFind, onRun, onToggle, running, scope, unlocked, urlOf } = props;
  // A new job on a clip in review leaves the cell where it was, so the clip's
  // note, which names its attempt, is part of the version's revision; a new
  // face call clears the binding, so that is part of the faces'.
  const faceRevision = `${clip.note}:${JSON.stringify(clip.binding)}`;
  const again = clip.faces !== null;
  const find = useMemo(
    () => INTENTS.previewFaces({ ...scope, artifact: clip.id, regenerate: again }),
    [again, clip.id, scope]
  );
  const startFind = useCallback(
    (argv: readonly string[]) => onFind(argv, clip.id, again),
    [again, clip.id, onFind]
  );
  const faceUrl = useCallback(
    (artifact: string) => urlOf("versions", artifact, faceRevision),
    [faceRevision, urlOf]
  );

  return (
    <li className={clip.approved ? "link picture-approved" : "link"}>
      <PickBox
        approved={clip.approved}
        boxId={`version-${clip.id}`}
        chosen={chosen}
        id={clip.id}
        onToggle={onToggle}
        unlocked={unlocked}
      />
      <p className="picture-name">Mówią w kadrze: {clip.speakers.join(", ")}</p>

      <p className="picture-state">Przyjęty klip z etapu 7</p>
      {/* biome-ignore lint/a11y/useMediaCaption: klip jest niemy, mowę dokłada ten etap */}
      <video className="link-film" controls preload="metadata" src={urlOf("clips", clip.id, "")} />

      <p className="picture-state">Twarze</p>
      {clip.faces === null ? (
        <p className="picture-empty">jeszcze nie rozpoznane</p>
      ) : (
        <Faces
          clip={clip}
          faces={clip.faces}
          key={`${JSON.stringify(clip.binding)}:${clip.faces.map((face) => face.id).join(",")}`}
          onRun={onRun}
          running={running}
          scope={scope}
          urlOf={faceUrl}
        />
      )}
      <Action
        argv={find}
        disabled={running}
        label={again ? "Rozpoznaj twarze ponownie" : "Rozpoznaj twarze"}
        onRun={startFind}
      />

      {/* Until there is a version, the state line below is all there is to say. */}
      {clip.state === "completed" ? (
        <>
          <p className="picture-state">Wersja</p>
          {/* biome-ignore lint/a11y/useMediaCaption: kwestie ma skrypt etapu 11, a napisy to decyzja odcinka */}
          <video
            className="link-film"
            controls
            preload="metadata"
            src={urlOf("versions", clip.id, clip.note)}
          />
        </>
      ) : null}
      <p className="picture-state">
        {clip.approved ? "zatwierdzona" : CLIP_STATE[clip.state]} · {clip.note}
      </p>
    </li>
  );
}

/** What the paid block is told: which purchase, which clip for a face call, a new attempt. */
function PurchaseFields(props: {
  readonly clips: readonly ClipVersion[];
  readonly faceClip: string;
  readonly form: PurchaseForm;
  readonly onForm: (change: (form: PurchaseForm) => PurchaseForm) => void;
  readonly purchase: Purchase;
}): JSX.Element {
  const { clips, faceClip, form, onForm, purchase } = props;
  const choose = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const choice = event.target.value as Purchase;

      onForm((current) => ({ ...current, choice }));
    },
    [onForm]
  );
  const pick = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const clip = event.target.value;

      onForm((current) => ({ ...current, clip }));
    },
    [onForm]
  );
  const changeAgain = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const regenerate = event.target.checked;

      onForm((current) => ({ ...current, regenerate }));
    },
    [onForm]
  );

  return (
    <div className="send">
      <div className="field">
        <label htmlFor="versions-purchase">Co kupić</label>
        <select id="versions-purchase" onChange={choose} value={purchase}>
          <option value="faces">rozpoznanie twarzy w jednym klipie</option>
          <option value="lip-sync">lip-sync zaznaczonych klipów</option>
        </select>
      </div>
      {purchase === "faces" ? (
        <div className="field">
          <label htmlFor="versions-face-clip">Klip</label>
          <select id="versions-face-clip" onChange={pick} value={faceClip}>
            {clips.map((clip) => (
              <option key={clip.id} value={clip.id}>
                {clip.id}
                {clip.faces === null ? "" : " (twarze już rozpoznane)"}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <label className="field-check" htmlFor="versions-regenerate">
        <input
          checked={form.regenerate}
          id="versions-regenerate"
          onChange={changeAgain}
          type="checkbox"
        />
        {purchase === "faces"
          ? "Nowa płatna próba: twarze tego klipu jeszcze raz (cofa przypisanie)"
          : "Nowa płatna próba zaznaczonych klipów"}
      </label>
    </div>
  );
}

/** What the state of a film means, in the word a person reads. */
const FILM_STATE: Record<FinalFilm["state"], string> = {
  absent: "jeszcze nie złożony",
  completed: "gotowy, czeka na ocenę",
};

/**
 * What `versions final` did, or would do. `skipped` is a film already laid,
 * which only a new attempt lays again, a rejected one included.
 */
const PLAN_STATE: Record<FinalReport["state"], string> = {
  blocked: "zablokowany",
  planned: "do złożenia",
  published: "złożony",
  skipped: "już złożony, ponownie tylko jako nowa próba",
};

/** Where one clip of the picture came from. */
const PICTURE_SOURCE: Record<FinalReport["picture"][number]["source"], string> = {
  clips: "przyjęty klip etapu 7",
  "lip-sync": "po lip-syncu",
};

/** What one sound of a film is. */
const SOUND_KIND: Record<FinalReport["sounds"][number]["kind"], string> = {
  effect: "efekt",
  music: "muzyka",
  speech: "mowa",
};

/**
 * Whether a film's `approve` would take it, read off its own state.
 *
 * Laid, not yet accepted, and laid from what is on disk now: `approve`
 * refuses a film whose inputs moved, because the remedy there is laying it
 * again, so a yes offered beside one would only lead to a refusal.
 */
export function acceptableFilm(film: FinalFilm): boolean {
  return film.state === "completed" && !film.approved && film.inputsChanged.length === 0;
}

/**
 * What a film is laid from, as its report said: each clip of the picture with
 * where it came from, and each sound with the second of the film it lands at
 * beside the second the plan gave it. A translation, never a computation.
 */
export function asFilm(report: FinalReport): {
  readonly picture: readonly string[];
  readonly sounds: readonly string[];
} {
  return {
    picture: report.picture.map((clip) => `${clip.id} · ${PICTURE_SOURCE[clip.source]}`),
    sounds: report.sounds.map(
      (sound) =>
        `${sound.id} · ${SOUND_KIND[sound.kind]} · od ${sound.atSeconds}s (plan ${sound.plannedSeconds}s) · ${sound.seconds}s`
    ),
  };
}

/** What the free block is told: which film, whether to write it, a new attempt. */
interface FilmForm {
  readonly dryRun: boolean;
  /** The film's language; empty follows `filmLanguageOf`. */
  readonly language: string;
  readonly regenerate: boolean;
}

const NO_FILM: FilmForm = { dryRun: true, language: "", regenerate: false };

/** The film the block is about: the one chosen, or the first not yet laid. Only a default. */
function filmLanguageOf(form: FilmForm, finals: readonly FinalFilm[]): string {
  if (finals.some((film) => film.id === form.language)) {
    return form.language;
  }

  return (finals.find((film) => film.state === "absent") ?? finals[0])?.id ?? "";
}

/**
 * One finished film: the film itself, and its own yes and no.
 *
 * Each film is its own judgement, so its decision stands in its card rather
 * than under a choice of several. The one whose mouths moved is accepted
 * against the film's checklist, ticked afresh for every film laid; the other
 * has none to tick.
 */
function FilmCard(props: {
  readonly film: FinalFilm;
  readonly onRun: (argv: readonly string[]) => void;
  readonly run: RunDone | null;
  readonly running: boolean;
  readonly scope: {
    readonly episodeId: string;
    readonly projectId: string;
    readonly track: string;
  };
  readonly urlOf: (stage: "clips" | "versions", artifact: string, revision: string) => string;
}): JSX.Element {
  const { film, onRun, run, running, scope, urlOf } = props;
  const mouths = film.checks.length > 0;
  const { complete, setTicked, ticked } = useChecklist(film.checks, film.note);
  const approve = useMemo(
    () => INTENTS.approveFilm({ ...scope, artifact: film.id, checks: ticked }),
    [film.id, scope, ticked]
  );
  const rejection = useCallback(
    (note: string) => INTENTS.rejectVersions({ ...scope, artifacts: [film.id], note }),
    [film.id, scope]
  );

  return (
    <li className={film.approved ? "link picture-approved" : "link"}>
      <p className="picture-name">
        FINAL {film.id.toUpperCase()} ·{" "}
        {mouths
          ? "język ust: kwestie, do których ruszono usta"
          : "język filmu: dubbing, usta mówią drugim językiem"}
      </p>

      {/* Until the film is laid, the state line below is all there is to say. */}
      {film.state === "completed" ? (
        // biome-ignore lint/a11y/useMediaCaption: kwestie ma skrypt etapu 11, a napisy to decyzja odcinka
        <video
          className="link-film"
          controls
          preload="metadata"
          src={urlOf("versions", film.id, film.note)}
        />
      ) : null}
      <p className="picture-state">
        {film.approved ? "zatwierdzony" : FILM_STATE[film.state]} · {film.note}
      </p>
      <Drift paths={film.inputsChanged} title="Wejścia zmieniły się po złożeniu filmu:" />

      {acceptableFilm(film) ? (
        <>
          {mouths ? (
            <Checklist
              id={`film-${film.id}-checks`}
              legend={QC_LEGEND}
              onTick={setTicked}
              required={film.checks}
              ticked={ticked}
            />
          ) : null}
          <Action
            argv={approve}
            disabled={running || !complete}
            label="Zatwierdź"
            onRun={onRun}
            primary
          />
          <Reject
            again="Złożenie filmu nie czyta powodu: zostaje on w ocenie i na drabinie, a nowy film składa „Złóż film” z „Ponownym złożeniem”. Jeśli powód leży w kwestii albo w klipie, popraw najpierw je."
            argvOf={rejection}
            criteria={[]}
            id={`film-${film.id}-reject`}
            onRun={onRun}
            run={run}
            running={running}
          />
        </>
      ) : null}
    </li>
  );
}

/** What one film is laid from, as the last `versions final` reported it. */
function FilmPlan(props: { readonly plan: FinalReport }): JSX.Element {
  const { plan } = props;
  const read = asFilm(plan);

  return (
    <>
      <dl className="verdict">
        <div>
          <dt>Film</dt>
          <dd>
            {plan.language} · {PLAN_STATE[plan.state]}
          </dd>
        </div>
        <div>
          <dt>Silnik</dt>
          <dd>{plan.engine ?? "nieustalony"}</dd>
        </div>
        <div>
          <dt>Obraz</dt>
          <dd>{plan.actualSeconds}s</dd>
        </div>
        <div>
          <dt>Dalej</dt>
          <dd>
            <Said text={plan.nextStep} />
          </dd>
        </div>
      </dl>
      <p className="picture-state">Obraz, klipy w kolejności planu</p>
      <ul className="cut">
        {read.picture.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="picture-state">Dźwięki: sekunda filmu, w nawiasie sekunda planu, długość</p>
      <ul className="cut">
        {read.sounds.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Problems problems={plan.problems} />
      <Notices notices={plan.notices} />
    </>
  );
}

/** What the free block is told: which film, a dry run or not, a new attempt. */
function FilmFields(props: {
  readonly finals: readonly FinalFilm[];
  readonly form: FilmForm;
  readonly language: string;
  readonly onForm: (change: (form: FilmForm) => FilmForm) => void;
}): JSX.Element {
  const { finals, form, language, onForm } = props;
  const pick = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const chosen = event.target.value;

      onForm((current) => ({ ...current, language: chosen }));
    },
    [onForm]
  );
  const changeDryRun = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const dryRun = event.target.checked;

      onForm((current) => ({ ...current, dryRun }));
    },
    [onForm]
  );
  const changeAgain = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const regenerate = event.target.checked;

      onForm((current) => ({ ...current, regenerate }));
    },
    [onForm]
  );

  return (
    <div className="send">
      <div className="field">
        <label htmlFor="versions-film-language">Film</label>
        <select id="versions-film-language" onChange={pick} value={language}>
          {finals.map((film) => (
            <option key={film.id} value={film.id}>
              {film.id}
              {film.checks.length > 0 ? " (język ust)" : " (język filmu)"}
              {film.state === "completed" ? ", już złożony" : ""}
            </option>
          ))}
        </select>
      </div>
      <label className="field-check" htmlFor="versions-film-dry-run">
        <input
          checked={form.dryRun}
          id="versions-film-dry-run"
          onChange={changeDryRun}
          type="checkbox"
        />
        Próba na sucho: pokaż, z czego powstanie film, nie zapisuj niczego
      </label>
      <label className="field-check" htmlFor="versions-film-regenerate">
        <input
          checked={form.regenerate}
          id="versions-film-regenerate"
          onChange={changeAgain}
          type="checkbox"
        />
        Ponowne złożenie gotowego filmu, zachowując poprzedni w archiwum próby
      </label>
    </div>
  );
}

export function VersionsPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as VersionsStatus | null;
  const track = cell.track ?? "";
  const clips = useMemo(() => status?.clips ?? [], [status]);
  const finals = useMemo(() => status?.finals ?? [], [status]);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [form, setForm] = useState<PurchaseForm>(NO_FORM);
  const [filmForm, setFilmForm] = useState<FilmForm>(NO_FILM);
  const [plan, setPlan] = useState<FinalReport | null>(null);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const [reveal, setReveal] = useState(0);
  const language = filmLanguageOf(filmForm, finals);
  const purchase = form.choice ?? suggested(clips);
  const faceClip = faceClipOf(form, clips);
  // An accepted version stays ticked and locked unless a new lip-sync is what
  // it is being chosen for.
  const unlocked = purchase === "lip-sync" && form.regenerate;
  const selected = useMemo(() => pickable(clips, chosen, unlocked), [chosen, clips, unlocked]);
  const scope = useMemo(() => ({ episodeId, projectId, track }), [episodeId, projectId, track]);
  const check = useMemo(() => INTENTS.checkVersions(scope), [scope]);
  const approve = useMemo(
    () => INTENTS.approveVersions({ ...scope, artifacts: selected }),
    [scope, selected]
  );
  const rejection = useCallback(
    (note: string) => INTENTS.rejectVersions({ ...scope, artifacts: selected, note }),
    [scope, selected]
  );
  const preview = useMemo(
    () =>
      purchase === "faces"
        ? INTENTS.previewFaces({ ...scope, artifact: faceClip, regenerate: form.regenerate })
        : INTENTS.previewLipSync({ ...scope, artifacts: selected, regenerate: form.regenerate }),
    [faceClip, form.regenerate, purchase, scope, selected]
  );
  const lay = useMemo(
    () =>
      INTENTS.makeFilm({
        ...scope,
        dryRun: filmForm.dryRun,
        language,
        regenerate: filmForm.regenerate,
      }),
    [filmForm.dryRun, filmForm.regenerate, language, scope]
  );
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  // A clip's own "Rozpoznaj twarze": the paid block set to that clip, opened,
  // and its free preview run, so what spends is still "Kup" under the bill.
  const find = useCallback(
    (argv: readonly string[], clip: string, again: boolean) => {
      setForm({ choice: "faces", clip, regenerate: again });
      setReveal((count) => count + 1);
      startRun(argv);
    },
    [startRun]
  );
  const toggle = useCallback((id: string, wanted: boolean) => {
    setChosen((current) => (wanted ? [...current, id] : current.filter((one) => one !== id)));
  }, []);
  const urlOf = useCallback(
    (stage: "clips" | "versions", artifact: string, revision: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage, track })}&v=${encodeURIComponent(`${cell.state}:${revision}`)}`,
    [cell.state, episodeId, projectId, track]
  );

  /**
   * The film the last `versions final` answered with, dry or laid.
   *
   * Both report the same picture and the same sounds, so both are read; any
   * other command leaves nothing here, because none of them carries a film.
   */
  useEffect(() => {
    if (sent === null || !(sent[1] === "final" && run?.ok === true)) {
      setPlan(null);

      return;
    }

    try {
      setPlan(JSON.parse(run.data) as FinalReport);
    } catch {
      setPlan(null);
    }
  }, [run, sent]);

  useEffect(() => {
    setChosen([]);
    setForm(NO_FORM);
    setFilmForm(NO_FILM);
    setSent(null);
  }, [episodeId, track]);

  const picked = clips.filter((clip) => selected.includes(clip.id));
  const acceptable =
    picked.length > 0 && picked.every((clip) => clip.state === "completed" && !clip.approved);
  const drifted = [...new Set(clips.flatMap((clip) => clip.inputsChanged))];

  return (
    <section aria-labelledby="versions-title" className="panel">
      <h2 id="versions-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <Block title="Stan">
            <dl className="verdict">
              <div>
                <dt>Tor zatwierdzony w całości</dt>
                <dd>{status.approved ? "tak" : "nie"}</dd>
              </div>
              <div>
                <dt>Bez zmian</dt>
                <dd>
                  {status.untouched.length === 0 ? "żaden klip" : status.untouched.join(", ")}
                </dd>
              </div>
              <div>
                <dt>Dalej</dt>
                <dd>
                  <Said text={status.nextStep} />
                </dd>
              </div>
            </dl>

            <Problems problems={status.problems} />
            <Notices notices={status.notices} />
            <Drift paths={drifted} title="Wejścia zmieniły się po lip-syncu:" />
          </Block>

          <Block
            hint={
              <>
                Lip-syncu potrzebuje klip, w którym postać widoczna w ujęciu mówi kwestię przekładu;
                klip bez takiej postaci przechodzi do wersji <strong>bez zmian</strong>. Kolejność
                jest taka, jak w terminalu: rozpoznaj twarze (płatne), powiedz, kto jest kim (zapis
                decyzji, bez płacenia), kup lip-sync, obejrzyj wersję obok klipu, z którego
                powstała, i zatwierdź. Przypisanie jest zawsze jawne, także przy jednej twarzy.
                Zaznaczenie kilku klipów daje jedną komendę z listą <code>--artifact</code>.
              </>
            }
            title="Klipy z mową w kadrze"
          >
            {clips.length === 0 ? (
              <p className="picture-empty">Żaden klip tego toru nie potrzebuje lip-syncu.</p>
            ) : (
              <>
                <PickAll
                  chosen={selected}
                  id="versions-all"
                  items={clips}
                  onChoose={setChosen}
                  unlocked={unlocked}
                />
                <ul className="reel">
                  {clips.map((clip) => (
                    <Clip
                      chosen={selected.includes(clip.id)}
                      clip={clip}
                      key={clip.id}
                      onFind={find}
                      onRun={startRun}
                      onToggle={toggle}
                      running={running}
                      scope={scope}
                      unlocked={unlocked}
                      urlOf={urlOf}
                    />
                  ))}
                </ul>
              </>
            )}
          </Block>

          <Block
            hint={
              <>
                Dwa filmy tego toru, oba <strong>bez płacenia</strong>: jeden obraz, sklejony raz z
                klipów po lip-syncu i przyjętych klipów etapu 7, a na nim kwestie jednego języka
                przy tej samej muzyce i tych samych efektach etapu 10. Film w języku ust ocenia się
                z checklistą QC, bo to w nim ruszono usta; film w języku filmu to klasyczny dubbing
                i przyjmuje się go bez listy. Zmiana obrazu, któregoś klipu, kwestii, stemu albo{" "}
                <code>mix.json</code> cofa zgodę na film, a lekarstwem jest złożenie go od nowa, nie
                druga zgoda.
              </>
            }
            title="Filmy wersji"
          >
            {finals.length === 0 ? (
              <p className="picture-empty">
                Filmy czekają, aż etap ruszy na tym torze; stan wyżej mówi dlaczego.
              </p>
            ) : (
              <ul className="reel">
                {finals.map((film) => (
                  <FilmCard
                    film={film}
                    key={film.id}
                    onRun={startRun}
                    run={run}
                    running={running}
                    scope={scope}
                    urlOf={urlOf}
                  />
                ))}
              </ul>
            )}
          </Block>
        </>
      )}

      <Block className="block-decision" title="Decyzja">
        <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

        {acceptable ? (
          <>
            <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
            <Reject
              again="Lip-sync nie czyta powodu: zostaje on w ocenie i na drabinie, a nowa próba (lip-sync z „Nową płatną próbą”) kupuje zadanie od nowa. Jeśli chodzi o to, kto jest kim, najpierw popraw przypisanie twarzy w karcie klipu."
              argvOf={rejection}
              criteria={[]}
              id="versions-reject"
              onRun={startRun}
              run={run}
              running={running}
            />
          </>
        ) : (
          <p className="actions-note">
            Zaznacz klipy, których wersja istnieje i czeka na przyjęcie, żeby je zatwierdzić albo
            odrzucić; kilka zaznaczonych to jedna komenda. Tak samo odmówiłby terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Dwa zakupy w jednym bloku, a pole „Co kupić” mówi który. Rozpoznanie twarzy to jedno płatne wywołanie Kling na jeden klip; drugie na tym samym klipie to druga opłata, więc idzie tylko jako nowa próba i cofa przypisanie. Lip-sync to jedno zadanie Kling na każdą postać mówiącą w kadrze, a druga postać w klipie kosztuje jeszcze jedno rozpoznanie na wyniku pierwszego zadania, więc rachunek podaje rozpoznania i zadania osobno. Bez zaznaczenia lip-sync obejmuje każdy klip, na który pozwalają bramki, a terminal odmawia zakupu, dopóki któryś ze wskazanych czeka; zaznacz gotowe, żeby kupić tylko je. Klip, którego Kling nie zna po identyfikatorze, jest pożyczany z prywatnego bucketu R2 i zabierany po wywołaniu. „Generuj” niczego nie wysyła i nie czyta kluczy; dopiero „Kup” płaci."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asVersions}
        reveal={reveal}
        running={running}
        sent={sent}
      >
        <PurchaseFields
          clips={clips}
          faceClip={faceClip}
          form={form}
          onForm={setForm}
          purchase={purchase}
        />
      </PaidCall>

      {finals.length === 0 ? null : (
        <Block
          fold={finals.some((film) => film.state === "absent")}
          hint={
            <>
              Złożenie filmu <strong>niczego nie kupuje</strong>, jak montaż etapu 8: nie ma tu
              rachunku ani przycisku „Kup”, jest jeden przycisk. Potrzebny jest <code>ffmpeg</code>{" "}
              na tej maszynie (PATH albo <code>AIMATOR_FFMPEG</code>). Obraz składa się raz i służy
              obu filmom; ponownie składa się tylko wtedy, gdy zmienił się któryś jego klip. Próba
              na sucho pokazuje klipy obrazu ze źródłem każdego i każdy dźwięk z sekundą filmu obok
              sekundy planu, a dwie wypowiedzi naraz albo wypowiedź za końcem filmu są odmową, nigdy
              przesunięciem.
            </>
          }
          title="Złożenie filmu (bez płacenia)"
        >
          <FilmFields finals={finals} form={filmForm} language={language} onForm={setFilmForm} />

          <Action
            argv={lay}
            disabled={running}
            label={filmForm.dryRun ? "Pokaż plan filmu" : "Złóż film"}
            onRun={startRun}
            primary={!filmForm.dryRun}
          />

          {plan === null ? (
            <p className="actions-note">
              Plan pokazuje „Pokaż plan filmu”. To wywołanie jest darmowe i przy próbie na sucho nie
              zapisuje niczego.
            </p>
          ) : (
            <FilmPlan plan={plan} />
          )}
        </Block>
      )}
    </section>
  );
}
