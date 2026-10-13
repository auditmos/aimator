# Etap 6: klatka otwarcia

Pierwsza klatka filmu. Jedno polecenie, jedno płatne wywołanie, jeden obraz do oceny.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, `style.json` i [obrazy stylu](00-przygotowanie.md#obrazy-stylu), zatwierdzony `prompt-package.json` i `prompts/opening-frame.md`, zatwierdzona `shot-list.md`, zatwierdzone `opening.referenceIds` **na tym torze** |
| **Wyjście** | `<tor>/opening-frame.png`, `<tor>/opening-frame.stage.json`, `<tor>/runs/<runId>/` |
| **Bramka** | decyzja o obrazach stylu, zatwierdzony [etap 4](04-pakiet-promptow.md) i zatwierdzone `opening.referenceIds`; potem ocena kadru |
| **Koszt** | dokładnie jedno płatne wywołanie obrazowe |

## Komendy

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track seedream --artifact opening-frame
pnpm dev opening-frame generate dzielna-ewa 01-burza --track seedream --dry-run
pnpm dev opening-frame generate dzielna-ewa 01-burza --track seedream
pnpm dev check dzielna-ewa 01-burza --stage opening-frame --track seedream
pnpm dev approve dzielna-ewa 01-burza --stage opening-frame --track seedream \
  --checks anatomy,master,style,continuity,props \
  --note "pozycja alpaki bez ucisku ucha"
```

Dodatkowe flagi: `--model <id>`, `--json`, `--regenerate`, `--instruction <uwaga>` (tylko
razem z `--regenerate`).

`--regenerate --instruction "Zostaw noc, przyciemnij lampę."` poprawia opublikowaną klatkę
zamiast rysować ją od zera: idzie ona jako `Image 1 = previous:opening-frame`, przed
dotychczasowymi załącznikami. `--artifact` nadal nie jest wymagane, bo adresat jest jeden
z konstrukcji. Szczegóły na stronie [etapu 5](05-referencje.md#poprawka-z-uwagą).

## Etap 6 jako obiekt

`--json` wypisuje **obiekt, który zwraca moduł etapu**, plus pola `command` i `stage`:

```bash
pnpm dev check dzielna-ewa 01-burza --stage opening-frame --track gpt-image --json
pnpm dev approve dzielna-ewa 01-burza --stage opening-frame --track gpt-image --checks all --json
pnpm dev opening-frame generate dzielna-ewa 01-burza --track gpt-image --dry-run --json
```

Rachunek (`paidCalls`) jest zerem albo jedynką, i właśnie dlatego wart wypisania: pytanie
przed kliknięciem brzmi „czy to zaraz kupi klatkę, czy powie, że nie może". Gdy jest zerem,
`artifact.note` mówi, której zgody brakuje. W żadnej z tych komend nie ma `--artifact`,
i [panel etapu 6](../ui.md) też go nie pokazuje: pole wyboru z jedną możliwością jest
ceremonią stojącą tam, gdzie kiedyś była decyzja.

## Bramka przekracza granicę etapu, nie granicę toru

Czeka na to, co pakiet wpisał w `opening.referenceIds`: `hero:<id>` każdej postaci
w kadrze i wskazane `Rnn`, **zatwierdzone na tym torze**. Zgoda wydana na `gpt-image` nie
otwiera niczego na `seedream`.

## `--artifact` nie jest tu wymagane nigdzie

Ani przy `--regenerate`, ani przy `approve`. Etap ma jeden artefakt, więc samo polecenie
już mówi, o co chodzi; flaga o jednej dozwolonej wartości byłaby ceremonią, nie
zabezpieczeniem. Napisana i tak jest sprawdzana: `--artifact R01` w tym etapie to odmowa,
nie ciche zignorowanie.

## Zatwierdzenie to checklista, nie samo „tak"

Walidator obrazu sprawdza strukturę PNG i wymiary, a z tej klatki zostanie wyrenderowany
klip. Dlatego `approve` tego etapu **wymaga `--checks`**: listy kryteriów, które człowiek
sprawdził, albo `all`.

| Kryterium | Co sprawdzasz |
|---|---|
| `anatomy` | anatomia postaci |
| `master` | zgodność z Character Master (`hero.png` na tym torze) |
| `style` | zgodność ze stylem serii |
| `continuity` | ciągłość z listą ujęć |
| `props` | rekwizyty i otoczenie |

Zbiór wymaganych kryteriów jest **wyprowadzony z planu wysyłki**, nie pytany: `master`
obowiązuje tylko wtedy, gdy klatka dołącza jakiś `hero:<id>`. Kadr bez postaci z obsady nie
ma czego porównywać z Character Master. Bez `--checks` albo z niepełną listą `approve`
odmawia i wymienia brakujące kryteria; nazwa spoza słownika to błąd użycia. `--checks all`
znaczy „wszystkie wymagane dla tej klatki". Rekord zapisuje je w `review.checks`.
Podpowiedź „Dalej:" w `check` i `generate` niesie już tę listę, a `check --json` podaje ją
w `artifact.checks`, z którego panel UI buduje swoją checklistę.

## Czym różni się od referencji

Klatka otwarcia **niesie dosłowne ujęcia** pierwszego klipu, bo jest kadrem filmu, a nie
referencją, więc `shot-list.md` jest jej zapisanym wejściem. Kadr jest ten sam co
w [etapie 5](05-referencje.md).

---

[← etap 5](05-referencje.md) · [README](../../README.md) ·
[etap 7: klipy →](07-klipy.md) · [pełny kontrakt](../pipeline.md)
