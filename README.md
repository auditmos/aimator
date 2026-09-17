# aimator

CLI, które prowadzi przez produkcję krótkiej animacji: od pomysłu, przez scenariusz
i assety, po gotowy film sklejony z klipów.

Artefakty są grupowane **per projekt i per model obrazu**. Jeden projekt może mieć
komplet assetów w `gpt-image` i w `seedream` — to dwa niezależne byty dające dwie różne
animacje z tej samej historii. Ujęcia i klipy w obu torach robi Seedance 2.5.

**Stan: zaimplementowany jest etap 0 (przygotowanie projektu i odcinka).** Etapy 1–8 mają
zapisany kontrakt w [docs/pipeline.md](docs/pipeline.md), ale nie mają jeszcze kodu.

## Wymagania

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/)

## Instalacja

```bash
pnpm install
```

Ustaw katalog na artefakty. Leży **poza repozytorium**, bo jeden projekt to setki
megabajtów obrazów i wideo:

```bash
cp .env.example .env
```

```dotenv
# .env — Twoje lokalne wartości, poza gitem
AIMATOR_WORKSPACE=~/Documents/Video/aimator-workspace
```

Wiodące `~/` jest rozwijane. Kolejność ma znaczenie: `.env.local` wygrywa z `.env`,
a zmienna z powłoki wygrywa z obydwoma. Commitowany jest wyłącznie `.env.example`.

## Etap 0 — przygotowanie projektu i odcinka

To rozmowa, nie generacja. Żadne polecenie tego etapu nie woła płatnego API.

Najprościej poprowadzić ją skillem, który zbierze decyzje i sam wywoła poniższe polecenia:

```
/prepare-project
```

Jeśli masz dopiero mglisty pomysł i nie umiesz odpowiedzieć, o czym to ma być ani jak ma
wyglądać, zacznij o krok wcześniej — `/develop-series` doprowadzi Cię do tych odpowiedzi
i przekaże je dalej. Fabuła odcinka **nie** powstaje w żadnym z nich: opracowuje ją etap 1
ze wskazanego pliku źródłowego.

Ręcznie wygląda to tak:

```bash
pnpm dev project init 48-praw-wladzy --title "48 praw władzy" --aspect-ratio 16:9
# uzupełnij każdy TODO(etap-0) w project.md — to jedyny plik pisany ręcznie
pnpm dev character add 48-praw-wladzy --source ~/Zdjecia/portret.jpg
pnpm dev episode add 48-praw-wladzy --source '~/48/01-NEVER OUTSHINE THE MASTER.md'
pnpm dev episode set 48-praw-wladzy 01-never-outshine-the-master \
  --duration 60 --audio music-and-effects --language pl --subtitles pl --nature law-or-idea
pnpm dev check 48-praw-wladzy
```

Każde polecenie zapisujące przyjmuje `--dry-run`: pokazuje, co powstanie, i nie zapisuje
niczego. `--workspace <ścieżka>` nadpisuje `AIMATOR_WORKSPACE` dla jednego wywołania.

Powstaje:

```
$AIMATOR_WORKSPACE/projects/48-praw-wladzy/
├── project.json        identyfikator, tytuł, proporcje, materiały postaci
├── project.md          zasady wspólne — pisane ręcznie
├── prepare.stage.json  pochodzenie i ocena
├── character/sources/  zdjęcia, skopiowane i zahashowane
└── episodes/01-never-outshine-the-master/
    ├── source.md       kopia bajtowa Twojego opisu
    ├── episode.json    pięć decyzji odcinka
    └── prepare.stage.json
```

### Pięć decyzji odcinka

| Pole | Wartość |
|---|---|
| `--duration` | długość w sekundach, liczba całkowita 1–3600 |
| `--audio` | `music-and-effects`, `dialogue`, `narration`, `dialogue-and-narration` — wszystkie zawierają muzykę i efekty |
| `--language` | kod języka scenariusza i wypowiedzi; wymagany także w filmie bez mowy |
| `--subtitles` | kod języka albo `none`; ustalany niezależnie od `--language` |
| `--nature` | `law-or-idea`, `synopsis`, `screenplay` — czym jest Twój plik źródłowy |

