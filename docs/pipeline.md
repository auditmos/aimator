# Kontrakt etapów

Ten dokument opisuje **stan bieżący** kontraktu, w czasie teraźniejszym. Nie ma tu
wpisów z datami, sekcji „zmiany" ani dziennika postępów: zmiana kontraktu to przepisanie
tego pliku, a historię trzyma `git log`. Stan konkretnej produkcji czyta się z plików
`*.stage.json` w katalogu roboczym, nigdy z dokumentu.

## Układ katalogów

Artefakty leżą poza repozytorium, w katalogu z `AIMATOR_WORKSPACE`.

```
$AIMATOR_WORKSPACE/
└── projects/<project-id>/
    ├── project.json                  identyfikator, tytuł, proporcje, podstawa postaci
    ├── project.md                    zasady wspólne — jedyny plik pisany ręcznie
    ├── prepare.stage.json
    ├── character/
    │   ├── sources/                  zdjęcia użytkownika (etap 0)
    │   ├── gpt-image/                card.png, views/, hero.png, character.stage.json
    │   └── seedream/                 to samo, niezależnie
    └── episodes/<episode-id>/
        ├── source.md                 kopia bajtowa źródła (etap 0)
        ├── episode.json              pięć decyzji odcinka
        ├── prepare.stage.json
        ├── screenplay.md             ┐
        ├── screenplay.stage.json     │
        ├── shot-list.md              │ etapy tekstowe — wspólne dla obu torów
        ├── prompt-package.json       │
        ├── prompts/                  ┘ opening-frame.md, references/, clips/, entry-frames/
        ├── runs/<runId>/             archiwum prób etapów tekstowych
        ├── gpt-image/                ┐ references/, opening-frame.png, clips/, frames/,
        └── seedream/                 ┘ edit-plan.json, episode.mp4, runs/
```

Trzy reguły, które ten układ egzekwuje:

1. **Tor modelu to poziom katalogu, nigdy prefiks nazwy.** Nie ma `byteplus-images/`
   obok `references/`; jest `gpt-image/references/` i `seedream/references/`. Izolacja
   torów jest darmowa, więc nie trzeba nigdy doklejać równoległego drzewa.
2. **Etapy tekstowe są wspólne, obrazowe i wideo — per tor.** Scenariusz, lista ujęć
   i pakiet promptów opisują historię, nie obrazy. Rozejście zaczyna się przy pierwszym
   obrazie i kończy dwiema niezależnymi animacjami z tej samej historii.
3. **Ścieżki zna wyłącznie `src/lib/workspace.ts`.** Żaden inny moduł nie składa ścieżek.

Katalog powstaje dopiero wtedy, gdy jakiś etap do niego pisze — dotyczy to zarówno torów
modelowych, jak i `character/sources/` czy `episodes/`. Pusty katalog jest obietnicą,
której narzędzie nie dotrzymuje.

**Zasady projektu są wejściem każdego etapu.** `project.json` i `project.md` leżą poza
tabelą poniżej, bo czyta je wszystko: proporcje obrazu, podstawa postaci i zasady wspólne
nie mają innej drogi do etapów, które ich potrzebują. Oba są artefaktami etapu 0, więc
reguła „każdy etap konsumuje wyłącznie artefakty wcześniejszych etapów" pozostaje spełniona.

## Plik etapu

Jeden plik na etap, `<etap>.stage.json`, na tym poziomie katalogu, do którego etap pisze.
Jeden kształt dla wszystkich etapów. Klucz `artifacts` pozwala objąć zbiór wyników
(R01–R10, C01–C06) bez mnożenia plików.

```jsonc
{
  "version": 1,
  "stage": "prepare",
  "artifacts": {
    "episode": {
      "runId": "20260917T170233Z-a1b2c3d4",
      "status": "completed",
      "jobId": null,
      "producedAt": "2026-09-17T17:02:33.412Z",
      "producer": {
        "kind": "manual",
        "tool": "aimator",
        "endpoint": null,
        "model": null,
        "promptVersion": null
      },
      "inputs": [],
      "outputs": [
        { "path": "projects/demo/episodes/01-tytul/source.md", "sha256": "6ba5…" },
        { "path": "projects/demo/episodes/01-tytul/episode.json", "sha256": "4ab1…" }
      ],
      "review": { "status": "pending", "reviewer": null, "reviewedAt": null, "note": null },
      "needsReview": []
    }
  }
}
```

