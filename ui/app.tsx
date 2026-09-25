import { type JSX, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AssemblyPanel } from "./assembly";
import { CharacterPanel } from "./character";
import { ClipsPanel } from "./clips";
import { Ladder } from "./ladder";
import { MixPanel, NarrationPanel } from "./narration";
import { OpeningFramePanel } from "./opening-frame";
import { plural } from "./panel";
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
  | { readonly kind: "new-episode"; readonly projectId: string }
  | { readonly kind: "episodes"; readonly projectId: string }
  | { readonly kind: "episode"; readonly episodeId: string; readonly projectId: string };

/** Every screen that is about one project, which is every screen past the start. */
type InProject = Extract<Route, { readonly projectId: string }>;

const HOME = "#/";
const NEW = "#/nowy";
const OPEN = "#/wczytaj";

function projectHref(projectId: string): string {
  return `#/projekt/${encodeURIComponent(projectId)}`;
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
  const [, first, second, third, fourth] = hash.replace(LEADING_HASH, "").split("/");

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

  if (third === "nowy-odcinek") {
    return { kind: "new-episode", projectId };
  }

  if (third === "odcinki") {
    return { kind: "episodes", projectId };
  }

  const episodeId = third === "odcinek" ? segment(fourth) : null;

  return episodeId === null
    ? { kind: "project", projectId }
    : { episodeId, kind: "episode", projectId };
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
 * A panel that opened somewhere a person is not looking has not opened.
 *
 * The two-column layout answers this for a wide window: the panel stands
 * beside the row that was clicked and is in view already, so `nearest` moves
 * nothing. A narrow window stacks, and there the panel lands below the whole
 * ladder: a click whose result is off-screen. The panel takes focus either
 * way, because a keyboard and a screen reader are in exactly the position a
 * scrolled-past panel leaves the eye in.
 */
function useReveal(props: {
  readonly opened: string | null;
  readonly panel: RefObject<HTMLDivElement | null>;
  readonly showing: boolean;
}): void {
  const { opened, panel, showing } = props;

  useEffect(() => {
    // A stage-0 panel standing in for a refused ladder opened itself; there
    // was no click, so nothing has moved and nothing should be moved to.
    if (!showing || opened === null) {
      return;
    }

    const wide = window.matchMedia("(min-width: 64rem)").matches;

    panel.current?.scrollIntoView({ behavior: "smooth", block: wide ? "nearest" : "start" });
    panel.current?.focus({ preventScroll: true });
  }, [opened, panel, showing]);
}

/**
 * The ladder and the panel of the row somebody opened, side by side.
 *
 * They are one component because they are one answer: a click on a row and
 * the thing that click produced. A wide window puts the two in columns and
 * keeps the panel in view while the ladder scrolls; a narrow one stacks them
 * and the client scrolls to the panel instead.
 *
 * Stage 0 is the exception that shapes the rest: when the ladder is refused it
 * is the one panel left to fix things from, so the grid drops to one column
 * rather than leaving an empty half beside a form.
 */
function Workbench(props: {
  readonly cell: StatusCell | null;
  readonly episodeId: string;
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
  const { cell, episodeId, onClose, onOpen, onRun, opened, preparing, status } = props;
  const { projectId, run, running } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const showing = preparing || cell !== null;

  useReveal({ opened, panel: panelRef, showing });

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
          {cell === null ? null : (
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
 * Two ways forward, and nothing else.
 *
 * The same pair at every level: something new, or something that exists.
 * They are links rather than buttons because each one goes somewhere, and a
 * place is what the address bar, the back button and a middle click are for.
 */
function Choices(props: {
  readonly label: string;
  readonly load: { readonly href: string; readonly label: string };
  readonly make: { readonly href: string; readonly label: string };
}): JSX.Element {
  const { label, load, make } = props;

  return (
    <div className="home">
      <nav aria-label={label} className="home-choices">
        <a className="choice" href={make.href}>
          {make.label}
        </a>
        <a className="choice" href={load.href}>
          {load.label}
        </a>
      </nav>
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
  readonly items: readonly { readonly href: string; readonly id: string; readonly meta?: string }[];
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

/** The episodes of one project, the same list one level down. */
function OpenEpisode(props: { readonly project: ListedProject }): JSX.Element {
  const { project } = props;

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
          items={project.episodes.map((one) => ({ href: episodeHref(project.id, one), id: one }))}
        />
      )}
    </section>
  );
}

/**
 * One episode: its ladder, and the panel open beside it.
 *
 * This is the screen that used to be the whole application, now reached from
 * a project rather than landed on. The episode is chosen on the way in and
 * the address names it, so nothing here chooses it again.
 */
function EpisodeView(props: {
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly onRunCleared: () => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { episodeId, onRun, onRunCleared, projectId, run, running } = props;
  const [status, setStatus] = useState<EpisodeStatus | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("opening");
  const [opened, setOpened] = useState<string | null>(null);

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
      setOpened((current) => (current === id ? null : id));
    },
    [onRunCleared]
  );
  const close = useCallback(() => setOpened(null), []);

  // The panel renders the cell the ladder is carrying right now, so a finished
  // command refreshes what the panel says without the panel asking anything.
  const panel = status?.cells.find((cell) => cell.id === opened && openable(cell)) ?? null;
  /**
   * A refused ladder leaves stage 0 on screen, because stage 0 is where the
   * things a ladder is refused over (a missing file, a broken decision) are
   * put right.
   */
  const ladderless = refusal !== null;
  const preparing = panel?.stage === 0 || ladderless;

  return (
    <section aria-labelledby="episode-title">
      <Back href={episodesHref(projectId)} label="Odcinki" />
      <h1 id="episode-title">{episodeId}</h1>
      <Notices connection={connection} ladderless={ladderless} refusal={refusal} />
      <Workbench
        cell={panel}
        episodeId={episodeId}
        onClose={close}
        onOpen={openCell}
        onRun={onRun}
        opened={opened}
        preparing={preparing}
        projectId={projectId}
        run={run}
        running={running}
        status={status}
      />
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
  readonly onRunCleared: () => void;
  readonly route: InProject;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { listing, listingRefusal, onRun, onRunCleared, route, run, running } = props;
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

  if (route.kind === "episode") {
    return project.episodes.includes(route.episodeId) ? (
      // Keyed by episode, so moving between two of them starts the second
      // with nothing left over from the first: no open panel, no old ladder.
      <EpisodeView
        episodeId={route.episodeId}
        key={route.episodeId}
        onRun={onRun}
        onRunCleared={onRunCleared}
        projectId={project.id}
        run={run}
        running={running}
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
  const createdProject = useCallback((projectId: string) => {
    window.location.hash = projectHref(projectId);
  }, []);

  /**
   * A command's answer belongs to the screen that started it.
   *
   * Leaving that screen forgets it, so the next one does not open with a
   * result nobody on it asked for. It is adjusted while rendering rather than
   * in an effect, so no frame ever shows the old answer on the new screen.
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
            onRunCleared={clearRun}
            route={route}
            run={run}
            running={running}
          />
        ) : null}
      </main>
    </>
  );
}
