# Import materiału z Worda

Gdy seria albo odcinek istnieje już jako dokument, np. treatment reżyserski w `.docx`,
import zamienia go na Markdown i osobne obrazy, zanim powstanie jakikolwiek projekt.
Import niczego nie rozstrzyga i nie zakłada projektu. Leży obok projektów, w
`imports/<id>/`, więc można go powtórzyć albo wyrzucić bez cofania czyjejkolwiek zgody.
Konwersja jest darmowa; płatny jest tylko podział na serię, styl, postacie i odcinki,
w którym model jedynie wskazuje, dokąd idzie każda sekcja. Co z tego trafi do projektu,
decyduje etap 0.

## Komendy

```bash
aimator import add <id> --source <plik.docx> --dry-run   # co powstanie, nic nie zapisuje
aimator import add <id> --source <plik.docx>             # kopia i konwersja
aimator import show <id>                                 # sekcje, obrazy, podział, uwagi
aimator import group <id> --dry-run                      # prompt i rachunek, nic nie wysyła
aimator import group <id>                                # płatny podział materiału
aimator import list                                      # importy i liczba plików podziału
```

Każda przyjmuje `--json` i wypisuje wtedy ten sam obiekt, który renderuje tekst. Import
się nie nadpisuje: druga próba z tym samym dokumentem to nowy identyfikator.

## Co powstaje

```
imports/<id>/
├── source.docx          dokument, skopiowany bajt w bajt
├── material.md          cały dokument jako Markdown, obrazy w miejscu, w którym stały
├── images/I01.png …     obrazy w bajtach, w których dokument je trzymał
├── import.json          skąd przyszedł dokument, jego sha256, obrazy i uwagi z konwersji
├── import.stage.json    rekord konwersji: wejście, wyjścia i ich skróty
├── grouped/             dopiero po import group
│   ├── series.md, style.md, other.md
│   ├── characters/<id>.md
│   ├── episodes/NN-slug.md
│   └── import.stage.json   rekord podziału: material.md, z którego go zrobiono, i pliki
└── runs/<run-id>/       archiwum płatnej próby: prompt, zapytanie, odpowiedź, werdykt
```

- **Nagłówki** zostają nagłówkami. Tytuł dokumentu to `#`, „Nagłówek 1” to `##` i tak
  dalej; bez stylu Tytuł „Nagłówek 1” to `#`. Styl rozpoznaje się po angielskiej nazwie,
  bo polski Word nadaje mu identyfikator `Nagwek1`.
- **Pogrubienia i kursywa**, **listy** (wypunktowane i numerowane, z wcięciem),
  **tabele** i **linki** przechodzą do Markdownu.
- **Obraz** dostaje identyfikator `I01`, `I02` w kolejności pierwszego pojawienia się
  i rozszerzenie swojego formatu. Ten sam obraz pokazany dwa razy to jeden plik.

## Sekcje

`import show` tnie `material.md` na każdym nagłówku: `T01`, `T02` w kolejności dokumentu,
każda z tytułem, długością tekstu i obrazami, które pokazuje. To, co stoi przed pierwszym
nagłówkiem, jest osobną sekcją bez tytułu.

Sekcje nie są nigdzie zapisane. Są liczone z obecnego `material.md` przy każdym
wywołaniu, więc ręczna poprawka pliku (np. brakujący nagłówek) od razu je przelicza, a
`import show` mówi, że plik zmieniono po imporcie.

## Podział: `import group`

Jedno płatne wywołanie modelu tekstowego, wybranego przez `--model` albo
`AIMATOR_IMPORT_MODEL` ([konfiguracja](konfiguracja.md)). Model dostaje sekcje
dosłownie i odpowiada wyłącznie identyfikatorami: dla każdej sekcji jeden lub kilka
przydziałów (`series`, `style`, `character:<id>`, `episode:NN-slug` albo `other`) oraz
listę postaci z imieniem przepisanym z tekstu. Nie pisze ani słowa: każdy plik w
`grouped/` to sekcje skopiowane z `material.md` w kolejności dokumentu, a zmieniają się
w nich tylko linki do obrazów, żeby nadal działały. Model nie widzi obrazów, więc obraz
idzie z sekcją, w której stoi.

Odpowiedź, której nie da się w całości sprawdzić z materiałem, nie zostaje opublikowana:

- każda sekcja ma co najmniej jeden przydział, żadna nie występuje dwa razy i żadnej
  spoza materiału,
- `other` stoi sam,
- każda postać ma przypisaną sekcję, a jej imię występuje w którejś z nich dosłownie,
- odcinki są numerowane od `01` w kolejności, w jakiej pojawiają się w dokumencie;
  numery to propozycja, którą potwierdza etap 0.

Odrzucona odpowiedź zostaje w `runs/`, więc poprawiony walidator wyda werdykt za darmo.
Podziału nikt nie zatwierdza: to propozycja, którą `/prepare-project` czyta razem z
człowiekiem. Nowy podział kupuje `--regenerate`, z `--instruction "<uwaga>"` poprawia
poprzedni, a `--republish` publikuje zapisaną odpowiedź jeszcze raz, niczego nie
wysyłając i nie nadpisując pliku poprawionego ręcznie. Gdy `material.md` zmieni się po
podziale, `import show` o tym mówi.

Imienia postaci podział nigdzie nie zapisuje osobno: `import show` czyta je z jej pliku,
szukając pierwszych słów, które po zdjęciu polskich znaków i wielkich liter dają jej
identyfikator (`Dżdżownica` to `dzdzownica`). To propozycja dla `character new`, nie
decyzja: gdy plik po poprawce ręcznej już takich słów nie ma, imienia brak i trzeba je
wpisać.

## Czego konwerter odmawia

Żaden fragment tekstu nie może zginąć po cichu. Jeśli w treści dokumentu jest tekst,
którego konwerter nie umie umieścić w Markdownie, cały import zostaje odrzucony, zanim
cokolwiek zapisze, a komunikat cytuje ten tekst. Tak samo kończą się:

- pole tekstowe i przypisy (ich treść trzeba przenieść do zwykłego tekstu),
- niewidoczny znak sterujący (np. `U+001B`), który terminal wykonałby zamiast wypisać:
  Word takich nie zapisuje, więc komunikat podaje kod znaku i tekst tuż przed nim,
- plik, który nie jest `.docx`, zaszyfrowany albo uszkodzony (zła suma kontrolna części),
- dokument za duży: ponad 2 GiB po rozpakowaniu, część ponad 512 MiB, część XML ponad
  64 MiB albo ponad 2 mln węzłów XML. Limity sprawdza się przed rozpakowaniem, więc
  dokument spreparowany na „bombę ZIP” kończy się odmową, nie zajętą pamięcią.

## Co konwerter pomija i mówi o tym

Nagłówki i stopki stron, komentarze recenzenta oraz kształty bez obrazu (np. wykres) nie
są materiałem, więc nie trafiają do `material.md`. Każde takie pominięcie trafia do uwag,
które wypisuje i `import add`, i każde późniejsze `import show`.

## Dalej

Przeczytaj `material.md` i popraw to, co konwersja oddała źle, potem obejrzyj
`import group <id> --dry-run` i kup podział. Projekt z tego materiału zakłada etap 0,
najwygodniej skillem `/prepare-project` ([etap 0](stages/00-przygotowanie.md)) albo
w lokalnym UI. Zasady wspólne mogą zacząć od płatnego szkicu z podziału:
`project draft <projekt> --import <id>` ([szkic zasad](stages/00-przygotowanie.md#szkic-zasad-z-importu)).
