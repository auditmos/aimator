import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssemblyPanel } from "./assembly";
import { ProjectCast } from "./cast";
import { CharacterPanel } from "./character";
import { ClipsPanel } from "./clips";
import {
  defaultCell,
  EpisodeOverview,
  type HrefOf,
  Neighbours,
  Readiness,
  StageNav,
  stageName,
  stagesOf,
  Variants,
} from "./ladder";
import { MixPanel, NarrationPanel } from "./narration";
import { OpeningFramePanel } from "./opening-frame";
import { Commands, plural, RunDock, SettledStage } from "./panel";
import { NewEpisode, NewProject, PreparePanel } from "./prepare";
import { PromptPackagePanel } from "./prompt-package";
import { ReferencesPanel } from "./references";
import { ScreenplayPanel } from "./screenplay";
import { ShotListPanel } from "./shot-list";
import { MasterPanel, SoundDesignPanel } from "./sound-design";
import { ThemeSelect } from "./theme";
import type {
  EpisodeStatus,
  ListedProject,
  Refusal,
  RunDone,
  StatusCell,
  WorkspaceListing,
} from "./types";

/**
 * The screen, and the order a person meets it in.
 *
 * Every level asks one question with two answers. The start screen asks for a
 * new project or an existing one; a project asks for a new episode or an
 * existing one; only an episode shows its ladder and the panels beside it.
 * The earlier screen opened on all of it at once and read as a dashboard
 * nobody had asked for yet.
 *
 * Every answer is still a command. The listing is `list`, the ladder is
 * `status`, and both arrive on streams that re-ask whenever the workspace
 * moves, so a window open here and an agent working in a terminal cannot drift
 * apart.
 *
 * The one state this client owns is **whether what it shows is current**. An
 * event stream that drops does not make the last ladder wrong, only old, so it
 * stays on the screen and says so; a tool that blanked itself would be hiding
 * the answer a person is in the middle of reading, and one that kept pretending
 * would be worse. That is § 9 of the design manual: a network failure never
 * masquerades as a fresh result.
 */

type Connection = "live" | "opening" | "stale";

/**
 * What the pending identifier holds between a click and the server's reply.
 *
 * No run ever carries it, so "still running" (the pending identifier against
 * the last answer's) holds from the click on, and the real identifier replaces
 * it the moment the server hands one back.
 */
const SENDING = "sending";

/**
 * Where finished commands are read from, which depends on what is open.
 *
 * The workspace stream is open on every screen and carries every answer. An
 * episode's stream carries them too, each one behind the ladder it changed,
 * so while an episode is open its stream `claim`s the answers and hands them
 * over with `done`, and the workspace stream stays quiet about them.
 */
interface Runs {
  readonly claim: (claimed: boolean) => void;
  readonly done: (run: RunDone) => void;
}

const CONNECTION_NOTE: Record<Connection, string | null> = {
  live: null,
  opening: "Czytam stan odcinka…",
  stale: "Brak połączenia z serwerem. Poniżej ostatni znany stan, nieaktualny.",
};

/**
 * Where the screen is, written in the address.
 *
 * In the hash rather than in state, so that a reload lands where it was, the
 * browser's back button goes back, and an address can be pasted. The bare
 * address is the start screen.
 */
type Route =
  | { readonly kind: "home" }
  | { readonly kind: "new" }
  | { readonly kind: "open" }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "cast"; readonly projectId: string }
  | { readonly kind: "new-episode"; readonly projectId: string }
  | { readonly kind: "episodes"; readonly projectId: string }
  | {
      readonly episodeId: string;
      readonly kind: "episode";
      /**
       * Which stage, or which one cell of it, is open: `7`, `7/seedream`,
       * `2/ewa/gpt-image`. The cell id `status` gives, so nothing translates
       * it. Absent on the episode's overview.
       */
      readonly place: string | null;
      readonly projectId: string;
    };

/** Every screen that is about one project, which is every screen past the start. */
type InProject = Extract<Route, { readonly projectId: string }>;

const HOME = "#/";
const NEW = "#/nowy";
const OPEN = "#/wczytaj";

function projectHref(projectId: string): string {
  return `#/projekt/${encodeURIComponent(projectId)}`;
}

function castHref(projectId: string): string {
  return `${projectHref(projectId)}/obsada`;
}

