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
    ├── project.json                  identyfikator, tytuł, proporcje, materiały postaci
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
        ├── shot-list.md              │ etapy tekstowe — wspólne dla obu torów
        ├── prompt-package.json       │
        ├── prompts/                  ┘ opening-frame.md, references/, clips/, entry-frames/
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

Katalogi torów powstają dopiero wtedy, gdy jakiś etap do nich pisze. Pusty katalog jest
obietnicą, której narzędzie nie dotrzymuje.

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
      "producedAt": "2026-09-17T17:02:33.412Z",
      "producer": { "kind": "manual", "tool": "aimator" },
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

Ścieżki w artefaktach są **względne wobec katalogu roboczego**, więc całe drzewo można
przenieść. `originPath` w `project.json` i `episode.json` jest bezwzględny, bo wskazuje
plik spoza katalogu roboczego — jedyne miejsce, gdzie to ma sens.

`project.json` i `episode.json` trzymają wyłącznie treść; pochodzenie i ocena są w pliku
etapu. `project.md` celowo **nie ma** zapisanego hasha: pisze go człowiek po `init`, więc
hash z chwili utworzenia byłby z założenia nieaktualny. Każdy etap zapisuje hashe swoich
własnych wejść w chwili, gdy je konsumuje.

## Niezmienniki

Obowiązują we wszystkich etapach.

- **Ocena kreatywna jest osobna od walidacji.** Plik, który powstał, nie jest plikiem
  przyjętym. Przejście walidacji nie jest akceptacją.
- **Akceptacja jest związana z bajtami.** `review.status` dotyczy konkretnych
  `outputs[].sha256`. Zmiana pliku unieważnia akceptację; nie ma sposobu, by przeniosła
  się na inny wynik.
- **`needsReview` nigdy nie czyści się samo.** Wpisuje go etap zależny w chwili
  uruchomienia. `check` tylko raportuje rozjazd — polecenie kontrolne niczego nie zapisuje.
- **Stan `submitted` zapisuje się przed płatnym POST-em**, więc przerwane wywołanie
  wznawia się przez odpytanie zapisanego identyfikatora zadania, a nie przez drugą opłatę.
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
| 0 przygotowanie | pomysł użytkownika, plik źródłowy odcinka, zdjęcia postaci | `project.md`, `project.json`, `source.md`, `episode.json`, `character/sources/` | `aimator check` | **zaimplementowany** |
| 1 scenariusz | `project.md`, `source.md`, `episode.json` | `screenplay.md` | ocena użytkownika | niezaimplementowany |
| 2 postać | `character/sources/`, zasady projektu | `card.png` → 8 widoków → `hero.png`, per tor | ocena każdego obrazu | niezaimplementowany |
| 3 lista ujęć | `screenplay.md` | `shot-list.md` | ocena użytkownika | niezaimplementowany |
| 4 pakiet promptów | `shot-list.md`, zatwierdzony `hero.png` | `prompt-package.json`, `prompts/**` | ocena pakietu | niezaimplementowany |
| 5 obrazy referencyjne | pakiet, zatwierdzone zależności `dependsOn` | `<tor>/references/Rxx.png` | ocena każdego obrazu | niezaimplementowany |
| 6 pierwsza klatka | pakiet, zatwierdzone referencje otwarcia | `<tor>/opening-frame.png` | ocena kadru | niezaimplementowany |
| 7 klipy | pakiet, zatwierdzone referencje i klatka, zatwierdzona końcówka poprzednika | `<tor>/clips/Cxx.mp4`, `<tor>/frames/Cxx/` | ocena klipu i klatek | niezaimplementowany |
| 8 montaż | zatwierdzone klipy, `edit-plan.json` | `<tor>/episode.mp4` | ocena całości | niezaimplementowany |

Etapy 1–8 są **zadeklarowanym kontraktem**, nie działającym kodem. Wiersze istnieją po to,
żeby kolejne kroki wpinały się w ustalony układ zamiast wymyślać własny.

## Etap 0 — szczegóły

Jedyny etap, który legalnie wciąga materiał spoza katalogu roboczego. Właśnie dlatego
kopiuje te bajty do środka i zapisuje ich hash: od tego miejsca każdy etap konsumuje
artefakt wytworzony przez poprzedni.

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
`TODO(etap-0)`, `aspectRatio` jest ustalone, hashe wyników się zgadzają i żadne z pięciu
pól nie jest `null`.
