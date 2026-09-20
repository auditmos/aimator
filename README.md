# aimator

CLI, które prowadzi przez produkcję krótkiej animacji: od pomysłu, przez scenariusz
i assety, po gotowy film sklejony z klipów.

Artefakty są grupowane **per projekt i per model obrazu**. Jeden projekt może mieć
komplet assetów w `gpt-image` i w `seedream` — to dwa niezależne byty dające dwie różne
animacje z tej samej historii. Ujęcia i klipy w obu torach robi Seedance 2.5.

**Stan: zaimplementowane są etapy 0–10** — przygotowanie, scenariusz, postać, lista ujęć,
pakiet promptów, obrazy referencyjne, klatka otwarcia, klipy, montaż, narracja oraz muzyka
i efekty. Film wychodzi z tego w trzech wersjach, z których każda nosi własną zgodę:
`episode.mp4` jest niemym cięciem obrazu, `narrated.mp4` dokłada narrację i jest jedynym
miejscem, gdzie słychać samo jej umieszczenie, a `mixed.mp4` ma wszystko.

Etap 11 — dialogi postaci — ma zapisany kontrakt w [docs/pipeline.md](docs/pipeline.md),
ale nie ma jeszcze kodu. Dwa z czterech trybów dźwięku (`music-and-effects`, `narration`)
są domknięte; dwa pozostałe deklarują mowę postaci, której nie wytwarza żaden etap — i
`check` mówi to wprost, zamiast milczeć.