function newEpisodeHref(projectId: string): string {
  return `${projectHref(projectId)}/nowy-odcinek`;
}

function episodesHref(projectId: string): string {
  return `${projectHref(projectId)}/odcinki`;
}

function episodeHref(projectId: string, episodeId: string): string {
  return `${projectHref(projectId)}/odcinek/${encodeURIComponent(episodeId)}`;
}

/** One stage of an episode, or one cell of it, each segment of the cell id escaped. */
function stageHref(projectId: string, episodeId: string, place: string): string {
  const path = place.split("/").map(encodeURIComponent).join("/");

  return `${episodeHref(projectId, episodeId)}/etap/${path}`;
}

const LEADING_HASH = /^#/;

/** A segment as it was meant, or nothing when somebody typed a broken escape. */
function segment(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function routeOf(hash: string): Route {
  const [, first, second, third, fourth, fifth, ...rest] = hash
    .replace(LEADING_HASH, "")
    .split("/");

  if (first === "nowy") {
    return { kind: "new" };
  }

  if (first === "wczytaj") {
    return { kind: "open" };
  }

  const projectId = first === "projekt" ? segment(second) : null;

  if (projectId === null) {
    return { kind: "home" };
  }

  if (third === "obsada") {
    return { kind: "cast", projectId };
  }

  if (third === "nowy-odcinek") {
    return { kind: "new-episode", projectId };
  }

  if (third === "odcinki") {
    return { kind: "episodes", projectId };
  }

  const episodeId = third === "odcinek" ? segment(fourth) : null;

  if (episodeId === null) {
    return { kind: "project", projectId };
  }

  const parts = fifth === "etap" ? rest.map(segment) : [];
  // A broken escape anywhere in the cell id is no cell at all, and the
  // episode's overview is the honest place to land.
  const place = parts.length === 0 || parts.includes(null) ? null : parts.join("/");

  return { episodeId, kind: "episode", place, projectId };
}

function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const follow = (): void => setHash(window.location.hash);

    window.addEventListener("hashchange", follow);

    return () => window.removeEventListener("hashchange", follow);
  }, []);

  return routeOf(hash);
}

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/**
 * Which stage's panel the open cell gets, and nothing else.
 *
 * One `if` per stage rather than a lookup table, because a panel is a
 * component with its own props and a table of them would be a type that means
 * nothing. Stage 0 is not here: it is the one panel that has to exist before
 * there is a cell to open, so the episode screen places it itself.
 */
function StagePanel(props: PanelProps): JSX.Element | null {
  if (props.cell.stage === 1) {
    return <ScreenplayPanel {...props} />;
  }

  // Stage 2 is the one cell that is not about an episode: a character recurs
  // between them, so its panel is handed the character and the track its cell
  // carries and nothing else.
  if (props.cell.stage === 2) {
    return (
      <CharacterPanel
        cell={props.cell}
        onRun={props.onRun}
        projectId={props.projectId}
        run={props.run}
        running={props.running}
      />
    );
  }

  if (props.cell.stage === 3) {
    return <ShotListPanel {...props} />;
  }

  if (props.cell.stage === 4) {
    return <PromptPackagePanel {...props} />;
  }

  if (props.cell.stage === 5) {
    return <ReferencesPanel {...props} />;
  }

  if (props.cell.stage === 6) {
    return <OpeningFramePanel {...props} />;
  }

  if (props.cell.stage === 7) {
    return <ClipsPanel {...props} />;
  }

  if (props.cell.stage === 8) {
    return <AssemblyPanel {...props} />;
  }

  // Stage 9 is the first stage with two panels, because its artifacts live at
  // two levels: the words are shared by both tracks and the mix is not. The
  // cell's own track is what says which of the two questions this row is.
  if (props.cell.stage === 9) {
    return props.cell.track === null ? <NarrationPanel {...props} /> : <MixPanel {...props} />;
  }

  // Stage 10 splits the same way and for the same reason: the cue sheet and
  // the stems are bought once for both films, and only the full mix is timed
  // against a particular cut.
  if (props.cell.stage === 10) {
    return props.cell.track === null ? <SoundDesignPanel {...props} /> : <MasterPanel {...props} />;
  }

  return null;
}

