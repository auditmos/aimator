# Jak opisać styl

Ta strona jest dla rozmowy o wyglądzie serii w [etapie 0](stages/00-przygotowanie.md).
Pokazuje, jak zamienić „ciepły, bajkowy" w opis, na którym model obrazu może stanąć.
Słowa, których używa, ustala [słownik](slownik.md).

## Dlaczego opis musi coś rozstrzygać

`project.md` trafia w całości do każdego płatnego obrazu i klipu, od
[etapu 2](stages/02-postac.md) po [etap 7](stages/07-klipy.md), a prompt mówi modelowi
wprost, że to jest reżyseria plastyczna i że ma się jej trzymać. Czego opis nie rozstrzyga,
to model rozstrzyga sam, w każdym przebiegu inaczej: to jest dryf stylu, który potem
nazywa się halucynacją.

„Ciepły, bajkowy" przechodzi `check`, bo `check` sprawdza, czy pole jest wypełnione, a nie
czy cokolwiek mówi. Modelowi nie mówi nic.

Strona jest **dwujęzyczna z założenia**, i to jest [reguła 9](../AGENTS.md#pipeline-rules),
a nie wyjątek od niej. Linie stylu i tokeny są instrukcją dla modelu, więc są po angielsku.
Proza wokół nich jest dla człowieka, więc jest po polsku.

## Style Stack

Osiem warstw opisu rysunku, zawsze w tej kolejności. Warstwa, której opis nie rozstrzyga,
zostaje modelowi.

| Warstwa | Co rozstrzyga | Przykładowe tokeny |
|---|---|---|
| 1. format | rodzaj filmu | `2D animation`, `stylized 3D CGI`, `stop-motion` |
| 2. medium | z czego obraz wygląda na zrobiony | `watercolor`, `gouache painting`, `flat vector`, `plasticine figures` |
| 3. kreska | kontur: czy jest, jak gruby, czy się zwęża, jakiego koloru | `thick black outline`, `thin tapered outlines`, `lineless shapes` |
| 4. cieniowanie | jak powstaje cień | `flat unshaded fills`, `two-tone cel shading`, `soft gradient shading` |
| 5. paleta | ile barw i jak nasyconych | `muted pastel palette`, `warm earth palette`, `bold primary palette` |
| 6. tekstura | powierzchnia | `smooth digital fills`, `visible paper grain`, `visible brushstrokes` |
| 7. światło i nastrój | kierunek, kontrast, temperatura | `warm afternoon light`, `soft overcast light`, `moody low-key lighting` |
| 8. kompozycja | układ kadru i gęstość tła | `simple flat backgrounds`, `detailed painted backgrounds`, `symmetrical centered framing` |

Linia stylu nie musi mieć tokenu z każdej warstwy. Niesie te, które odróżniają ten styl od
innych, a resztę rozstrzygają paleta, reguła kreski i lista „zawsze / nigdy".

## Odcisk palca stylu

Pytanie „jaki styl?" ma tylko złe odpowiedzi: nazwę studia albo przymiotnik. Zamiast niego
zadaj dziewięć pytań, na które da się odpowiedzieć, patrząc na cokolwiek: kadr z ulubionego
filmu, okładkę książki, rysunek dziecka. Każde dotyczy czegoś, co widać, więc odpowiedź nie
wymaga znajomości ani jednego fachowego słowa. Zamiana odpowiedzi na tokeny to zadanie
pytającego.

Osiem pytań to warstwy Style Stacku zamienione w pytania. Dziewiąte dotyczy proporcji
postaci, bo to najmocniejszy wyróżnik stylu i najłatwiej go pominąć.

| | Warstwa | Pytanie |
|---|---|---|
| 1 | format | Czy to rysunek, bryła z komputera, czy coś zrobionego z materiału i sfotografowanego? |
| 2 | medium | Na czym albo z czego to zrobiono: farba wodna, farba kryjąca, tusz, papier, plastelina, gładki wektor? |
| 3 | kreska | Czy kształty mają obrys? Jak gruby, jakiego koloru, czy zwęża się na końcach? |
| 4 | cieniowanie | Jak wygląda cień na twarzy: płaska ciemniejsza plama, ostra granica, miękkie przejście, brak cienia? |
| 5 | paleta | Ile barw widać w jednym kadrze i czy są nasycone, czy przygaszone? |
| 6 | tekstura | Czy płaszczyzny są gładkie, czy widać ziarno papieru, ślad pędzla, odcisk palca? |
| 7 | światło i nastrój | Skąd pada światło, jak ostre są cienie rzucane i czy kadr jest ciepły, czy chłodny? |
| 8 | kompozycja | Ile szczegółów ma tło w porównaniu z postacią i czy kadr jest płaski, czy głęboki? |
| 9 | proporcje postaci | Ile razy głowa mieści się w wysokości postaci i jak bardzo sylwetka odchodzi od natury? |

Odpowiedź na pytanie 9 ma w `project.md` własny wiersz, „Proporcje i stylizacja postaci",
i nie trafia do linii stylu. Pozostałe osiem składa się na linię stylu i na to, co stoi przy
niej.

## Jak pisać linię stylu

- **5–7 tokenów.** Token to fraza od przecinka do przecinka. Krótsza linia zostawia warstwy
  modelowi, dłuższa uśrednia się w sposób, którego nie da się przewidzieć.
- **Tokeny w kolejności Style Stacku.** Dzięki temu dwie linie da się porównać token po
  tokenie, a brakującą warstwę widać od razu.
- **Jeden łańcuch, powtarzany dosłownie.** Linia jest jedna na projekt i trafia do każdego
  promptu co do przecinka. Nie parafrazuj jej i nie skracaj „na ten jeden raz".
- **Bez synonimów.** `watercolor` i `aquarelle` znaczą dla człowieka to samo, ale model
  ciągnie każde z innych wzorców. Raz wybrane słowo zostaje, tak samo jak w
  [słowniku](slownik.md), tylko po stronie modelu.
- **Tylko to, co jest.** Czego ma nie być, stoi na liście „zawsze / nigdy", nie w linii.
  Token to fraza, a nie zdanie, więc przeczenie w środku listy fraz łatwo się gubi.
- **Bez ocen.** `beautiful`, `stunning` czy `high quality` nie niosą żadnej decyzji, a
  zajmują miejsce tokenu, który by ją niósł.
- **Bez nazw studiów i artystów.** Nazwę rozkłada się na odcisk palca.
- **Po angielsku**, bo linia jest instrukcją dla modelu.

Linia, która niczego nie rozstrzyga, i linia, która rozstrzyga sześć warstw:

```
cute cozy cartoon style, high quality
2D animation, flat vector, thick brown outline, two-tone cel shading, warm pastel palette, visible paper grain
```

W `project.md` opis stylu stoi w bloku [Style Bible](stages/00-przygotowanie.md#style-bible),
w czterech polach: linia stylu, dosłownie, potem paleta, reguła kreski i lista „zawsze /
nigdy".

## Trudność utrzymania

Jedyna część tej strony, która mówi o pieniądzach. Dryf stylu w tym narzędziu to
regeneracja, a [etap 2](stages/02-postac.md) kupuje do dziesięciu obrazów na postać na
każdym torze. Im więcej stopni swobody ma styl, tym więcej miejsc, w których dwa przebiegi
mogą się różnić, i tym częściej obraz trzeba kupić drugi raz.

Wysoka trudność nie jest zakazem. To cena, którą warto znać, zanim się wybierze.

| Rodzina | Trudność | Co dryfuje |
|---|---|---|
| flat vector | niska | Niewiele: płaskie plamy i stały kontur. Prawie wszystko rozstrzygają paleta i reguła kreski. |
| line art | niska | Grubość kreski, jeśli reguła kreski jej nie ustala. |
| cel shading | średnia | Granica cienia i to, gdzie wypada na twarzy. |
| cut-out | średnia | Faktura papieru i cień między warstwami. |
| 3D | średnia | Materiał skóry i włosów, kierunek światła. |
| watercolor | wysoka | Rozlewające się krawędzie i nierówne wypełnienia: każdy przebieg kładzie wodę inaczej. |
| painterly | wysoka | Ślad pędzla, mieszanie barw, krawędzie. Nic z tego nie daje się zapisać jako reguła. |
| stop-motion | wysoka | Bryła i faktura naraz: materiał, odciski, nierówności, światło studyjne. Claymation dryfuje najbardziej. |

## Katalog linii

Gotowe linie do zaproponowania w rozmowie zamiast pustego pola. Każda jest propozycją,
dopóki ktoś nie powie „tak", i każdą można zmieniać token po tokenie. Linia z katalogu nie
jest lepsza od napisanej od zera, tylko łatwiej ją odrzucić albo poprawić. Rodziny są te
same co w tabeli trudności, więc cena każdej linii stoi tuż wyżej.

| Rodzina | Linia |
|---|---|
| flat vector | `2D animation, flat vector, thick black outline, flat unshaded fills, bold primary palette, simple flat backgrounds` |
| flat vector | `2D animation, flat vector, lineless shapes, flat unshaded fills, muted pastel palette, simple flat backgrounds` |
| flat vector | `2D animation, flat vector, thin dark outline, two-tone cel shading, warm earth palette, visible paper grain` |
| flat vector | `2D animation, geometric flat vector, lineless shapes, flat unshaded fills, retro mid-century palette, sparse graphic backgrounds` |
| line art | `2D animation, ink line art, uniform black outlines, flat unshaded fills, two-color palette, white backgrounds` |
| line art | `2D animation, pencil line art, sketchy graphite outlines, monochrome gray palette, visible paper grain` |
| line art | `2D animation, ink line art, tapered brush outlines, spot color fills, black and red palette, rough paper texture` |
| cel shading | `2D animation, digital ink and paint, thin clean outlines, two-tone cel shading, bright saturated palette, crisp daylight` |
| cel shading | `2D animation, digital ink and paint, thick tapered outlines, hard cel shading, high-contrast palette, dramatic rim light` |
| cel shading | `2D animation, digital ink and paint, colored outlines, two-tone cel shading, candy pastel palette, flat sunny light` |
| cel shading | `2D anime style, digital ink and paint, thick outlines, hard cel shading, flat bright palette, simple flat backgrounds` |
| cut-out | `2D cut-out animation, layered colored paper, torn paper edges, drop shadows between layers, muted craft palette, soft top light` |
| cut-out | `2D cut-out animation, printed paper collage, lineless shapes, flat unshaded fills, vintage newsprint palette, halftone texture` |
| cut-out | `2D cut-out animation, paper silhouettes, backlit shadow puppetry, amber and black palette, warm candle glow` |
| 3D | `stylized 3D CGI, toy-like plastic surfaces, soft ambient occlusion, bright candy palette, clean studio lighting` |
| 3D | `stylized 3D CGI, chunky low-poly shapes, flat faceted shading, limited pastel palette, soft ambient light` |
| 3D | `stylized 3D CGI, 2D outline overlay, stepped cel shading, bold complementary palette, flat graphic textures` |
| 3D | `stylized 3D CGI, soft felt materials, gentle gradient shading, warm nursery palette, fuzzy fabric texture, soft window light` |
| watercolor | `2D animation, watercolor, thin ink outlines, soft wet-edge shading, muted natural palette, visible paper grain` |
| watercolor | `2D animation, loose watercolor, lineless shapes, bleeding color edges, pale spring palette, white paper backgrounds` |
| watercolor | `2D animation, watercolor and pencil, sketchy pencil outlines, light wash shading, warm sepia palette, visible paper grain` |
| painterly | `2D animation, gouache painting, lineless shapes, flat opaque brushwork, muted mid-century palette, matte paper texture` |
| painterly | `2D animation, oil painting, soft blended shading, rich jewel-tone palette, visible brushstrokes, golden hour light` |
| stop-motion | `stop-motion, plasticine figures, rounded chunky shapes, bright matte palette, fingerprint-textured clay, soft studio lighting` |
| stop-motion | `stop-motion, wooden puppets, simple painted faces, warm folk palette, carved wood grain, soft window light` |
| stop-motion | `stop-motion, felt cut-out shapes, stitched outlines, warm wool palette, soft felt texture, cozy lamp light` |

## Zamiast → użyj

Nazwa studia, filmu albo artysty to najczęstsza odpowiedź na pytanie o styl i najgorsza
rzecz, jaką można wpisać do `project.md`. Z dwóch powodów:

- **Nazwa to nie decyzja.** Za nazwą studia stoją dziesiątki filmów z różnych lat, a model
  w każdym przebiegu sięga po inny. To dryf stylu z gotowym uzasadnieniem. Kto podaje
  nazwę, zwykle ma na myśli jeden film i dwie, trzy cechy, a odcisk palca pyta, które.
- **Nazwa trafia do dostawcy dosłownie, a dostawca potrafi na nią odmówić**, najczęściej na
  nazwisko żyjącego artysty. Odmowa zatrzymuje etap, a poprawka oznacza zmianę
  `project.md`, czyli nowe czytanie i nową zgodę etapu 0.

Dlatego nazwa stoi wyłącznie w lewej kolumnie, a w prawej jej rozkład na odcisk palca,
zapisany jako linia stylu. To punkt wyjścia do rozmowy, nie gotowa odpowiedź: rozkład
zgaduje, o który okres i o które cechy chodziło. Część nazw rozkłada się też na proporcje
postaci, a te trafiają do wiersza „Proporcje i stylizacja postaci", nie do linii.

| Zamiast | Użyj |
|---|---|
| Ghibli | `2D animation, watercolor backgrounds, thin ink outlines, flat cel shading, soft natural palette, warm diffused daylight` |
| Disney | `2D animation, hand-drawn ink and paint, clean tapered outlines, two-tone cel shading, rich saturated palette, painted gouache backgrounds` |
| Pixar | `stylized 3D CGI, smooth rounded shapes, soft subsurface shading, saturated warm palette, soft global illumination, shallow depth of field` |
| Aardman | `stop-motion, plasticine figures, warm natural palette, fingerprint-textured clay, soft studio lighting` |
| Laika | `stop-motion, handmade puppets, muted desaturated palette, fabric and resin textures, moody low-key lighting, miniature handmade sets` |
| Cartoon Saloon | `2D animation, watercolor and pencil, visible pencil outlines, flat unshaded fills, jewel-tone palette, flat ornamental compositions` |
| Spider-Verse | `stylized 3D CGI, 2D outline overlay, halftone dot shading, saturated neon palette, offset print texture, comic panel framing` |
| Arcane | `stylized 3D CGI, hand-painted textures, teal and amber palette, visible brushstrokes, dramatic rim light` |
| Kyoto Animation | `2D anime style, digital ink and paint, thin tapered outlines, two-tone cel shading, soft pastel palette, soft bloom lighting` |
| Makoto Shinkai | `2D anime style, thin clean outlines, saturated blue palette, luminous sky gradients, lens flare light, detailed painted backgrounds` |
| Tim Burton | `stop-motion, gothic handmade puppets, desaturated gray palette, stitched fabric textures, stark moonlight, crooked miniature sets` |
| Wes Anderson | `stop-motion, felt-furred puppets, muted mustard palette, handmade miniature textures, flat even lighting, symmetrical centered framing` |
| Genndy Tartakovsky | `2D animation, flat vector, lineless shapes, flat unshaded fills, bold limited palette, widescreen graphic framing` |
