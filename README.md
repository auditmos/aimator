# aimator

CLI, które prowadzi przez produkcję krótkiej animacji: od pomysłu, przez scenariusz
i assety, po gotowy film sklejony z klipów.

Artefakty są grupowane **per projekt i per model obrazu**. Jeden projekt może mieć
komplet assetów w `gpt-image` i w `seedream` — to dwa niezależne byty dające dwie różne
animacje z tej samej historii. Ujęcia i klipy w obu torach robi Seedance 2.5.

**Stan: zaimplementowane są etapy 0–8** — przygotowanie, scenariusz, postać, lista ujęć,
pakiet promptów, obrazy referencyjne, klatka otwarcia, klipy i montaż. Etap 9 — dźwięk —
ma zapisany kontrakt w [docs/pipeline.md](docs/pipeline.md), ale nie ma jeszcze kodu,
więc `episode.mp4` jest **niemy**: ścieżkę dźwiękową trzeba pisać wobec sklejonego
filmu, a nie wobec planu, więc należy do etapu po montażu.

## Wymagania

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/)
- [ffmpeg](https://ffmpeg.org/) — tylko dla etapu 8. Skleja klipy bez przekodowania;
  gdy go nie ma, montaż odmawia zamiast szukać objazdu. Reszta narzędzia, razem
  z `check`, działa bez niego — werdykty czytają pudełka MP4, nie wołają dekodera.

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

# Etapy płatne. Żaden model nie ma wartości domyślnej: model, którego nikt nie
# wybrał, nie jest decyzją. Klucze czytane są wyłącznie na ścieżce płatnej.
AIMATOR_SCREENPLAY_MODEL=…            # etap 1
AIMATOR_SHOTLIST_MODEL=…              # etap 3
AIMATOR_PROMPTS_MODEL=…               # etap 4
AIMATOR_IMAGE_MODEL_GPT_IMAGE=…       # etap 2, tor gpt-image
AIMATOR_IMAGE_MODEL_SEEDREAM=…        # etap 2, tor seedream
AIMATOR_VIDEO_MODEL=…                 # etap 7, JEDEN dla obu torów
AIMATOR_FFMPEG=ffmpeg                 # etap 8; program, nie model — tylko gdy nie jest w PATH
OPENAI_API_KEY=…
BYTEPLUS_MODELARK=…                   # także klucz wideo, na obu torach
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
# wymień każdą powracającą postać, nie tylko główną
pnpm dev character new 48-praw-wladzy narrator --name "Narrator"
pnpm dev character add 48-praw-wladzy narrator --source ~/Zdjecia/portret.jpg
# albo, jeśli zdjęć nie będzie i postać powstaje z opisu:
pnpm dev character describe 48-praw-wladzy narrator
pnpm dev episode add 48-praw-wladzy --source '~/48/01-NEVER OUTSHINE THE MASTER.md'
pnpm dev episode set 48-praw-wladzy 01-never-outshine-the-master \
  --duration 60 --audio music-and-effects --language pl --subtitles pl --nature law-or-idea
pnpm dev check 48-praw-wladzy
pnpm dev approve 48-praw-wladzy --note "przeczytane i przyjęte"
```

Każde polecenie zapisujące przyjmuje `--dry-run`: pokazuje, co powstanie, i nie zapisuje
niczego. `--workspace <ścieżka>` nadpisuje `AIMATOR_WORKSPACE` dla jednego wywołania.

Powstaje:

```
$AIMATOR_WORKSPACE/projects/48-praw-wladzy/
├── project.json        identyfikator, tytuł, proporcje, obsada
├── project.md          zasady wspólne — pisane ręcznie
├── prepare.stage.json  pochodzenie i ocena
├── characters/narrator/sources/   zdjęcia tej postaci, skopiowane i zahashowane
└── episodes/01-never-outshine-the-master/
    ├── source.md       kopia bajtowa Twojego opisu
    ├── episode.json    pięć decyzji odcinka
    └── prepare.stage.json
```

Katalog powstaje dopiero wtedy, gdy coś do niego pisze — pusty folder byłby obietnicą,
której narzędzie nie dotrzymuje.

### Dwie decyzje projektu

| Decyzja | Wartość |
|---|---|
| `--aspect-ratio` | np. `16:9`; po powstaniu obrazów nie da się zmienić bez ich unieważnienia |
| obsada | każda powracająca postać, z identyfikatorem, nazwą i własną podstawą |

**Obsada jest decyzją, nie wnioskiem.** Pusta obsada blokuje bramkę, bo projekt bez
zadeklarowanej postaci znaczył kiedyś „dokładnie jedna, bezimienna" — i właśnie ten cichy
domysł sprawiał, że seria opisująca dwie osoby produkowała jedną, a którą, rozstrzygał model.
Kryterium jest powracalność: postać, której tożsamość musi przetrwać między odcinkami, należy
do obsady; twarz widziana raz to referencja etapu 5.

Każda postać ma **własną podstawę**, więc jedną możesz zbudować ze zdjęć, a resztę z opisu.
Podstawa istnieje, bo pusty katalog na zdjęcia nie odróżnia „świadomie bez zdjęć" od „jeszcze
nie dodałem". Przy `photographs` bramka blokuje, dopóki nie ma ani jednego zdjęcia tej
postaci. Przy `description` **jedynym** wejściem etapu postaci jest opis jej wyglądu
w `project.md` — i wtedy to on musi być konkretny, bo nic dalej go nie uzupełni.
`character add` samo w sobie jest deklaracją i przestawia podstawę na `photographs`.

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

`check` przepuszcza, gdy zasady nie zawierają już żadnego `TODO(etap-0)`, obie decyzje
projektu są ustalone, wyniki zgadzają się z zapisanymi hashami i żadna z pięciu decyzji
odcinka nie jest pusta. To kontrola **plików**. Nie potwierdza, że zasady mają sens ani że
pomysł jest dobry — i mówi to wprost zamiast udawać, że przeszło znaczy przyjęte.

Przyjęcie zapisuje osobne polecenie:

```bash
pnpm dev approve 48-praw-wladzy --note "przeczytane i przyjęte"
```

`approve` powtarza całą walidację i odmawia, jeśli cokolwiek nie gra — akceptacja zapisana
na zepsutym pochodzeniu byłaby kłamstwem, któremu zaufałyby kolejne etapy. Przy okazji
`project.md` dostaje wreszcie swój hash: do tej chwili pisze go człowiek, więc hash z
momentu `init` opisywałby pusty szkielet. Każda późniejsza edycja unieważnia akceptację,
a `check` to zgłasza.

## Etap 2 — postać

Pierwszy etap obrazowy i pierwszy, który rozgałęzia się na dwa tory modelowe. Nie zależy
od etapu 1, więc scenariusz i postacie mogą powstawać równolegle.

```bash
pnpm dev character generate 48-praw-wladzy narrator --track gpt-image --dry-run
pnpm dev character generate 48-praw-wladzy narrator --track gpt-image
pnpm dev approve 48-praw-wladzy narrator --stage character --track gpt-image \
  --artifact card --note "podobieństwo się zgadza"
pnpm dev character generate 48-praw-wladzy narrator --track gpt-image   # osiem widoków
```

Jedno polecenie produkuje w tej kolejności `card.png`, osiem widoków i `hero.png` pod
`characters/<postać>/<tor>/`. **Bez flag robi następny krok i przestaje**, bo osiem widoków
czeka na zatwierdzoną kartę, a `hero.png` na zatwierdzone widoki — i ani jednej z tych
bramek nie otwiera sama walidacja. `--artifact card|hero|<widok>[,...]` zawęża przebieg,
`--regenerate` wymaga jawnego `--artifact`, bo nowa opłata ma adresata.

Model wskazuje `--model <id>`, a bez tej flagi `AIMATOR_IMAGE_MODEL_GPT_IMAGE` albo
`AIMATOR_IMAGE_MODEL_SEEDREAM` — jedna zmienna na tor, żeby oba dało się puścić z jednej
powłoki. Wartości domyślnej nie ma. Klucz (`OPENAI_API_KEY` albo `BYTEPLUS_MODELARK`)
czytany jest wyłącznie na ścieżce płatnej; `--dry-run` pokazuje każdy prompt w całości,
nie sięgając po sekret ani po sieć.

Przerwana próba zwykle wznawia się **bez drugiej opłaty**: powtórz to samo polecenie.
Odpowiedź, która zdążyła trafić na dysk, jest już opłacona — gpt-image niesie w niej bajty,
seedream adres ważny 24 h.

Akceptacja dotyczy jednego obrazu naraz i jest związana z jego sha256. `approve` odmawia
bez `--artifact`: przyjęcie karty uruchamia osiem płatnych wywołań, więc musi być czymś,
co ktoś napisał.

## Etap 5 — obrazy referencyjne

Pierwszy etap, w którym tory naprawdę się rozchodzą: jeden pakiet promptów, dwa niezależne
zestawy obrazów, dwie osobne oceny.

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track gpt-image --artifact R02
pnpm dev reference generate dzielna-ewa 01-burza --track gpt-image --dry-run
pnpm dev reference generate dzielna-ewa 01-burza --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage references --track gpt-image \
  --artifact R01 --note "wieczorny komplet się zgadza"
```

`prompt-package show` jest **darmowe** i drukuje dokładnie to, co poleci do modelu:
numerowany blok `Image N = <identyfikator> — <rola>` w kolejności, w jakiej żądanie
poniesie bajty, treść pliku z `prompts/`, blok o medium, kadr, przy kadrach filmu dosłowne
ujęcia z listy, i `project.md`. Istnieje, bo etap 4 publikuje **połowę** promptu — resztę
dokleja etap wysyłający, więc inaczej zatwierdzałbyś tekst, którego nie widzisz w formie,
w jakiej poleci. Bez `--artifact` wypisuje sam plan: co pakiet planuje i czy załączniki są
zatwierdzone.

**Bez flag polecenie rysuje wszystkie referencje, których zależności są już zatwierdzone na
tym torze** — i mówi, ile płatnych wywołań wykona, zanim je wykona. To pierwszy etap,
w którym jedno polecenie może kupić kilka obrazów: graf `dependsOn` ma zwykle kilka
niezależnych korzeni. Bramka jest wewnątrz własnego zestawu wyników, więc R04 czeka na
**zatwierdzoną** R03, a narysowanie R03 niczego nie otwiera.

Kadr wynika z `aspectRatio` projektu i jest ten sam na obu torach — dla `16:9` to
2816×1584, czyli największa ramka o dokładnie tej proporcji, którą przyjmują oba tory.
Obraz w innym rozmiarze nie jest publikowany ani skalowany.

## Etap 6 — klatka otwarcia

Pierwsza klatka filmu. Jedno polecenie, jedno płatne wywołanie, jeden obraz do oceny.

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track seedream --artifact opening-frame
pnpm dev opening-frame generate dzielna-ewa 01-burza --track seedream --dry-run
pnpm dev opening-frame generate dzielna-ewa 01-burza --track seedream
pnpm dev approve dzielna-ewa 01-burza --stage opening-frame --track seedream \
  --note "pozycja alpaki bez ucisku ucha"
```

Bramka czeka na to, co pakiet wpisał w `opening.referenceIds` — `hero:<id>` każdej postaci
w kadrze i wskazane `Rnn` — **zatwierdzone na tym torze**. Zgoda wydana na gpt-image nie
otwiera niczego na seedream. To pierwszy etap, którego zależność przekracza granicę etapu,
nie przekraczając granicy toru.

**`--artifact` nie jest tu wymagane nigdzie** — ani przy `--regenerate`, ani przy
`approve`. Etap ma jeden artefakt, więc samo polecenie już mówi, o co chodzi; flaga
o jednej dozwolonej wartości byłaby ceremonią, nie zabezpieczeniem. Napisana i tak jest
sprawdzana: `--artifact R01` w tym etapie to odmowa, nie ciche zignorowanie.

W odróżnieniu od etapu 5 klatka otwarcia **niesie dosłowne ujęcia** pierwszego klipu, bo
jest kadrem filmu, a nie referencją — więc `shot-list.md` jest jej zapisanym wejściem.
Kadr jest ten sam co w etapie 5.

## Etap 7 — klipy

Pierwszy etap, który kupuje dwa rodzaje mediów: klatki wejściowe (obraz) i klipy (wideo).

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track seedream --artifact C01
pnpm dev clip generate dzielna-ewa 01-burza --track seedream --dry-run
pnpm dev clip generate dzielna-ewa 01-burza --track seedream
pnpm dev check dzielna-ewa 01-burza --stage clips --track seedream
pnpm dev approve dzielna-ewa 01-burza --stage clips --track seedream --artifact C01 \
  --note "ruch ręki czytelny, końcówka nadaje się na wejście C02"
```

**Bramka jest łańcuchem.** Klip C01 czeka na zatwierdzoną klatkę otwarcia. Klatka wejściowa
C02 — na zatwierdzoną **końcówkę** C01, jeśli lista ujęć mówi `previous-end-frame`; jeśli
mówi `new-scene-frame`, czeka tylko na swoje referencje. Klip C02 czeka na swoją klatkę
wejściową. Każde ogniwo to zgoda człowieka, nie sama walidacja.

**Końcówka klipu wraca razem z klipem** — zadanie jest uruchamiane z prośbą o ostatnią
klatkę, więc powstaje z tej samej opłaconej próby i jest drugim wyjściem tego samego
rekordu. Jedna ocena obejmuje klip i klatkę, z której wyjdzie następny. Format wybiera
dostawca: ModelArk oddaje JPEG, więc plik nazywa się `frames/Cnn/end.jpg`. Nazwa idzie za
bajtami, bo przekodowanie oznaczałoby przyjęcie jednego obrazu i dołączenie innego.

**`--republish --artifact C01` publikuje klip jeszcze raz z archiwum**, nie wysyłając
niczego i nie wymagając modelu ani klucza. To jedyny etap obrazowo-wideo, który tej flagi
potrzebuje: obok klipu rozstrzyga jeszcze, czym jest końcówka — a pomyłka w rozstrzygnięciu
wychodzi na jaw po publikacji i nie może kosztować drugiego wideo.

**Płatne wywołanie klipu niesie dokładnie jeden obraz: swoją pierwszą klatkę.** To reguła
API, nie wybór — przypięcie pierwszej klatki wyklucza się z dołączaniem referencji.
Referencje, które manifest przypisał klipowi, są tym, z czego narysowano tę klatkę.

**Długość klipu bierze się z listy ujęć.** Klipu o długości, której model nie renderuje,
narzędzie nie zaokrągli: odmówi przed wysyłką i wskaże poprawkę w `maxClipSeconds` i etapie 3.
Raport podaje liczbę płatnych wywołań **osobno dla obrazów i dla wideo**, zanim cokolwiek
wyśle. Dźwięku nie generujemy — ścieżka dźwiękowa jest ciągła przez cięcia, więc należy do
etapu **poniżej montażu**, a klipy są proszone o ciszę jawnie.

Model wideo jest **jeden dla obu torów** (`AIMATOR_VIDEO_MODEL`, klucz `BYTEPLUS_MODELARK`),
a klatki wejściowe rysuje ten sam model obrazowy co referencje na tym torze. Dlatego zamiast
`--model` są dwie flagi: `--image-model` i `--video-model`.

## Etap 8 — montaż

Pierwszy etap, który **niczego nie kupuje**. Skleja zatwierdzone klipy w `<tor>/episode.mp4`.

```bash
pnpm dev assembly generate dzielna-ewa 01-burza --track gpt-image --dry-run
pnpm dev assembly generate dzielna-ewa 01-burza --track gpt-image
pnpm dev check dzielna-ewa 01-burza --stage assembly --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage assembly --track gpt-image \
  --note "rytm trzyma, szwy niewidoczne"
```

**Planu montażowego nie ma jako pliku.** Kolejność, sekundy i kafelkowanie bez dziur są już
w zatwierdzonej `shot-list.md`, a drugi plik byłby `shot-list.json` pod inną nazwą — czyli
tym, co etapy 3 i 4 już raz odrzuciły. Jeśli plan montażowy jest zły, poprawka należy do
etapu 3.

**Bramką są zatwierdzone klipy** — wszystkie, które planuje lista ujęć, **na tym torze**.
Klatek wejściowych ani końcówek bramka nie dotyka: klatka wejściowa jest już pierwszą
klatką swojego klipu.

**Skleja to, co wróciło, i melduje różnicę.** Klip zamówiony na 6 s wraca jako 6,04 s przy
24 klatkach, a etap 7 publikuje go bez przycinania — to są bajty, które przyjął człowiek.
Przycięcie ich tutaj złożyłoby film z klatek, których nie przyjął nikt. Raport podaje sumę
planu, sumę klipów i odchyłkę; werdykt na gotowym pliku porównuje go z **sumą jego własnych
klipów**, nie z `durationSeconds`.

**ffmpeg, bez przekodowania, bez objazdu.** Strumieniowe kopiowanie (`-c copy`) jest możliwe,
bo oba tory renderują jednym modelem w jednej rozdzielczości i tempie klatek. Gdy ffmpeg nie
ma w `PATH` ani w `AIMATOR_FFMPEG`, montaż odmawia. `check` go nie potrzebuje.

**„Ocena całości" to nie powtórka ocen klipów.** Tamte mówią, że każde ujęcie jest dobre; ta
mówi, że te klipy w tej kolejności to film. Rytm przez cięcia, ciągłość na szwach i
rzeczywista długość istnieją wyłącznie w całości. Jeden artefakt na tor, więc `--artifact`
nie jest wymagane nigdzie; `--regenerate` jest — nie dlatego, że coś kosztuje, tylko dlatego,
że gotowy montaż nosi czyjąś zgodę.

**`episode.mp4` jest niemy** i `check` mówi to przy każdym uruchomieniu.

## Zasady, na których stoi całe narzędzie

- Każdy etap konsumuje wyłącznie artefakty wytworzone przez wcześniejsze etapy — nigdy
  kontekstu rozmowy. Etap 0 jest jedynym, który legalnie wciąga materiał z zewnątrz, i
  właśnie dlatego kopiuje bajty do środka i zapisuje ich hash.
- Ocena kreatywna jest osobna od walidacji. Plik, który powstał, nie jest plikiem
  przyjętym.
- Akceptacja jest związana z bajtami. Zmiana pliku poza narzędziem unieważnia ją i `check`
  to zgłasza.
- Nic nie ponawia się automatycznie, a stan `submitted` zapisuje się przed płatnym
  wywołaniem. Przerwana próba zostawia więc ślad mówiący, że opłata mogła już paść.
  Czy da się ją dokończyć bez drugiej, zależy od dostawcy: tam, gdzie odpowiedź zdążyła
  trafić na dysk, wystarczy powtórzyć polecenie; poza tym jedyną drogą jest `--regenerate`.
- Obsada jest jawną decyzją. Brak zadeklarowanej postaci znaczy „nikt nie powiedział, kto
  występuje", a nie „jedna, bezimienna".

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