/**
 * What the episode screen says about itself: the connection and a refusal.
 *
 * Both are the same kind of statement and neither is a result, which is why
 * they sit together and above everything that is one. § 9 of the design
 * manual is the rule they follow: a lost stream leaves the last ladder on
 * screen and says it is old.
 */
function Notices(props: {
  readonly connection: Connection;
  /** Suppressed where stage 0 is the whole screen: there is no ladder to be stale. */
  readonly ladderless: boolean;
  readonly refusal: string | null;
}): JSX.Element {
  const { connection, ladderless, refusal } = props;
  const note = CONNECTION_NOTE[connection];

  return (
    <>
      {note === null || ladderless ? null : (
        <p aria-live="polite" className={`connection connection-${connection}`}>
          {note}
        </p>
      )}
      {refusal === null ? null : (
        <p className="refusal" role="alert">
          {refusal}
        </p>
      )}
    </>
  );
}

/**
 * Two ways forward, and nothing else.
 *
 * The same pair at every level: something new, or something that exists.
 * They are links rather than buttons because each one goes somewhere, and a
 * place is what the address bar, the back button and a middle click are for.
 */
function Choices(props: {
  /** Something quieter than the two choices, under them and centred with them. */
  readonly children?: ReactNode;
  readonly label: string;
  readonly load: { readonly href: string; readonly label: string };
  readonly make: { readonly href: string; readonly label: string };
}): JSX.Element {
  const { children, label, load, make } = props;

  return (
    <div className="home">
      <div className="home-stack">
        <nav aria-label={label} className="home-choices">
          <a className="choice" href={make.href}>
            {make.label}
          </a>
          <a className="choice" href={load.href}>
            {load.label}
          </a>
        </nav>
        {children}
      </div>
    </div>
  );
}

/** The way back, one level up, said where the eye starts reading. */
function Back(props: { readonly href: string; readonly label: string }): JSX.Element {
  return (
    <a className="back" href={props.href}>
      ← {props.label}
    </a>
  );
}

/**
 * A list of things to open, each one a link.
 *
 * A list rather than a dropdown, because a dropdown hides the answer behind a
 * click and the screen it stands on has nothing else to show.
 */
