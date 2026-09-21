# Etap 8: montaż

Pierwszy etap, który **niczego nie kupuje**, i pierwszy, którego bajty pochodzą z lokalnego
silnika. Skleja zatwierdzone klipy w `<tor>/episode.mp4`.

| | |
|---|---|
| **Wejście** | zatwierdzona `shot-list.md`, zatwierdzone klipy **na tym torze** |
| **Wyjście** | `<tor>/episode.mp4`, `<tor>/assembly.stage.json`, `<tor>/runs/<runId>/` |
| **Bramka** | zatwierdzony **każdy** klip planowany przez listę ujęć; potem ocena całości |
| **Koszt** | darmowy, wymaga ffmpeg |

## Komendy

```bash
pnpm dev assembly generate dzielna-ewa 01-burza --track gpt-image --dry-run
pnpm dev assembly generate dzielna-ewa 01-burza --track gpt-image
pnpm dev check dzielna-ewa 01-burza --stage assembly --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage assembly --track gpt-image \
  --note "rytm trzyma, szwy niewidoczne"
```

Dodatkowe flagi: `--regenerate`.

## Planu montażowego nie ma jako pliku

Kolejność, sekundy i kafelkowanie bez dziur są już w zatwierdzonej `shot-list.md`, a drugi
plik byłby `shot-list.json` pod inną nazwą, czyli tym, co etapy 3 i 4 już raz odrzuciły.
**Jeśli plan montażowy jest zły, poprawka należy do [etapu 3](03-lista-ujec.md).**

## Bramka

Zatwierdzone klipy: wszystkie, które planuje lista ujęć, **na tym torze**. Klatek
wejściowych ani końcówek bramka nie dotyka: klatka wejściowa jest już pierwszą klatką
swojego klipu.

## Skleja to, co wróciło, i melduje różnicę

Klip zamówiony na 6 s wraca jako 6,04 s przy 24 klatkach, a [etap 7](07-klipy.md)
publikuje go bez przycinania, bo to są bajty, które przyjął człowiek. Przycięcie ich tutaj
złożyłoby film z klatek, których nie przyjął nikt.

Raport podaje sumę planu, sumę klipów i odchyłkę; werdykt na gotowym pliku porównuje go
z **sumą jego własnych klipów**, nie z `durationSeconds`.

## ffmpeg, bez przekodowania, bez objazdu

Strumieniowe kopiowanie (`-c copy`) jest możliwe, bo oba tory renderują jednym modelem
w jednej rozdzielczości i tempie klatek. Gdy ffmpeg nie ma w `PATH` ani w
`AIMATOR_FFMPEG`, montaż odmawia. `check` go nie potrzebuje.

## „Ocena całości" to nie powtórka ocen klipów

Tamte mówią, że każde ujęcie jest dobre; ta mówi, że **te klipy w tej kolejności to film**.
Rytm przez cięcia, ciągłość na szwach i rzeczywista długość istnieją wyłącznie w całości.

Jeden artefakt na tor, więc `--artifact` nie jest wymagane nigdzie; `--regenerate` jest,
nie dlatego, że coś kosztuje, tylko dlatego, że gotowy montaż nosi czyjąś zgodę.

## `episode.mp4` jest niemy

I `check` mówi to przy każdym uruchomieniu. Ścieżka dźwiękowa musi powstać wobec sklejonego
filmu, a nie wobec planu, i dlatego należy do etapów poniżej.

---

[← etap 7](07-klipy.md) · [README](../../README.md) ·
[etap 9: narracja →](09-narracja.md) · [pełny kontrakt](../pipeline.md)
