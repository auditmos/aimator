import {
  type ChangeEvent,
  type JSX,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AssemblyPanel } from "./assembly";
import { CharacterPanel } from "./character";
import { ClipsPanel } from "./clips";
import { Ladder } from "./ladder";
import { MixPanel, NarrationPanel } from "./narration";
import { OpeningFramePanel } from "./opening-frame";
import { plural } from "./panel";
import { NewProject, PreparePanel } from "./prepare";
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
 * It opens on exactly two choices, a new project or an existing one, because
 * those are the only two questions anybody arriving here can answer. Everything
 * else (the episode, the ladder, a stage's panel) is about a project, so it
 * waits until there is one. The earlier screen opened on all of it at once and
 * read as a dashboard nobody had asked for yet.
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
 * address is the start screen, which is the whole of what a person asked to
 * see when they open this tool.
 */
type Route =
  | { readonly kind: "home" }
  | { readonly kind: "new" }
  | { readonly kind: "open" }
  | { readonly kind: "project"; readonly projectId: string };

const HOME = "#/";
const NEW = "#/nowy";
const OPEN = "#/wczytaj";

function projectHref(projectId: string): string {
  return `#/projekt/${encodeURIComponent(projectId)}`;
}

const LEADING_HASH = /^#/;

function routeOf(hash: string): Route {
  const [, first, second] = hash.replace(LEADING_HASH, "").split("/");

  if (first === "nowy") {
    return { kind: "new" };
  }

  if (first === "wczytaj") {
    return { kind: "open" };
  }

  if (first === "projekt" && second !== undefined && second !== "") {
    return { kind: "project", projectId: decodeURIComponent(second) };
  }

  return { kind: "home" };
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

/**
 * Which cells can be opened today.
 *
 * One stage, one slice: the rest are driven from the terminal until theirs
 * arrives. A row nobody can open says so by being a row, which is more honest
 * than a panel apologising for being empty.
 */
const PANELLED = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function openable(cell: StatusCell): boolean {
  return PANELLED.has(cell.stage);
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
 * there is a cell to open.
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
 * What the project screen says about itself: the connection, a refusal, a
 * project with nothing in it yet.
 *
 * All three are the same kind of statement and none of them is a result, which
 * is why they sit together and above everything that is one. § 9 of the design
 * manual is the rule they follow: a lost stream leaves the last ladder on
 * screen and says it is old, and an empty project says so plainly rather than
 * looking like a tool that failed to load.
 */
function Notices(props: {
  readonly connection: Connection;
  /** Suppressed where stage 0 is the whole screen: there is no ladder to be stale. */
  readonly ladderless: boolean;
  readonly project: ListedProject;
  readonly refusal: string | null;
}): JSX.Element {
  const { connection, ladderless, project, refusal } = props;
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
      {project.episodes.length === 0 ? (
        <p className="empty">Projekt {project.id} nie ma jeszcze odcinka.</p>
      ) : null}
    </>
  );
}

/**
 * A panel that opened somewhere a person is not looking has not opened.
 *
 * The two-column layout answers this for a wide window: the panel stands
 * beside the row that was clicked and is in view already, so `nearest` moves
 * nothing. A narrow window stacks, and there the panel lands below the whole
 * ladder, which is the arrangement this replaces: a click whose result is
 * off-screen. The panel takes focus either way, because a keyboard and a
 * screen reader are in exactly the position a scrolled-past panel leaves the
 * eye in. An anchor overrides both: it names a form inside the panel, and the
 * point of naming it is to put it at the top.
 */
function useReveal(props: {
  readonly anchor: string | null;
  readonly opened: string | null;
  readonly panel: RefObject<HTMLDivElement | null>;
  readonly showing: boolean;
}): void {
  const { anchor, opened, panel, showing } = props;

  useEffect(() => {
    // A stage-0 panel standing in for a project with no episode opened
    // itself; there was no click, so nothing has moved and nothing should be
    // moved to.
    if (!showing || (opened === null && anchor === null)) {
      return;
    }

    const wide = window.matchMedia("(min-width: 64rem)").matches;
    const part = anchor === null ? null : document.getElementById(anchor);

    (part ?? panel.current)?.scrollIntoView({
      behavior: "smooth",
      block: wide && part === null ? "nearest" : "start",
    });
    panel.current?.focus({ preventScroll: true });
  }, [anchor, opened, panel, showing]);
}

/**
 * The ladder and the panel of the row somebody opened, side by side.
 *
 * They are one component because they are one answer: a click on a row and
 * the thing that click produced. Under them the panel used to be rendered
 * after the whole ladder, so opening a cell near the top of a twenty-row
 * episode put the result below the fold with nothing on screen saying
 * anything had happened. A wide window now puts the two in columns and keeps
 * the panel in view while the ladder scrolls; a narrow one stacks them and
 * the client scrolls to the panel instead.
 *
 * Stage 0 is the exception that shapes the rest: it has a panel and may have
 * no ladder at all, so the grid drops to one column rather than leaving an
 * empty half beside a form.
 */
function Workbench(props: {
  readonly anchor: string | null;
  readonly cell: StatusCell | null;
  readonly episodeId: string | null;
  readonly onClose: () => void;
  readonly onOpen: (id: string) => void;
  readonly onRun: (argv: readonly string[]) => void;
  readonly opened: string | null;
  readonly preparing: boolean;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
  readonly status: EpisodeStatus | null;
}): JSX.Element {
  const { anchor, cell, episodeId, onClose, onOpen, onRun, opened, preparing, status } = props;
  const { projectId, run, running } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const showing = preparing || cell !== null;

  useReveal({ anchor, opened, panel: panelRef, showing });

  return (
    <div className={status !== null && showing ? "workbench workbench-split" : "workbench"}>
      {status === null ? null : (
        <div className="workbench-ladder">
          <Ladder onOpen={onOpen} openable={openable} opened={opened} status={status} />
        </div>
      )}
      {showing ? (
        // `tabIndex` because opening a cell moves focus here: the panel is the
        // answer to that click, and a keyboard has to land in it.
        <div className="workbench-panel" ref={panelRef} tabIndex={-1}>
          {opened === null ? null : (
            <div className="panel-bar">
              <button className="panel-close" onClick={onClose} type="button">
                Zamknij panel
              </button>
            </div>
          )}
          {preparing ? (
            <PreparePanel
              cell={cell}
              episodeId={episodeId}
              onRun={onRun}
              projectId={projectId}
              run={run}
              running={running}
            />
          ) : null}
          {cell === null || episodeId === null ? null : (
            <StagePanel
              cell={cell}
              episodeId={episodeId}
              onRun={onRun}
              projectId={projectId}
              run={run}
              running={running}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The start screen: two choices and nothing else.
 *
 * They are links rather than buttons because each one goes somewhere, and a
 * place is what the address bar, the back button and a middle click are for.
 */
function Home(): JSX.Element {
  return (
    <section aria-labelledby="home-title" className="home">
      <h1 className="sr-only" id="home-title">
        aimator
      </h1>
      <nav aria-label="Od czego zacząć" className="home-choices">
        <a className="choice" href={NEW}>
          Nowy projekt
        </a>
        <a className="choice" href={OPEN}>
          Wczytaj projekt
        </a>
      </nav>
    </section>
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
 * The projects in the workspace, each one a way in.
 *
 * A list of links rather than a dropdown, because a dropdown hides the answer
 * behind a click and this screen has nothing else to show. An empty workspace
 * says so and offers the other choice, rather than a list that is simply blank.
 */
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
        <ul className="project-list">
          {listing.projects.map((one) => (
            <li key={one.id}>
              <a className="project-link" href={projectHref(one.id)}>
                <span className="project-id">{one.id}</span>
                <span className="project-meta">
                  {plural(one.episodes.length, ["odcinek", "odcinki", "odcinków"])}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Which episode of the open project is being shown, and the way to a new one.
 *
 * The project is no longer chosen here: it was chosen on the way in, and the
 * address says which one it is. What is left is the episode, and "+ Nowy
 * odcinek" beside it, which opens stage 0 at the episode form.
 */
function EpisodePicker(props: {
  readonly episodeId: string | null;
  readonly onEpisode: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly onNewEpisode: () => void;
  readonly project: ListedProject;
}): JSX.Element {
  const { episodeId, onEpisode, onNewEpisode, project } = props;

  return (
    <div className="picker">
      <div className="field">
        <label htmlFor="episode">Odcinek</label>
        <select
          disabled={project.episodes.length === 0}
          id="episode"
          onChange={onEpisode}
          value={episodeId ?? ""}
        >
          {project.episodes.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </div>
      <button className="action" onClick={onNewEpisode} type="button">
        + Nowy odcinek
      </button>
    </div>
  );
}

/** The episode on screen: the one picked, if this project has it, else its first. */
function shownEpisode(project: ListedProject | null, picked: string | null): string | null {
  if (project === null) {
    return null;
  }

  return picked !== null && project.episodes.includes(picked)
    ? picked
    : (project.episodes[0] ?? null);
}

/**
 * One project: its episodes, the ladder of the chosen one, and the panel open
 * beside it.
 *
 * This is the screen that used to be the whole application. It is unchanged in
 * what it answers; what changed is that it is now reached, rather than being
 * where everybody lands.
 */
function ProjectView(props: {
  readonly listing: WorkspaceListing | null;
  readonly onRun: (argv: readonly string[]) => void;
  readonly onRunCleared: () => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { listing, onRun, onRunCleared, projectId, run, running } = props;
  const project = listing?.projects.find((one) => one.id === projectId) ?? null;
  /**
   * The episode somebody picked, which is a preference rather than a fact.
   *
   * What is shown is derived from it and from the listing, so an episode that
   * is not in this project (a stale pick, a project just created) falls back
   * to the first one in the same render rather than one effect later, which
   * would have opened a stream for an episode the project does not have.
   */
  const [picked, setPicked] = useState<string | null>(null);
  const episodeId = shownEpisode(project, picked);
  const [status, setStatus] = useState<EpisodeStatus | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("opening");
  const [opened, setOpened] = useState<string | null>(null);
  /**
   * Which part of the open panel a person was asking for, when they asked for
   * a part of it. "+ Nowy odcinek" opens the stage-0 panel scrolled to the
   * episode form; a panel opened from the ladder has no such part and leaves
   * this null.
   */
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (episodeId === null) {
      setStatus(null);

      return;
    }

    setStatus(null);
    setRefusal(null);
    setConnection("opening");

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
    // Finished commands are read off the workspace stream, which is open on
    // every screen; this one carries them too, and reading both would be
    // hearing each answer twice.
    events.addEventListener("error", () => setConnection("stale"));

    return () => events.close();
  }, [episodeId, projectId]);

  /**
   * Opening a cell forgets the last command, **both halves of it**.
   *
   * `run` alone is half a fact. What "w toku" is derived from is the pair: an
   * identifier this window is waiting for, and the answer that has not come
   * back under it yet. Clearing the answer and keeping the identifier made
   * every finished command look like one still in flight, which disabled every
   * button in the panel just opened, and there is no way out of that: starting
   * a command is what clears it, and the buttons that start one are the
   * disabled ones. Two states, one fact, cleared together, by the one owner of
   * both.
   *
   * Nothing is lost while a real command is running: the result arrives on the
   * stream whatever is open, and the cell itself says "w toku" off the stage's
   * own lock file, which is the only progress this server claims to know.
   */
  const openCell = useCallback(
    (id: string) => {
      onRunCleared();
      setAnchor(null);
      setOpened((current) => (current === id ? null : id));
    },
    [onRunCleared]
  );
  const close = useCallback(() => {
    setAnchor(null);
    setOpened(null);
  }, []);
  /**
   * Stage 0 at its episode form, reached from beside the episode picker
   * rather than from the ladder, where nobody would think to look for it.
   */
  const newEpisode = useCallback(() => {
    onRunCleared();
    setAnchor("prepare-episode");
    setOpened(status?.cells.find((cell) => cell.stage === 0)?.id ?? null);
  }, [onRunCleared, status]);
  const chooseEpisode = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setPicked(event.target.value),
    []
  );

  if (listing === null) {
    return <p className="empty">Czytam katalog roboczy…</p>;
  }

  if (project === null) {
    return (
      <section aria-labelledby="project-title">
        <Back href={OPEN} label="Projekty" />
        <h1 id="project-title">{projectId}</h1>
        <p className="refusal" role="alert">
          W katalogu roboczym nie ma projektu {projectId}.
        </p>
      </section>
    );
  }

  // The panel renders the cell the ladder is carrying right now, so a finished
  // command refreshes what the panel says without the panel asking anything.
  const panel = status?.cells.find((cell) => cell.id === opened && openable(cell)) ?? null;
  /**
   * Stage 0 is reachable even when there is no ladder to open it from.
   *
   * That is not a convenience: a fresh project has no episode, and `status`
   * answers about an episode. Stage 0 is what makes the rest exist, so it is
   * the one panel that cannot be behind the thing it produces.
   */
  const ladderless = project.episodes.length === 0 || refusal !== null;
  const preparing = panel?.stage === 0 || ladderless;

  return (
    <section aria-labelledby="project-title">
      <Back href={OPEN} label="Projekty" />
      <h1 id="project-title">{project.id}</h1>
      <EpisodePicker
        episodeId={episodeId}
        onEpisode={chooseEpisode}
        onNewEpisode={newEpisode}
        project={project}
      />
      <Notices
        connection={connection}
        ladderless={ladderless}
        project={project}
        refusal={refusal}
      />
      <Workbench
        anchor={anchor}
        cell={panel}
        episodeId={episodeId}
        onClose={close}
        onOpen={openCell}
        onRun={onRun}
        opened={opened}
        preparing={preparing}
        projectId={project.id}
        run={run}
        running={running}
        status={status}
      />
    </section>
  );
}

export function App(): JSX.Element {
  const route = useRoute();
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [listingRefusal, setListingRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [run, setRun] = useState<RunDone | null>(null);

  /**
   * The workspace's own stream, open on every screen.
   *
   * It carries the listing, re-read whenever something under the workspace
   * moves, so a project created here or by an agent in a terminal shows up
   * without a reload. And it carries every finished command, which is the
   * reason it exists at all: a project is created before there is an episode
   * whose stream could have delivered the answer.
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
    events.addEventListener("run", (event) => setRun(JSON.parse(event.data) as RunDone));
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
    setRun(null);
    setPending(null);

    fetch("/api/run", {
      body: JSON.stringify({ argv }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => (await response.json()) as { runId?: string })
      .then((body) => setPending(body.runId ?? null))
      .catch(() =>
        setRun({
          error: { message: "Serwer nie przyjął komendy.", name: "NetworkError" },
          ok: false,
          runId: "",
        })
      );
  }, []);
  const clearRun = useCallback(() => {
    setRun(null);
    setPending(null);
  }, []);
  const created = useCallback((projectId: string) => {
    window.location.hash = projectHref(projectId);
  }, []);

  /**
   * A command's answer belongs to the screen that started it.
   *
   * Leaving that screen forgets it, so the next one does not open with a
   * result nobody on it asked for. It is adjusted while rendering rather than
   * in an effect, so no frame ever shows the old answer on the new screen.
   */
  const routeKey = route.kind === "project" ? `project:${route.projectId}` : route.kind;
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
        {route.kind === "home" ? <Home /> : null}
        {route.kind === "new" ? (
          <>
            <Back href={HOME} label="Start" />
            <NewProject onCreated={created} onRun={start} run={run} running={running} />
          </>
        ) : null}
        {route.kind === "open" ? <OpenProject listing={listing} refusal={listingRefusal} /> : null}
        {route.kind === "project" ? (
          // Keyed by project, so moving between two of them starts the second
          // with nothing left over from the first: no open panel, no pick.
          <ProjectView
            key={route.projectId}
            listing={listing}
            onRun={start}
            onRunCleared={clearRun}
            projectId={route.projectId}
            run={run}
            running={running}
          />
        ) : null}
      </main>
    </>
  );
}