function PickList(props: {
  readonly items: readonly {
    readonly href: string;
    readonly id: string;
    readonly meta?: ReactNode;
  }[];
}): JSX.Element {
  return (
    <ul className="pick-list">
      {props.items.map((one) => (
        <li key={one.id}>
          <a className="pick-link" href={one.href}>
            <span className="pick-id">{one.id}</span>
            {one.meta === undefined ? null : <span className="pick-meta">{one.meta}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The projects in the workspace. An empty one says so and offers the other choice. */
function OpenProject(props: {
  readonly listing: WorkspaceListing | null;
  readonly refusal: string | null;
}): JSX.Element {
  const { listing, refusal } = props;

  return (
    <section aria-labelledby="open-title">
      <Back href={HOME} label="Start" />
      <h1 id="open-title">Wczytaj projekt</h1>
      {refusal === null ? null : (
        <p className="refusal" role="alert">
          {refusal}
        </p>
      )}
      {listing === null && refusal === null ? (
        <p className="empty">Czytam katalog roboczy…</p>
      ) : null}
      {listing !== null && listing.projects.length === 0 ? (
        <p className="empty">
          Katalog roboczy nie ma jeszcze żadnego projektu. <a href={NEW}>Załóż nowy.</a>
        </p>
      ) : null}
      {listing === null || listing.projects.length === 0 ? null : (
        <PickList
          items={listing.projects.map((one) => ({
            href: projectHref(one.id),
            id: one.id,
            meta: plural(one.episodes.length, ["odcinek", "odcinki", "odcinków"]),
          }))}
        />
      )}
    </section>
  );
}

/**
 * Where each episode of a project stands, as `status` says, asked once.
 *
 * Once rather than on every workspace change: one `status` is seconds of
 * work, a project can hold several episodes, and this screen is a doorway
 * somebody passes through rather than one they watch. Each answer arrives on
 * its own, so a slow episode never holds back a quick one.
 */
function useReadiness(
  projectId: string,
  episodes: readonly string[]
): ReadonlyMap<string, EpisodeStatus | "refused"> {
  const [known, setKnown] = useState<ReadonlyMap<string, EpisodeStatus | "refused">>(new Map());
  const key = episodes.join("\n");

  useEffect(() => {
    let cancelled = false;

    setKnown(new Map());

    for (const episodeId of key === "" ? [] : key.split("\n")) {
      fetch(`/api/status/${encodeURIComponent(projectId)}/${encodeURIComponent(episodeId)}`)
        .then(async (response) => (await response.json()) as EpisodeStatus | Refusal)
        .then((body) => {
          if (!cancelled) {
            setKnown((current) =>
              new Map(current).set(episodeId, "error" in body ? "refused" : body)
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setKnown((current) => new Map(current).set(episodeId, "refused"));
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [key, projectId]);

  return known;
}

/** The episodes of one project, the same list one level down, each with where it stands. */
function OpenEpisode(props: { readonly project: ListedProject }): JSX.Element {
  const { project } = props;
  const readiness = useReadiness(project.id, project.episodes);

  return (
    <section aria-labelledby="episodes-title">
      <Back href={projectHref(project.id)} label={project.id} />
      <h1 id="episodes-title">Wczytaj odcinek</h1>
      {project.episodes.length === 0 ? (
        <p className="empty">
          Projekt {project.id} nie ma jeszcze odcinka.{" "}
          <a href={newEpisodeHref(project.id)}>Dodaj nowy.</a>
        </p>
      ) : (
        <PickList
          items={project.episodes.map((one) => ({
            href: episodeHref(project.id, one),
            id: one,
            meta: <Readiness status={readiness.get(one) ?? "loading"} />,
          }))}
        />
      )}
    </section>
  );
}

/**
 * One stage of the episode, and only that stage.
 *
 * It replaced a ladder of two dozen rows with a panel beside it, which asked a
 * person to read both at once. Here the strip at the top says where the
 * episode stands in eleven marks, the tabs under it choose a track or a
 * character when the stage has more than one, and the panel below is the whole
 * rest of the page. The address names the cell, so a reload, the back button
 * and a pasted link all land on the same tab.
 */
function StageScreen(props: {
  readonly episodeId: string;
  readonly hrefOf: HrefOf;
  readonly onRun: (argv: readonly string[]) => void;
  readonly place: string;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
  readonly status: EpisodeStatus;
}): JSX.Element {
  const { episodeId, hrefOf, onRun, place, projectId, run, running, status } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const stages = stagesOf(status);
  const number = Number(place.split("/")[0]);
  const stage = stages.find((one) => one.stage === number) ?? null;
  // The panel renders the cell the ladder is carrying right now, so a finished
  // command refreshes what the panel says without the panel asking anything.
  const cell =
    stage === null
      ? null
      : (stage.cells.find((one) => one.id === place) ??
        defaultCell(stage, status.next?.cell ?? null));

  // A new stage is a new page: the reader starts at its top, and a keyboard
  // and a screen reader start at its heading rather than on the link clicked.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [place]);

  if (stage === null || cell === null) {
    return (
      <p className="refusal" role="alert">
        Odcinek {episodeId} nie ma etapu {place}.
      </p>
    );
  }

  return (
    <>
      <StageNav current={stage.stage} hrefOf={hrefOf} stages={stages} />
      <h2 className="stage-title" id="stage-title" ref={heading} tabIndex={-1}>
        Etap {stage.stage}: {stageName(stage.stage)}
      </h2>
      <Variants current={cell.id} hrefOf={hrefOf} stage={stage} />
      {cell.reason === null ? null : <p className="stage-reason">{cell.reason}</p>}
      <Commands>
        <div className="stage-body">
          {/* An approved stage opens with every block folded: it is visited
              to look something up, and its titles are the table of contents. */}
          <SettledStage settled={cell.state === "approved"}>
            {cell.stage === 0 ? (
              <PreparePanel
                castHref={castHref(projectId)}
                cell={cell}
                episodeId={episodeId}
                onRun={onRun}
                projectId={projectId}
                run={run}
                running={running}
              />
            ) : (
              // Keyed by cell, so a tab starts with nothing ticked and nothing
              // previewed from the tab before it.
              <StagePanel
                cell={cell}
                episodeId={episodeId}
                key={cell.id}
                onRun={onRun}
                projectId={projectId}
                run={run}
                running={running}
              />
            )}
          </SettledStage>
        </div>
      </Commands>
      <Neighbours current={stage.stage} hrefOf={hrefOf} stages={stages} />
    </>
  );
}

/**
 * One episode, at the distance the address asks for.
 *
 * Without a stage it is the overview: the next step and eleven rows. With one
 * it is that stage's page. Both read one stream, opened once per episode, so
 * moving between stages re-asks nothing and loses no ladder.
 */
function EpisodeView(props: {
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly place: string | null;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
  readonly runs: Runs;
}): JSX.Element {
  const { episodeId, onRun, place, projectId, run, running, runs } = props;
  const [status, setStatus] = useState<EpisodeStatus | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("opening");
  const hrefOf = useCallback(
    (to: string) => stageHref(projectId, episodeId, to),
    [episodeId, projectId]
  );

  useEffect(() => {
    const events = new EventSource(
      `/api/events/${encodeURIComponent(projectId)}/${encodeURIComponent(episodeId)}`
    );

    events.addEventListener("status", (event) => {
      setStatus(JSON.parse(event.data) as EpisodeStatus);
      setRefusal(null);
      setConnection("live");
    });
    events.addEventListener("refusal", (event) => {
      setRefusal((JSON.parse(event.data) as Refusal).error.message);
      setConnection("live");
    });
    // While an episode is open, its answers are read here rather than off the
    // workspace stream: this one sends each answer behind the ladder it
    // changed, so "done" never stands beside the old state. The claim tells
    // the workspace stream to stop delivering, or each answer would arrive
    // twice, the first time too early.
    runs.claim(true);
    events.addEventListener("run", (event) => runs.done(JSON.parse(event.data) as RunDone));
    events.addEventListener("error", () => setConnection("stale"));

    return () => {
      runs.claim(false);
      events.close();
    };
  }, [episodeId, projectId, runs]);

  /**
   * A refused ladder leaves stage 0 on screen, because stage 0 is where the
   * things a ladder is refused over (a missing file, a broken decision) are
   * put right.
   */
  const ladderless = refusal !== null;
  const overview = place === null;

  return (
    <section aria-labelledby="episode-title">
      {overview ? (
        <Back href={episodesHref(projectId)} label="Odcinki" />
      ) : (
        <Back href={episodeHref(projectId, episodeId)} label={`Przegląd odcinka ${episodeId}`} />
      )}
      <h1 id="episode-title">
        <span className="title-context">{projectId} /</span> {episodeId}
      </h1>
      <Notices connection={connection} ladderless={ladderless} refusal={refusal} />
      {ladderless && overview ? (
        <Commands>
          <div className="stage-body">
            <PreparePanel
              castHref={castHref(projectId)}
              cell={null}
              episodeId={episodeId}
              onRun={onRun}
              projectId={projectId}
              run={run}
              running={running}
            />
          </div>
        </Commands>
      ) : null}
      {status !== null && overview && !ladderless ? (
        <EpisodeOverview hrefOf={hrefOf} status={status} />
      ) : null}
      {status !== null && place !== null ? (
        <StageScreen
          episodeId={episodeId}
          hrefOf={hrefOf}
          onRun={onRun}
          place={place}
          projectId={projectId}
          run={run}
          running={running}
          status={status}
        />
      ) : null}
    </section>
  );
}

/**
 * Every screen inside a project, once the project is known to exist.
 *
 * The address can name a project or an episode nobody has, by a typo or
 * because it was deleted in a terminal, so each is looked up in the listing
 * before any screen is built on it. A screen aimed at a directory nobody has
 * any more would spell commands the CLI can only refuse.
 */
function ProjectScreens(props: {
  readonly listing: WorkspaceListing | null;
  readonly listingRefusal: string | null;
  readonly onRun: (argv: readonly string[]) => void;
  readonly route: InProject;
  readonly run: RunDone | null;
  readonly running: boolean;
  readonly runs: Runs;
}): JSX.Element {
  const { listing, listingRefusal, onRun, route, run, running, runs } = props;
  const project = listing?.projects.find((one) => one.id === route.projectId) ?? null;
  const createdEpisode = useCallback(
    (episodeId: string) => {
      window.location.hash = episodeHref(route.projectId, episodeId);
    },
    [route.projectId]
  );

  if (listing === null) {
    return listingRefusal === null ? (
      <p className="empty">Czytam katalog roboczy…</p>
    ) : (
      <p className="refusal" role="alert">
        {listingRefusal}
      </p>
    );
  }

  if (project === null) {
    return (
      <section>
        <Back href={OPEN} label="Projekty" />
        <p className="refusal" role="alert">
          W katalogu roboczym nie ma projektu {route.projectId}.
        </p>
      </section>
    );
  }

  if (route.kind === "new-episode") {
    return (
      <>
        <Back href={projectHref(project.id)} label={project.id} />
        <NewEpisode
          episodes={project.episodes}
          onCreated={createdEpisode}
          onRun={onRun}
          projectId={project.id}
          run={run}
          running={running}
        />
      </>
    );
  }

  if (route.kind === "episodes") {
    return <OpenEpisode project={project} />;
  }

  if (route.kind === "cast") {
    return (
      <section aria-labelledby="cast-title">
        <Back href={projectHref(project.id)} label={project.id} />
        <h1 id="cast-title">Obsada i narrator</h1>
        <ProjectCast
          onRun={onRun}
          projectId={project.id}
          revision={listing}
          run={run}
          running={running}
        />
      </section>
    );
  }

  if (route.kind === "episode") {
    return project.episodes.includes(route.episodeId) ? (
      // Keyed by episode, so moving between two of them starts the second
      // with nothing left over from the first: no open panel, no old ladder.
      <EpisodeView
        episodeId={route.episodeId}
        key={route.episodeId}
        onRun={onRun}
        place={route.place}
        projectId={project.id}
        run={run}
        running={running}
        runs={runs}
      />
    ) : (
      <section>
        <Back href={episodesHref(project.id)} label="Odcinki" />
        <p className="refusal" role="alert">
          W projekcie {project.id} nie ma odcinka {route.episodeId}.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="project-title">
      <Back href={OPEN} label="Projekty" />
      <h1 id="project-title">{project.id}</h1>
      <Choices
        label="Odcinek"
        load={{ href: episodesHref(project.id), label: "Wczytaj odcinek" }}
        make={{ href: newEpisodeHref(project.id), label: "Nowy odcinek" }}
      >
        {/* Quieter than the two choices: the cast is set once and revisited
            rarely, while an episode is what a visit is for. */}
        <p className="home-aside">
          <a href={castHref(project.id)}>Obsada i narrator</a>
        </p>
      </Choices>
    </section>
  );
}

export function App(): JSX.Element {
  const route = useRoute();
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [listingRefusal, setListingRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [run, setRun] = useState<RunDone | null>(null);
  /** Whether an open episode's stream is the one delivering answers. */
  const episodeClaims = useRef<boolean>(false);
  const runs = useMemo<Runs>(
    () => ({
      claim: (claimed) => {
        episodeClaims.current = claimed;
      },
      done: setRun,
    }),
    []
  );
  /** The argv of the last command started here, which the answer does not repeat. */
  const [sent, setSent] = useState<readonly string[] | null>(null);

  /**
   * The workspace's own stream, open on every screen.
   *
   * It carries the listing, re-read whenever something under the workspace
   * moves, so a project or an episode created here or by an agent in a
   * terminal shows up without a reload. And it carries every finished command,
   * which is the reason it exists at all: a project and an episode are both
   * created before there is an episode whose stream could deliver the answer.
   */
  useEffect(() => {
    const events = new EventSource("/api/events");

    events.addEventListener("listing", (event) => {
      setListing(JSON.parse(event.data) as WorkspaceListing);
      setListingRefusal(null);
    });
    events.addEventListener("refusal", (event) => {
      setListingRefusal((JSON.parse(event.data) as Refusal).error.message);
    });
    // A command started here finishes here, whatever else the screen is doing
    // meanwhile. An identifier this window did not start is somebody else's.
    // An open episode reads its answers off its own stream instead; see Runs.
    events.addEventListener("run", (event) => {
      if (!episodeClaims.current) {
        setRun(JSON.parse(event.data) as RunDone);
      }
    });
    events.addEventListener("error", () =>
      setListingRefusal("Serwer nie odpowiada. Uruchom go poleceniem pnpm ui.")
    );

    return () => events.close();
  }, []);

  /**
   * One click, one command, and nothing waited for.
   *
   * The answer is an identifier; what the command said arrives on the stream,
   * because a clip is bought by a call that polls for minutes and the screen
   * has to stay usable while it does.
   */
  const start = useCallback((argv: readonly string[]) => {
    const refused = (message: string, name: string): void => {
      setPending(null);
      setRun({ error: { message, name }, ok: false, runId: "" });
    };

    setSent(argv);
    setRun(null);
    // "W toku" from the click, not from the server's reply: a server busy
    // re-reading the ladder can take seconds to hand back an identifier, and a
    // click with nothing to show for it meanwhile looks like one that missed.
    setPending(SENDING);

    fetch("/api/run", {
      body: JSON.stringify({ argv }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => (await response.json()) as { runId?: string } & Partial<Refusal>)
      .then((body) => {
        if (body.runId === undefined) {
          refused(
            body.error?.message ?? "Serwer nie przyjął komendy.",
            body.error?.name ?? "Error"
          );
        } else {
          setPending(body.runId);
        }
      })
      .catch(() => refused("Serwer nie przyjął komendy.", "NetworkError"));
  }, []);
  const createdProject = useCallback((projectId: string) => {
    window.location.hash = projectHref(projectId);
  }, []);

  /**
   * A command's answer belongs to the screen that started it.
   *
   * Leaving that screen forgets it, so the next one does not open with a
   * result nobody on it asked for. It is adjusted while rendering rather than
   * in an effect, so no frame ever shows the old answer on the new screen.
   *
   * Both halves go together, the answer and the identifier waiting for it,
   * because "w toku" is derived from the pair: clearing the answer alone made
   * a finished command look like one still in flight and disabled every button
   * on the stage just opened. A stage and each of its tabs is a screen of its
   * own, so moving between them clears it too.
   */
  const routeKey = JSON.stringify(route);
  const [shownRoute, setShownRoute] = useState(routeKey);

  if (shownRoute !== routeKey) {
    setShownRoute(routeKey);
    setRun(null);
    setPending(null);
  }

  /**
   * Still running, derived rather than remembered.
   *
   * A `check` finishes in milliseconds, so its result can reach the stream
   * before the request that started it has answered with the identifier. A
   * flag cleared by the event would then be set again afterwards and never
   * cleared, leaving "w toku" under a result that is already on screen. The
   * identifier the result carries is the proof, so the two are compared.
   */
  const running = pending !== null && run?.runId !== pending;

  return (
    <>
      <a className="skip-link" href="#main">
        Przejdź do treści
      </a>
      <header className="app-header">
        <div className="header-inner wrap">
          <a aria-label="aimator: start" className="brand" href={HOME}>
            <img
              alt="Auditmos"
              className="logo logo-dark"
              height="134"
              src="/auditmos-wordmark-cyan-transparent.svg"
              width="738"
            />
            <img
              alt="Auditmos"
              className="logo logo-light"
              height="134"
              src="/auditmos-wordmark-black-transparent.svg"
              width="738"
            />
            <span className="product">aimator</span>
          </a>
          <ThemeSelect />
        </div>
      </header>
      <main className="wrap" id="main">
        {route.kind === "home" ? (
          <section aria-labelledby="home-title">
            <h1 className="sr-only" id="home-title">
              aimator
            </h1>
            <Choices
              label="Od czego zacząć"
              load={{ href: OPEN, label: "Wczytaj projekt" }}
              make={{ href: NEW, label: "Nowy projekt" }}
            />
          </section>
        ) : null}
        {route.kind === "new" ? (
          <>
            <Back href={HOME} label="Start" />
            <NewProject onCreated={createdProject} onRun={start} run={run} running={running} />
          </>
        ) : null}
        {route.kind === "open" ? <OpenProject listing={listing} refusal={listingRefusal} /> : null}
        {"projectId" in route ? (
          <ProjectScreens
            listing={listing}
            listingRefusal={listingRefusal}
            onRun={start}
            route={route}
            run={run}
            running={running}
            runs={runs}
          />
        ) : null}
      </main>
      {/* One place for every answer, on every screen: see RunDock. */}
      <RunDock argv={sent} run={run} running={running} />
    </>
  );
}
