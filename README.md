# aimator

CLI, które prowadzi jedną osobę przez produkcję krótkiej animacji: od pomysłu, przez
scenariusz i assety, po gotowy film sklejony z klipów.

## Co to potrafi dzisiaj

- **Prowadzi całą produkcję od pomysłu do zmontowanego filmu z dźwiękiem.** Jedenaście
  etapów, z których każdy zostawia na dysku plik, który można obejrzeć, odrzucić
  i wygenerować ponownie.
- **Robi dwie wersje tej samej historii naraz.** Artefakty są grupowane per projekt
  i **per model obrazu**: jeden projekt może mieć komplet assetów w `gpt-image`
  i w `seedream`. To dwa niezależne byty dające dwie różne animacje z tego samego
  scenariusza.
- **Oddaje film w trzech wersjach**, z których każda nosi własną zgodę: `episode.mp4` to
  nieme cięcie obrazu, `narrated.mp4` dokłada narrację i jest jedynym miejscem, gdzie
  słychać samo jej umieszczenie, a `mixed.mp4` ma wszystko.
- **Nigdy nie wydaje pieniędzy po cichu.** Każde płatne polecenie ma `--dry-run`, który
  pokazuje pełny prompt bez sięgania po klucz, i mówi, ile wywołań wykona, zanim je
  wykona.

Tryby dźwięku, które ten proces obsługuje w całości, to `music-and-effects` i `narration`.

