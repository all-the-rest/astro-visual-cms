# Astro-Kompatibilitätsmatrix

Diese Demo pinnt `astro` auf die zum Zeitpunkt der Phase-0-Entscheidung aktuelle
Version. Ein Build gegen weitere Versionen ist ein optionaler, netzwerkabhängiger
Lokal-Gate und gehört nicht zu `pnpm verify` oder zur CI: Er lädt fremde
Paketversionen und ist deshalb kein deterministischer Repository-Gate.

## Geprüfter Stand

| Datum | Astro | `@astrojs/mdx` | Ergebnis |
| --- | --- | --- | --- |
| 2026-11-07 | 7.4.7 (Repo-Pin, CI) | 8.1.3 | `pnpm verify` grün, drei Produktionsbuilds |
| 2026-11-08 | 7.3.8 | 8.1.3 | `astro build` grün, Fixture-Reihenfolge und optimierte Bildreferenzen korrekt |
| 2026-11-08 | 7.2.10 (Peer-Untergrenze) | 8.1.3 | `astro build` grün, Fixture-Reihenfolge und optimierte Bildreferenzen korrekt |

`@astrojs/mdx` 8.1.3 deklariert `astro: ^7.2.10`; 7.2.10 ist damit die geprüfte
Untergrenze des Peer-Bereichs. Neuere Versionen als 7.4.7 waren am 2026-11-08
nicht verfügbar. Die Matrix ist eine Stichprobe, keine Zusage für alle künftigen
Minors.

## Verfahren

In einer Wegwerf-Kopie außerhalb des Arbeitsbaums, nie im Repository:

1. Repository ohne `.git`, `node_modules`, `dist`, `.astro`, `test-results` und
   `public/images` kopieren.
2. In der Kopie `dependencies.astro` auf die Zielversion setzen und
   `pnpm-lock.yaml` entfernen.
3. `pnpm install --no-frozen-lockfile`, `node scripts/generate-noise.mjs`,
   `pnpm exec astro build`.
4. In `dist/fixture/index.html` prüfen: beide `data-gallery-order`-Marker
   (`noise-fixture-01,noise-fixture-03` und `noise-fixture-02`) und je eine
   optimierte Bildreferenz pro Slug.

Der Editor selbst hängt nicht von der Astro-Version ab: Parser und Patch arbeiten
auf `@mdx-js/mdx` und `@babel/parser`. Für 7.3.8 und 7.2.10 wurde ausschließlich
der Fixture-Build mit den oben genannten HTML- und Bildreferenz-Prüfungen
ausgeführt. Vorschau-Readiness sowie der Editor-HTTP-Ablauf wurden nur gegen den
Repo-Pin 7.4.7 durch `pnpm verify` geprüft.