`stage` przyjmuje nazwę dowolnego etapu z tabeli poniżej i wyznacza nazwę pliku.
`status` opisuje próbę, nie ocenę: `submitted` zapisuje się **przed** płatnym POST-em,
`completed` dopiero wtedy, gdy wynik przeszedł walidację i został opublikowany. Rekord
etapu ręcznego jest ukończony z konstrukcji, bo nie stoi za nim żadne wywołanie.
`producer` przy etapie płatnym zapisuje endpoint, identyfikator modelu i **jawną wersję
promptu** — nie hash pliku źródłowego, bo hash zmienia się od przeformatowania komentarza
i nie mówi nic o tym, czy instrukcja się zmieniła.

Ścieżki w artefaktach są **względne wobec katalogu roboczego**, więc całe drzewo można
przenieść. `originPath` w `project.json` i `episode.json` jest bezwzględny, bo wskazuje
plik spoza katalogu roboczego — jedyne miejsce, gdzie to ma sens.

`project.json` i `episode.json` trzymają wyłącznie treść; pochodzenie i ocena są w pliku
etapu. `project.md` nie ma hasha od chwili `init`, bo pisze go wtedy człowiek i hash pustego
szkieletu byłby z założenia nieaktualny — dostaje go dopiero przy `aimator approve`, czyli
w momencie, w którym ktoś przyjmuje zasady w takim kształcie, w jakim leżą. Od tej chwili
każda edycja `project.md` unieważnia akceptację i `check` to zgłasza — ale **nie jest to
błąd walidacji**, tylko wygaśnięcie zgody, dokładnie jak przy zmianie decyzji odcinka.
Pliki nadal się zgadzają, po prostu tych bajtów nikt jeszcze nie przyjął, więc `approve`
działa i zapisuje nowy hash. Gdyby liczyć to jako błąd walidacji, `approve` odmawiałby
w jedynym miejscu, które potrafi tę sytuację naprawić, i projekt zostawałby zablokowany
na zawsze. Każdy etap zapisuje hashe swoich własnych wejść w chwili, gdy je konsumuje.

## Niezmienniki

Obowiązują we wszystkich etapach.

- **Ocena kreatywna jest osobna od walidacji.** Plik, który powstał, nie jest plikiem
  przyjętym. Przejście walidacji nie jest akceptacją — akceptację zapisuje wyłącznie jawne
  `aimator approve`, z zakresem etapu w `--stage`, nigdy polecenie kontrolne.
- **Akceptacja jest związana z bajtami.** `review.status` dotyczy konkretnych
  `outputs[].sha256`. Zmiana pliku unieważnia akceptację; nie ma sposobu, by przeniosła
  się na inny wynik. Ponowny zapis pliku etapu przywraca `pending` i mówi o tym wprost.
- **Nie akceptuje się tego, co nie przechodzi walidacji.** `approve` odmawia, dopóki hashe
  się nie zgadzają albo brakuje decyzji: akceptacja zapisana na zepsutym pochodzeniu byłaby
  kłamstwem, któremu kolejne etapy zaufałyby.
- **`needsReview` nigdy nie czyści się samo.** Wpisuje go etap zależny w chwili
  uruchomienia. `check` tylko raportuje rozjazd — polecenie kontrolne niczego nie zapisuje.
- **Stan `submitted` zapisuje się przed płatnym POST-em.** Przerwana próba zostawia więc
  ślad mówiący, że opłata mogła już paść, zamiast wyglądać na niebyłą. Czy da się ją
  wznowić bez drugiej opłaty, zależy od dostawcy: tam, gdzie zadanie jest przechowywane,
  wznawia się przez zapisany identyfikator; tam, gdzie nie jest — jak przy `store: false`
  w etapie 1 — odpowiedź istnieje tylko wtedy, gdy zdążyła trafić na dysk, a poza tym
  jedyną drogą dalej jest jawne `--regenerate`. Narzędzie mówi to wprost, zamiast
  milcząco płacić drugi raz.
- **Nic nie ponawia się automatycznie.** Nową płatną próbę zaczyna wyłącznie jawne
  `--regenerate`, zachowując poprzedni wynik.
- **Każde polecenie zapisujące ma `--dry-run`** — pełna walidacja, bez sieci, sekretów
  i zapisów.
- **Każdy etap konsumuje wyłącznie artefakty wytworzone przez wcześniejsze etapy**, nigdy
  kontekstu rozmowy ani ponownego odczytu surowego opisu. Ustawienia podróżują razem
  z artefaktem, żeby następny etap miał kompletne wejście.
