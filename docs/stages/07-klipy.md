# Etap 7: klipy

Pierwszy etap, który kupuje **dwa rodzaje mediów**: klatki wejściowe (obraz) i klipy
(wideo). Pierwszy, w którym bramka jest łańcuchem.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, zatwierdzony `prompt-package.json` z `prompts/clips/Cnn.md` i `prompts/entry-frames/Cnn.md`, zatwierdzona `shot-list.md`, zatwierdzona klatka, od której klip się zaczyna |
| **Wyjście** | `<tor>/clips/Cxx.mp4`, `<tor>/frames/Cxx/entry.png`, `<tor>/frames/Cxx/end.jpg`, `<tor>/clips.stage.json`, `<tor>/runs/<runId>/` |
| **Bramka** | łańcuch zgód, patrz niżej; potem ocena klipu i klatek z osobna |
| **Koszt** | płatny w **dwóch walutach**: wywołania obrazowe i wideo, liczone osobno |

## Komendy

```bash
pnpm dev prompt-package show dzielna-ewa 01-burza --track seedream --artifact C01
pnpm dev clip generate dzielna-ewa 01-burza --track seedream --dry-run
pnpm dev clip generate dzielna-ewa 01-burza --track seedream
pnpm dev check dzielna-ewa 01-burza --stage clips --track seedream
pnpm dev approve dzielna-ewa 01-burza --stage clips --track seedream --artifact C01 \
  --note "ruch ręki czytelny, końcówka nadaje się na wejście C02"
```

Dodatkowe flagi: `--artifact C01,entry:C02`, `--image-model <id>`, `--video-model <id>`,
`--regenerate`, `--republish --artifact C01`.

## Bramka jest łańcuchem

Klip C01 czeka na zatwierdzoną klatkę otwarcia. Klatka wejściowa C02 czeka na zatwierdzoną
**końcówkę** C01, jeśli lista ujęć mówi `previous-end-frame`; jeśli mówi
`new-scene-frame`, czeka tylko na swoje referencje. Klip C02 czeka na swoją klatkę
wejściową. **Każde ogniwo to zgoda człowieka, nie sama walidacja.**

## Końcówka klipu wraca razem z klipem

Zadanie jest uruchamiane z prośbą o ostatnią klatkę, więc powstaje z tej samej opłaconej
próby i jest drugim wyjściem tego samego rekordu. Jedna ocena obejmuje klip i klatkę,
z której wyjdzie następny.

Format wybiera dostawca: ModelArk oddaje JPEG, więc plik nazywa się `frames/Cnn/end.jpg`.
Nazwa idzie za bajtami, bo przekodowanie oznaczałoby przyjęcie jednego obrazu i dołączenie
innego.

## `--republish`, jedyny etap, który tego potrzebuje

`--republish --artifact C01` publikuje klip jeszcze raz z archiwum, nie wysyłając niczego
i nie wymagając modelu ani klucza. Obok klipu rozstrzyga się jeszcze, czym jest końcówka,
a pomyłka w rozstrzygnięciu wychodzi na jaw po publikacji i nie może kosztować drugiego
wideo.

## Jeden obraz na wywołanie

**Płatne wywołanie klipu niesie dokładnie jeden obraz: swoją pierwszą klatkę.** To reguła
API, nie wybór: przypięcie pierwszej klatki wyklucza się z dołączaniem referencji.
Referencje, które manifest przypisał klipowi, są tym, z czego narysowano tę klatkę.

## Długość klipu bierze się z listy ujęć

Klipu o długości, której model nie renderuje, narzędzie nie zaokrągli: odmówi przed
wysyłką i wskaże poprawkę w `maxClipSeconds` i [etapie 3](03-lista-ujec.md). Raport podaje
liczbę płatnych wywołań **osobno dla obrazów i dla wideo**, zanim cokolwiek wyśle.

Dźwięku nie generujemy, bo ścieżka dźwiękowa jest ciągła przez cięcia, więc należy do etapu
**poniżej montażu**, a klipy są proszone o ciszę jawnie.

## Modele

Model wideo jest **jeden dla obu torów** (`AIMATOR_VIDEO_MODEL`, klucz
`BYTEPLUS_MODELARK`), a klatki wejściowe rysuje ten sam model obrazowy co referencje na tym
torze. Dlatego zamiast `--model` są dwie flagi: `--image-model` i `--video-model`.

## Zadanie asynchroniczne

Klip to zadanie, które dostawca wykonuje gdzie indziej: POST oddaje identyfikator, a wynik
przychodzi przez odpytywanie. Identyfikator ląduje na dysku **przed pierwszym pytaniem**,
więc przerwaną próbę kończy się pytaniem, a nie drugą opłatą.

---

[← etap 6](06-klatka-otwarcia.md) · [README](../../README.md) ·
[etap 8: montaż →](08-montaz.md) · [pełny kontrakt](../pipeline.md)