Świeży `episode.json` ma wszystkie pięć jako `null` i jest celowo niegotowy. Nie ma
wartości domyślnych: `--duration` nie ma „zwykle 60", a `--language` nie dziedziczy się
z zasad projektu.

`check` przepuszcza, gdy zasady nie zawierają już żadnego `TODO(etap-0)`, proporcje są
ustalone, źródło zgadza się z zapisanym hashem i żadna z pięciu decyzji nie jest pusta.
To kontrola **plików**. Nie potwierdza, że zasady mają sens ani że pomysł jest dobry.

## Zasady, na których stoi całe narzędzie

- Każdy etap konsumuje wyłącznie artefakty wytworzone przez wcześniejsze etapy — nigdy
  kontekstu rozmowy. Etap 0 jest jedynym, który legalnie wciąga materiał z zewnątrz, i
  właśnie dlatego kopiuje bajty do środka i zapisuje ich hash.
- Ocena kreatywna jest osobna od walidacji. Plik, który powstał, nie jest plikiem
  przyjętym.
- Akceptacja jest związana z bajtami. Zmiana pliku poza narzędziem unieważnia ją i `check`
  to zgłasza.
- Nic nie ponawia się automatycznie, a stan `submitted` zapisuje się przed płatnym
  wywołaniem — przerwana generacja wznawia się przez odpytanie zadania, nie przez drugą
  opłatę.

Pełny kontrakt: [docs/pipeline.md](docs/pipeline.md).

## Polecenia

| Polecenie | Opis |
|---------|-------------|
| `pnpm build` | Build tsup (ESM + deklaracje) |
| `pnpm dev` | Uruchom CLI ze źródeł przez tsx, bez budowania |
| `pnpm lint` | Sprawdź kod Biome |
| `pnpm lint:fix` | Napraw lint i formatowanie |
| `pnpm types` | Sprawdź typy przez tsc --noEmit |
| `pnpm test` | Testy Vitest |
| `pnpm test:watch` | Testy w trybie watch |
| `pnpm unused` | Nieużywany kod (Knip) |
| `pnpm update` | Interaktywna aktualizacja zależności (Taze) |

`pnpm dev` używa `tsx`, a nie natywnego strippingu typów w Node, bo rozdzielczość
`Node16` w TypeScripcie zapisuje specyfikatory `.js`, których Node nie zmapuje z powrotem
na pliki `.ts`.

## Architektura

Kod trzyma się **głębokich modułów** (Ousterhout): wąski interfejs nad dużą implementacją.

- Domena zaczyna jako jeden plik `src/lib/{domena}.ts`
- Gdy urośnie o wewnętrzne części, staje się katalogiem z `index.ts` jako jedynym wejściem
- Eksportuj tylko to, czego potrzebuje wołający — `pnpm unused` wywala CI na eksportach,
  których nikt nie importuje

`src/bin.ts` jest celowo cienką nakładką: trzyma shebang, strumienie i kod wyjścia. Całe
zachowanie siedzi w `src/cli.ts` jako `run(argv): Promise<Result<string>>`, dzięki czemu
CLI testuje się wywołaniem funkcji, a nie uruchamianiem procesu.

Pełne zasady — granice, ścieżka wzrostu, egzekwowanie — w [AGENTS.md](AGENTS.md).

## Praca nad kodem

1. Testy leżą obok źródeł (`*.test.ts`)
2. TDD: najpierw czerwony test, potem minimalny kod, potem refaktor
3. Commity w formacie [Conventional Commits](https://www.conventionalcommits.org/)
4. Hook pre-commit uruchamia lint i testy
5. Push na `main` uruchamia CI i semantic-release

Skille: `/develop-series` (rozwinięcie pomysłu), `/prepare-project` (etap 0),
`/environment-variables` (zmienne środowiskowe),
`/bugfix` (najpierw test odtwarzający błąd). Szczegóły w [HOWTO.md](HOWTO.md).