- **Archiwum próby nie kopiuje wejść.** `runs/<runId>/` przechowuje tylko to, czego nie
  da się odtworzyć: wysłany request, dokładny prompt, odpowiedź, wynik walidacji, status
  HTTP i identyfikator zadania. Wejścia są referowane przez ścieżkę i sha256. Poprzedni
  wynik kopiuje się wyłącznie przy `--regenerate`.

## Etapy

| Etap | Konsumuje | Produkuje | Bramka | Stan |
|---|---|---|---|---|
| 0 przygotowanie | pomysł użytkownika, plik źródłowy odcinka, zdjęcia postaci | `project.md`, `project.json`, `source.md`, `episode.json`, `character/sources/` | `aimator check`, potem `aimator approve` | **zaimplementowany** |
| 1 scenariusz | `project.json`, `project.md`, `source.md`, `episode.json` | `screenplay.md`, `screenplay.stage.json`, `runs/<runId>/` | zatwierdzony etap 0 przed wywołaniem; potem `aimator check`, `aimator approve … --stage screenplay` | **zaimplementowany** |
| 2 postać | `characterBasis`: `character/sources/` albo opis wyglądu z `project.md` | `card.png` → 8 widoków → `hero.png`, per tor | ocena każdego obrazu | niezaimplementowany |
| 3 lista ujęć | `screenplay.md` | `shot-list.md` | ocena użytkownika | niezaimplementowany |
| 4 pakiet promptów | `shot-list.md`, zatwierdzony `hero.png` | `prompt-package.json`, `prompts/**` | ocena pakietu | niezaimplementowany |
| 5 obrazy referencyjne | pakiet, zatwierdzone zależności `dependsOn` | `<tor>/references/Rxx.png` | ocena każdego obrazu | niezaimplementowany |
| 6 pierwsza klatka | pakiet, zatwierdzone referencje otwarcia | `<tor>/opening-frame.png` | ocena kadru | niezaimplementowany |
| 7 klipy | pakiet, zatwierdzone referencje i klatka, zatwierdzona końcówka poprzednika | `<tor>/clips/Cxx.mp4`, `<tor>/frames/Cxx/` | ocena klipu i klatek | niezaimplementowany |
| 8 montaż | zatwierdzone klipy, `edit-plan.json` | `<tor>/episode.mp4` | ocena całości | niezaimplementowany |

Etapy 2–8 są **zadeklarowanym kontraktem**, nie działającym kodem. Wiersze istnieją po to,
żeby kolejne kroki wpinały się w ustalony układ zamiast wymyślać własny.

## Etap 0 — szczegóły

Jedyny etap, który legalnie wciąga materiał spoza katalogu roboczego. Właśnie dlatego
kopiuje te bajty do środka i zapisuje ich hash: od tego miejsca każdy etap konsumuje
artefakt wytworzony przez poprzedni.

Przed etapem 0 może odbyć się sesja rozwinięcia pomysłu (skill `develop-series`). **Nie
jest etapem i nie ma własnego pliku stanu**, bo nie wytwarza artefaktu — kończy się
przekazaniem decyzji do etapu 0, który jako jedyny je zapisuje. Nie dodawaj
`develop.stage.json`.

Dwie decyzje projektu — obie jawne, obie bez wartości domyślnej:

| Pole | Wartość |
|---|---|
| `aspectRatio` | np. `16:9`; po powstaniu obrazów nie da się zmienić bez ich unieważnienia |
| `characterBasis` | `photographs` albo `description` — skąd etap postaci bierze wygląd |

`characterBasis` istnieje, bo pusty `character/sources/` nie odróżnia „świadomie bez zdjęć"
od „jeszcze nie dodane". Przy `photographs` bramka blokuje, dopóki nie ma ani jednego
zdjęcia. Przy `description` jedynym wejściem etapu postaci jest opis wyglądu w `project.md`
— i wtedy to on musi być konkretny, bo nic dalej go nie uzupełni. Dodanie zdjęcia przez
`character add` samo w sobie jest deklaracją i przestawia pole na `photographs`.

Pięć decyzji odcinka — wszystkie jawne, żadna z domyślną wartością:

| Pole | Wartość |
|---|---|
| `durationSeconds` | liczba całkowita 1–3600 |
| `audio` | `music-and-effects`, `dialogue`, `narration`, `dialogue-and-narration` — wszystkie zawierają muzykę i efekty |
| `language` | kod języka scenariusza i wypowiedzi; wymagany także w filmie bez mowy |
| `subtitles` | kod języka albo `none`; niezależny od `language` |
| `sourceNature` | `law-or-idea`, `synopsis`, `screenplay` — etap 1 rozgałęzia się na tym polu |

