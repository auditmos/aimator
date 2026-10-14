# Kolejność pracy: CLI i UI

Kolejność jest jedna. UI pod każdym przyciskiem woła tę samą komendę, którą wpisuje się
w terminalu. Szczegóły etapu są na jego stronie w [docs/stages/](docs/stages/), a kontrakt
w [docs/pipeline.md](docs/pipeline.md).

## Rytm jednego etapu

```bash
pnpm dev status <projekt> <odcinek>                    # gdzie jestem; „Dalej:” mówi, co teraz
pnpm dev <komenda> generate … --dry-run                 # prompt i rachunek, nic nie kupuje
pnpm dev <komenda> generate …                           # płatne wywołanie
pnpm dev check <projekt> <odcinek> --stage <etap>       # walidacja, niczego nie zapisuje
pnpm dev approve <projekt> <odcinek> --stage <etap>     # „tak”: otwiera następny etap
pnpm dev reject <projekt> <odcinek> --stage <etap> --note "<powód>"   # „nie”, z powodem
```

- Etap na torze dostaje `--track gpt-image` albo `--track seedream` i biegnie osobno na
  każdym z nich.
- Poprawka to `--regenerate`, czyli nowa płatna próba. Z `--instruction "<uwaga>"` model
  poprawia poprzednią wersję, zamiast pisać nową. Nic nie ponawia się samo.
- Zainstalowane narzędzie wywołuje się jako `aimator` zamiast `pnpm dev`.

## Etapy po kolei

| Etap | Komenda | `--stage` | Czeka na |
|---|---|---|---|
| [0. przygotowanie](docs/stages/00-przygotowanie.md) | `project init`, `character new`, `character add` albo `describe`, `project style`, `project voice`, `episode add` | `prepare` | nic |
| [1. scenariusz](docs/stages/01-scenariusz.md) | `screenplay generate` | `screenplay` | 0 |
| [2. postać](docs/stages/02-postac.md) | `character generate --track` | `character` | 0; może iść obok 1 |
| [3. lista ujęć](docs/stages/03-lista-ujec.md) | `shot-list generate` | `shot-list` | 1 |
| [4. pakiet promptów](docs/stages/04-pakiet-promptow.md) | `prompt-package generate` | `prompt-package` | 3 i `hero` każdej postaci z kadru, na obu torach |
| [5. referencje](docs/stages/05-referencje.md) | `reference generate --track` | `references` | 4 |
| [6. klatka otwarcia](docs/stages/06-klatka-otwarcia.md) | `opening-frame generate --track` | `opening-frame` | 5 |
| [7. klipy](docs/stages/07-klipy.md) | `clip generate --track` | `clips` | 6, potem klip po klipie |
| [8. montaż](docs/stages/08-montaz.md) | `assembly generate --track` | `assembly` | 7 |
| [9. narracja](docs/stages/09-narracja.md) | `narration generate`, potem `narration mix --track` | `soundtrack` | 3 i głos narratora; miks na 8 |
| [10. muzyka i efekty](docs/stages/10-muzyka-i-efekty.md) | `sound-design generate`, potem `sound-design mix --track` | `sound-design` | 3; miks na 8 oraz 9 i 11, jeśli tryb ich wymaga |
| [11. dialog](docs/stages/11-dialog.md) | `dialogue generate`, `dialogue translate` | `dialogue` | 3 i próbki głosów postaci |
| [12. wersje językowe](docs/stages/12-wersje-jezykowe.md) | `versions faces` → `bind` → `lip-sync` → `final`, każde z `--track` | `versions` | 7, 10, 11 i język ust |

Etap 0 zamyka `approve <projekt>`. W etapie 2 w miejscu `<odcinek>` stoi `<postać>`.

Decyzje po drodze, poza tabelą:

- `style generate --track`: gdy wybrano `project style --generated`. Obrazy stylu są
  potrzebne od etapu 5.
- `character voice`, potem płatne `character sample` i `approve` z `--stage voice`: głos
  postaci, potrzebny w etapie 11.
- `episode lip-sync --language <kod>` albo `--none`: język ust, potrzebny przekładowi
  dialogu i etapowi 12.
- `narration direction` i `sound-design levels`: jak czyta narrator i jak głośno gra
  muzyka. Mają wartości startowe, więc ustawia się je dopiero po odsłuchu.
- `prompt-package show --track`: darmowy podgląd tego, co poleci do modelu.

## Które etapy dźwięku grają

Decyduje `--audio` odcinka. Etap, którego tryb nie potrzebuje, `status` pokazuje jako
„nie dotyczy”.

| `--audio` | Etapy |
|---|---|
| `music-and-effects` | 10 |
| `narration` | 9 → 10 |
| `dialogue` | 11 → 10 → 12 (gdy jest język ust) |
| `dialogue-and-narration` | 9 i 11 → 10 |

## UI

```bash
pnpm ui    # http://127.0.0.1:4317, tylko lokalnie
```

1. **Start**: „Nowy projekt” (`project init`) albo „Wczytaj projekt” (`list`).
2. **Projekt**: stan etapu 0, „Obsada i narrator” (postacie, zdjęcia, głos)
   i „Zatwierdź etap 0”.
3. **Odcinek**: „Nowy odcinek” (`episode add`) albo „Wczytaj odcinek”.
4. **Przegląd odcinka**: „Następny krok” (to samo, co `status`) i drabina trzynastu
   etapów. „Przejdź do etapu N” otwiera stronę etapu.
5. **Strona etapu**, zawsze w tym samym układzie: stan → wynik → „Sprawdź” i „Zatwierdź”
   (w części etapów także „Odrzuć…”) → generowanie, czyli podgląd, rachunek i „Kup”.

Pieniądze wydaje wyłącznie „Kup”. Pasek na dole okna pokazuje komendę i jej wynik.

UI nie pisze `project.md` i nie prowadzi wywiadu. Pomysł i etap 0 najwygodniej przejść
w terminalu skillami `/develop-series` i `/prepare-project`, a dalej pracować w UI.
Więcej w [docs/ui.md](docs/ui.md).