## Wymagania

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/)
- [ffmpeg](https://ffmpeg.org/) — dla etapów 8, 9 i 10. Skleja klipy, kładzie na nich
  narrację i składa pełną ścieżkę, za każdym razem kopiując obraz bez przekodowania; gdy
  go nie ma, te etapy odmawiają zamiast szukać objazdu. Reszta narzędzia, razem z `check`,
  działa bez niego — werdykty czytają pudełka MP4, nagłówki RIFF i ramki MP3, nie wołają
  dekodera.

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
AIMATOR_FFMPEG=ffmpeg                 # etapy 8-10; program, nie model — tylko gdy nie jest w PATH
AIMATOR_NARRATION_MODEL=…             # etap 9, tekstowy — podnosi skrypt
AIMATOR_VOICE_MODEL=…                 # etap 9, mowa; JEDEN dla obu torów
AIMATOR_SOUND_MODEL=…                 # etap 10, tekstowy — pisze arkusz cue
AIMATOR_MUSIC_MODEL=…                 # etap 10, podkład; JEDEN dla obu torów
AIMATOR_EFFECTS_MODEL=…               # etap 10, efekty; JEDEN dla obu torów
OPENAI_API_KEY=…
BYTEPLUS_MODELARK=…                   # także klucz wideo, na obu torach
ELEVENLABS_API_KEY=…                  # mowa, muzyka i efekty — trzy miejsca wywołania, jeden klucz
```

**Jedna zmienna na płatne miejsce wywołania, nie na dostawcę.** Dlatego etap 9 ma dwie,
a etap 10 trzy: model, który pisze, i modele, które robią dźwięk, to różne decyzje.
Zmienna idzie za miejscem wywołania, klucz za dostawcą — stąd jeden `ELEVENLABS_API_KEY`
na trzy zmienne i `BYTEPLUS_MODELARK` także na torze `gpt-image`, kiedy renderuje klip.

**Głosu narratora tu nie ma i nie będzie.** Kto czyta serię, to obsada — wraca między
odcinkami tak samo jak postacie — więc siedzi w `project.json` jako `narratorVoiceId`.
W zmiennej drugi odcinek puszczony z innej powłoki dostałby innego lektora, a na dysku
nie byłoby pliku mówiącego, że ktokolwiek tak zdecydował.

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

## Etap 9 — narracja

Pierwszy etap, który kupuje od **dwóch dostawców**, i pierwszy, którego artefakty leżą na
**dwóch poziomach drzewa**: słowa są wspólne, miks jest per tor.

```bash
pnpm dev narration generate dzielna-ewa 01-burza --dry-run
pnpm dev narration generate dzielna-ewa 01-burza
pnpm dev approve dzielna-ewa 01-burza --stage soundtrack --artifact script \
  --note "każde zdanie jest w swoim ujęciu"
pnpm dev narration generate dzielna-ewa 01-burza        # dopiero teraz kupuje kwestie
pnpm dev approve dzielna-ewa 01-burza --stage soundtrack --artifact N01,N02,N03,N04
pnpm dev narration mix dzielna-ewa 01-burza --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage soundtrack --track gpt-image
```

**Narracja jest podnoszona, nie pisana — i walidator to sprawdza.** Słowa narratora powstały
już w etapie 1, a etap 3 przeniósł je do pola `Audio` każdego ujęcia, gdzie siedzą w zdaniu
opisującym też muzykę i deszcz. Wyciąganie ich parserem byłoby parserem nad prozą, więc robi
to model — a walidator dowodzi, że podniesienie było podniesieniem: **tekst każdej kwestii
musi wystąpić co do słowa w ujęciu, które ta kwestia nazywa.** Zdanie, którego lista ujęć nie
zawiera, nie przechodzi, choćby czytało się lepiej. Jeśli film ma powiedzieć coś nowego,
poprawka należy do etapu 1.

**Głos to obsada, sposób czytania to reżyseria.** `narratorVoiceId` mieszka w `project.json`
obok postaci, bo lektor wraca między odcinkami. To, *jak* on gra, mieszka w osobnym
`projects/<id>/narration.json` — i to nie jest kaprys układu. `project.json` jest zapisanym
wejściem niemal wszystkiego, więc suwak, który ma się kręcić, unieważniałby zgody na bajty,
których nie dotknął o ani jeden bit.

```bash
pnpm dev narration direction dzielna-ewa --stability 0.35 --style 0.4
```

**Rachunek nie jest w wywołaniach.** Dostawca liczy **znaki wejścia**, więc podgląd podaje
jedno i drugie, per kwestia i łącznie. Znaki kontekstu (`previous_text`/`next_text`) są
liczone **obok** rachunku, nigdy w nim: dostawca dokumentuje te parametry, ale nie mówi, czy
je rozlicza, a narzędzie nie zgaduje cudzymi pieniędzmi.

**Bajtami rządzi etap 8, umieszczeniem etap 7.** Publikuje się to, co wróciło — żadnego
rozciągania czasu ani skracania pauzy. Ale kotwica pochodzi z planu, który zatwierdził
człowiek, więc kwestia nachodząca na następną albo wychodząca poza koniec filmu jest
**odmową**, nie zaokrągleniem. Kotwica z planu nie jest sekundą filmu: klipy wróciły dłuższe,
więc mikser przelicza jedno na drugie i **melduje przesunięcie**.

**`episode.mp4` nie jest dotykany.** `narrated.mp4` to nowy plik, którego obraz jest kopią
strumieniową zatwierdzonego cięcia, klatka w klatkę.

## Etap 10 — muzyka i efekty

Pierwszy etap, który **przepisał własny wiersz kontraktu**, i jedyny, którego werdykt nie
potrafi udowodnić, że wynik mówi prawdę o wejściu. Obie rzeczy są rozstrzygnięciami, nie
niedoróbkami.

```bash
pnpm dev sound-design generate dzielna-ewa 01-burza --dry-run
pnpm dev sound-design generate dzielna-ewa 01-burza      # jedno wywołanie TEKSTOWE
pnpm dev approve dzielna-ewa 01-burza --stage sound-design --artifact cues
pnpm dev sound-design generate dzielna-ewa 01-burza --dry-run   # TU pojawia się rachunek
pnpm dev sound-design generate dzielna-ewa 01-burza      # kupuje podkład i efekty
pnpm dev check dzielna-ewa 01-burza --stage sound-design
pnpm dev approve dzielna-ewa 01-burza --stage sound-design --artifact M01,E01,E02
pnpm dev sound-design mix dzielna-ewa 01-burza --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage sound-design --track gpt-image
```

**Wiersz 10 się zmienił i jest to zapisane.** Mówił, że muzyka i efekty są *wejściem*
wnoszonym przez człowieka — i sam przyznawał, że nie rozstrzyga, skąd się biorą. Tak się go
nie da zbudować: wciąganie cudzych plików do katalogu roboczego ma monopol etapu 0, więc
„wnosi człowiek" było przepisaniem etapu 0 pod inną nazwą. Stemy kupuje więc ten etap, od
ElevenLabs — co nie jest czwartym dostawcą, tylko czwartym i piątym miejscem wywołania
u dostawcy, którego potok już ma na mowę.

**Nie ma tu odpowiednika reguły „podnoszone, nie pisane" i nie da się go mieć.** Prompt
muzyczny jest **instrukcją**, więc reguła 9 każe pisać go po angielsku; pole `Audio`, z
którego powstaje, jest **materiałem** po polsku, którego reguła 9 zabrania tłumaczyć.
Przepisanie jest zakazane z obu stron. Precedensem jest więc etap 4, nie 9: **werdykt
okablowania, który nigdy nie czyta promptu**.

| co udowadnia walidator | co zostaje człowiekowi |
|---|---|
| każdy cue nazywa ujęcia, które istnieją | czy angielski opisuje polską prozę |
| **ujęcia cue to dokładnie te, które leżą w jego sekundach** | czy to jest dobra muzyka |
| podkład kafelkuje film od 0 do końca planu, bez dziur | |
| każda długość jest taka, jaką dostawca zrenderuje | |

Drugi wiersz niesie ciężar, który piętro wyżej niesie podnoszenie: wierności nie dowodzi, ale
dowodzi, że model przeszedł **cały plan** — ujęcie pominięte i ujęcie wymyślone wychodzą tak
samo. Języka nie sprawdza nic, dokładnie jak w etapie 4; sprawdzian był napisany i usunięty,
bo polskie zdanie potrafi nie mieć ani jednego diakrytyku.

**Rachunek jest w sekundach, nie w wywołaniach** — drugi raz w potoku i z innego powodu niż
w etapie 9. Cennik dostawcy wygląda na sprzeczny: tabela podaje cenę za minutę, a FAQ mówi
„per generation". To odpowiedzi na dwa pytania — tabela podaje jednostkę **stawki**, FAQ
**moment naliczenia**. Wniosek jest twardy: `--regenerate` to **druga pełna opłata**, nie
dopłata, i raport mówi to tam, gdzie ktoś przeczyta.

**Składa z `episode.mp4` i stemów, nie z `narrated.mp4`.** Miksowanie na narracji kodowałoby
mowę drugi raz i czyniłoby ducking nieuczciwym, bo głos byłby już w sygnale, pod który muzyka
ma ustępować. `narrated.mp4` nie jest ani nadpisywany, ani unieważniany — staje się przyjętym
produktem pośrednim, a etap 10 bramkuje od **zgody** na niego, bo to jedyny dowód, że
narracja siedzi we właściwym miejscu nad tym filmem.

**Poziomy mają własny plik, `projects/<id>/mix.json`.** Nie w `project.json`, z powodu
`narration.json` — i nie w `narration.json`, bo głośność podkładu nie mówi nic o tym, jak
narrator czytał, więc nie może unieważniać nagrań. Wartości startowe są, bo **tej decyzji nie
da się podjąć, zanim się ją usłyszy**; jadą do silnika jawnie i lądują w archiwum.

```bash
pnpm dev sound-design levels dzielna-ewa --music-db -22 --duck-db -12
```

**Werdykt offline kosztuje tu więcej niż w etapie 9.** Ani `/v1/music`, ani
`/v1/sound-generation` nie oferują WAV-a, a ich surowy PCM nie niesie żadnego nagłówka —
liczby kanałów nie dałoby się odczytać z bajtów, a pomyłka podaje długość dwukrotnie złą.
Stemy są więc w MP3, a werdykt **przechodzi po ramkach**: każdy nagłówek deklaruje własny
bitrate, więc strumień zmienny czyta się tak samo dokładnie jak stały. Sto linii zamiast
dwudziestu czterech bajtów — koszt realny i dlatego wypisany.

**Odmowa i meldunek to dwie różne rzeczy.** Efekt wychodzący poza koniec filmu jest odmową
(zderzenie, precedens etapu 7). Podkład kończący się przed filmem jest meldunkiem (dziura,
precedens etapu 8) — klipy wróciły dłuższe niż plan, a odmowa z powodu, którego nikt niżej
nie naprawi, byłaby odmową bez wyjścia.

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