Świeży `episode.json` ma wszystkie pięć jako `null` i jest celowo niegotowy do generacji.
Gotowość jest **wyliczana**, nie deklarowana: nie ma pola `status`, które plik mógłby
podać niezgodnie z prawdą. `check` przepuszcza, gdy `project.md` nie zawiera już żadnego
`TODO(etap-0)`, obie decyzje projektu są ustalone, hashe wyników — projektu i odcinków —
zgadzają się, i żadne z pięciu pól nie jest `null`.

`check` niczego nie zapisuje i niczego nie przyjmuje. Etap 0 kończy `aimator approve
<project-id>`, które powtarza całą weryfikację, dopisuje hash `project.md` i ustawia
`review.status` na `approved` we wszystkich plikach etapu — projektu i każdego odcinka —
razem z tym, kto i kiedy to zrobił. Dopiero wtedy `check` odsyła do etapu 1.

## Etap 1 — szczegóły

Pierwszy etap, który wydaje pieniądze, i jedyny, którego wynik jest tekstem napisanym
przez model. Konsumuje wyłącznie artefakty etapu 0 — zasady projektu i proporcje obrazu
z `project.json` i `project.md`, źródło i pięć decyzji z `source.md` i `episode.json` —
i zapisuje hash każdego z nich w chwili, gdy je czyta.

**Bramka przed wydaniem pieniędzy.** `screenplay generate` odmawia płatnego wywołania,
dopóki `prepare.stage.json` projektu **i** odcinka nie mają `review.status = "approved"`,
a hashe ich wyników się zgadzają. Edycja `project.md` po akceptacji unieważnia ją
arytmetycznie i etap 1 znów blokuje. `--dry-run` tej bramki nie omija — raportuje ją jako
przeszkodę, ale i tak pokazuje prompt, bo po to jest podgląd.

**Skąd bierze się model.** `--model <id>`, a bez tej flagi `AIMATOR_SCREENPLAY_MODEL`.
Wartości domyślnej nie ma i nie będzie: model, którego nikt nie wybrał, nie jest decyzją.
Klucz czytany jest wyłącznie na ścieżce płatnej, z `OPENAI_API_KEY`; `--dry-run` nie
sięga po sekret ani po sieć.

**Archiwum próby.** `episodes/<id>/runs/<runId>/` trzyma `prompt.md`, `request.json`,
`response.json`, `transport.json`, `run.json` i `validation.json` — czyli to, czego nie da
się odtworzyć. Wejścia są w `run.json` referowane ścieżką i sha256, nigdy kopiowane. Jeden
katalog `runs/` na odcinek wystarczy wszystkim etapom tekstowym, bo `runId` jest unikalny
i prefiksowany czasem. Poprzedni scenariusz trafia do `previous-screenplay.md` nowej próby
wyłącznie przy `--regenerate`.

**Wywołanie idzie z `store: false`**, więc dostawca nic nie przechowuje i przerwanej próby
nie da się odpytać po identyfikatorze. Rekord ze statusem `submitted` bez zapisanej
odpowiedzi jest więc ślepym zaułkiem: `check` mówi wprost, że próba mogła zostać
rozliczona, i jedyną drogą dalej jest `--regenerate`. Nic nie ponawia się samo.

**Walidacja strukturalna.** Siedem sekcji w ustalonej kolejności, żadnej pustej, nagłówki
`### S01 | 15s | miejsce i pora dnia` numerowane kolejno od S01, każda scena 1–15 s, suma
czasów dokładnie równa `durationSeconds`, w każdej scenie dokładnie jedno niepuste pole
Action, Audio, Text i End state. Przy `subtitles: none` każde pole Text musi brzmieć
`none`; przy zamówionych napisach co najmniej jedno nie może. Minimalna liczba scen,
`ceil(durationSeconds / 15)`, jest **raportowana, nie sprawdzana osobno** — przy twardym
limicie sceny poprawna suma nie da się osiągnąć mniejszą liczbą scen.

**Walidacja to nie akceptacja.** Wynik, który przeszedł walidację, ma
`review.status = "pending"`. Przyjmuje go dopiero
`aimator approve <project-id> <episode-id> --stage screenplay`, i tylko wtedy, gdy hash
`screenplay.md` się zgadza, dokument nadal przechodzi walidację i żadne wejście etapu 0
nie zmieniło się od czasu generacji. `aimator check <project-id> <episode-id>` sprawdza to
samo i nie zapisuje niczego — rozjazd wejść raportuje, `needsReview` wpisze dopiero etap
zależny w chwili uruchomienia.