**„Krótka" znaczy tu kilkanaście minut.** `--duration` przyjmuje formalnie do 3600 s, ale
praktyczna granica leży niżej i bierze się stąd, że etapy 1, 3 i 4 mieszczą **cały film
w jednej odpowiedzi modelu**. Lista ujęć zużywa około 259 znaków na sekundę filmu, więc przy
modelu z oknem wyjścia 64k tokenów wychodzi z tego mniej więcej 14 minut, a przy 32k około
siedmiu. Co musiałoby się zmienić, żeby dało się robić filmy godzinne, rozpisuje
[issue #1](https://github.com/auditmos/aimator/issues/1).

## Podejście

Produkcja jest rozbita na etapy, a **każdy etap konsumuje wyłącznie pliki wyprodukowane
przez wcześniejsze, nigdy kontekstu rozmowy.** To jest cała idea: rozmowa znika, plik
zostaje, więc każdy krok da się powtórzyć, obejrzeć i cofnąć.

```
sesja pytań → scenariusz → postać → lista ujęć → pakiet promptów →
referencje → klatka otwarcia → klipy → montaż → narracja → muzyka i efekty
```

Diagram tych samych jedenastu etapów, rozłożonych na preprodukcję, zdjęcia i postprodukcję,
razem z opisem, czego każdy etap potrzebuje i co oddaje, jest w
[docs/jak-to-powstaje.md](docs/jak-to-powstaje.md). To strona dla osoby, która zna produkcję
wideo i nie musi znać kodu.

Trzy rzeczy, które ten układ wymusza:

- **Walidacja to nie akceptacja.** `check` sprawdza pliki i niczego nie zapisuje. Dopiero
  `approve` jest miejscem, w którym człowiek mówi „tak" i wiąże tę zgodę z bajtami.
  Zmiana pliku poza narzędziem unieważnia akceptację, a `check` to zgłasza.
- **Zgoda jest bramką, nie formalnością.** Następny etap nie rusza, dopóki poprzedni nie
  ma zgody. Kolejny płatny obraz kupuje się więc dopiero wtedy, gdy poprzedni został
  obejrzany.
- **Decyzja bez wartości domyślnej jest zapisywana, nigdy zgadywana.** Brak pliku, pusty
  katalog albo brakująca flaga znaczą „nikt jeszcze nie zdecydował" i bramka blokuje.

## Etapy

Każdy wiersz linkuje do komend tego etapu. Pełny kontrakt, czyli niezmienniki, kształt
plików stanu i szczegóły walidacji, jest w [docs/pipeline.md](docs/pipeline.md).

| Etap | Na wejściu | Na wyjściu | Koszt |
|---|---|---|---|
| [0. przygotowanie](docs/stages/00-przygotowanie.md) | Twój pomysł, plik źródłowy odcinka, zdjęcia postaci | zasady projektu, obsada, decyzje odcinka | darmowy |
| [1. scenariusz](docs/stages/01-scenariusz.md) | zasady projektu + plik źródłowy | `screenplay.md`: sceny z czasami | 1 wywołanie tekstowe |
| [2. postać](docs/stages/02-postac.md) | zasady projektu, zdjęcia albo opis postaci | karta, 8 widoków, `hero.png` per postać i tor | do 10 obrazów |
| [3. lista ujęć](docs/stages/03-lista-ujec.md) | zatwierdzony scenariusz | `shot-list.md`: sceny, ujęcia i klipy | 1 wywołanie tekstowe |
| [4. pakiet promptów](docs/stages/04-pakiet-promptow.md) | zatwierdzona lista ujęć + `hero.png` na obu torach | jeden plik promptu na każde przyszłe wywołanie | 1 wywołanie tekstowe |
| [5. referencje](docs/stages/05-referencje.md) | zatwierdzony pakiet promptów | `references/Rxx.png`: miejsca, przedmioty, twarze widziane raz | kilka obrazów |
| [6. klatka otwarcia](docs/stages/06-klatka-otwarcia.md) | zatwierdzone referencje tego kadru | `opening-frame.png`: pierwsza klatka filmu | 1 obraz |
| [7. klipy](docs/stages/07-klipy.md) | zatwierdzona klatka poprzednika | `clips/Cxx.mp4` + klatki wejściowe i końcowe | obrazy **i** wideo |
| [8. montaż](docs/stages/08-montaz.md) | wszystkie zatwierdzone klipy tego toru | `episode.mp4`: nieme cięcie obrazu | darmowy (ffmpeg) |
| [9. narracja](docs/stages/09-narracja.md) | zatwierdzona lista ujęć, obsadzony głos, zatwierdzony montaż | `narration/Nnn.wav` + `narrated.mp4` | rozliczany w znakach |
| [10. muzyka i efekty](docs/stages/10-muzyka-i-efekty.md) | zatwierdzona lista ujęć, zatwierdzony `narrated.mp4` | `sound/*.mp3` + `mixed.mp4`: film ze wszystkim | rozliczany w sekundach |

Etapy tekstowe (1, 3, 4) są **wspólne dla obu torów**, bo opisują historię, a nie obrazy.
Rozejście zaczyna się przy pierwszym obrazie odcinka i kończy dwiema niezależnymi
animacjami.

Dwa etapy mogą biec równolegle: [2. postać](docs/stages/02-postac.md) nie zależy od
[1. scenariusza](docs/stages/01-scenariusz.md), bo postać opisuje projekt, a nie odcinek.

## Start

Wymagania:

- [Node.js](https://nodejs.org/) >= 22 i [pnpm](https://pnpm.io/)
- [ffmpeg](https://ffmpeg.org/) dla etapów 8, 9 i 10. Skleja klipy, kładzie na nich
  narrację i składa pełną ścieżkę, za każdym razem kopiując obraz bez przekodowania; gdy
  go nie ma, te etapy odmawiają zamiast szukać objazdu. Reszta narzędzia, razem z `check`,
  działa bez niego, bo werdykty czytają pudełka MP4, nagłówki RIFF i ramki MP3, nie wołają
  dekodera.

```bash
pnpm install
cp .env.example .env
```

Ustaw `AIMATOR_WORKSPACE` i modele. Pełna lista zmiennych, z uzasadnieniem każdej, jest
w [docs/konfiguracja.md](docs/konfiguracja.md).

Potem zacznij od [etapu 0](docs/stages/00-przygotowanie.md), najlepiej skillem:

```
/prepare-project
```

## Zasady, na których stoi całe narzędzie

- Każdy etap konsumuje wyłącznie artefakty wytworzone przez wcześniejsze etapy, nigdy
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

## Rozwój

| Polecenie | Opis |
|---------|-------------|
| `pnpm build` | Build tsup (ESM + deklaracje) |
| `pnpm dev` | Uruchom CLI ze źródeł przez tsx, bez budowania |
| `pnpm lint` | Sprawdź kod Biome |
| `pnpm lint:fix` | Napraw lint i formatowanie |
| `pnpm types` | Sprawdź typy: `src`, configi w roocie i klient UI |
| `pnpm test` | Testy Vitest |
| `pnpm test:watch` | Testy w trybie watch |
| `pnpm unused` | Nieużywany kod (Knip) |
| `pnpm ui` | Lokalne UI nad CLI: drabina etapów w przeglądarce, tylko na localhost |
| `pnpm update` | Interaktywna aktualizacja zależności (Taze) |
| `pnpm site:freeze` | Zamroź odcinek z workspace jako nowe wydanie strony |
| `pnpm site:build` | Zbuduj stronę wydań do `out/site` |
| `pnpm site:media` | Wyślij filmy i obrazy wydania do R2 |
| `pnpm site:preview` | Zbuduj i podejrzyj stronę lokalnie |
| `pnpm site:deploy` | Zbuduj, wyślij media i opublikuj na `aimator.auditmos.com` |

`pnpm dev` używa `tsx`, a nie natywnego strippingu typów w Node, bo rozdzielczość
`Node16` w TypeScripcie zapisuje specyfikatory `.js`, których Node nie zmapuje z powrotem
na pliki `.ts`.

Kod trzyma się **głębokich modułów** (Ousterhout): wąski interfejs nad dużą implementacją.
Domena zaczyna jako jeden plik `src/lib/{domena}.ts`, a gdy urośnie o wewnętrzne części,
staje się katalogiem z `index.ts` jako jedynym wejściem. `src/bin.ts` jest celowo cienką
nakładką, bo całe zachowanie siedzi w `src/cli.ts` jako `run(argv): Promise<Result<string>>`,
dzięki czemu CLI testuje się wywołaniem funkcji, a nie uruchamianiem procesu.

Pełne zasady, czyli granice, ścieżka wzrostu i egzekwowanie, są w [AGENTS.md](AGENTS.md).

Praca nad kodem: testy leżą obok źródeł (`*.test.ts`), TDD (czerwony test → minimalny kod
→ refaktor), commity w formacie [Conventional Commits](https://www.conventionalcommits.org/),
hook pre-commit uruchamia lint i testy, push na `main` odpala CI i semantic-release.

Stan odcinka można też oglądać w przeglądarce: `pnpm ui` podnosi lokalny serwer, który
każdą odpowiedź bierze z tego samego `run(argv)`, co terminal, i odświeża drabinę, gdy coś
w katalogu roboczym się zmieni. Co pokazuje i czego świadomie nie robi, opisuje
[docs/ui.md](docs/ui.md).

Wersja opisuje narzędzie, a nie stronę: commity z zakresem `site` i `ui`, tak samo jak
`docs`, `chore`, `ci` i `test`, nie wydają nic. Odcinek na stronie ma własny numer w
`site/releases/`, nadawany przez `pnpm site:freeze`, i te dwie numeracje mogą się
rozjeżdżać.

Gotowe odcinki pokazuje [aimator.auditmos.com](https://aimator.auditmos.com/): jeden film
na tor obrazu, razem z klatką otwarcia, referencjami i dokumentami etapów. Jak dodać
wydanie i co wolno na nim opublikować, opisuje [docs/strona.md](docs/strona.md).

Skille: `/develop-series` (rozwinięcie pomysłu), `/prepare-project` (etap 0),
`/environment-variables` (zmienne środowiskowe), `/bugfix` (najpierw test odtwarzający
błąd). Szczegóły w [HOWTO.md](HOWTO.md).
