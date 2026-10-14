# Import materiału z Worda

Gdy seria albo odcinek istnieje już jako dokument, np. treatment reżyserski w `.docx`,
import zamienia go na Markdown i osobne obrazy, zanim powstanie jakikolwiek projekt.
Import jest darmowy, niczego nie rozstrzyga i nie zakłada projektu. Leży obok projektów,
w `imports/<id>/`, więc można go powtórzyć albo wyrzucić bez cofania czyjejkolwiek zgody.
Co z materiału trafi do serii, postaci i odcinków, decyduje etap 0.

## Komendy

```bash
aimator import add <id> --source <plik.docx> --dry-run   # co powstanie, nic nie zapisuje
aimator import add <id> --source <plik.docx>             # kopia i konwersja
aimator import show <id>                                 # sekcje, obrazy, uwagi
aimator import list                                      # identyfikatory importów
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
└── import.stage.json    rekord: wejście, wyjścia i ich skróty
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

Przeczytaj `material.md` i popraw to, co konwersja oddała źle. Projekt z tego materiału
zakłada etap 0, najwygodniej skillem `/prepare-project`
([etap 0](stages/00-przygotowanie.md)).
