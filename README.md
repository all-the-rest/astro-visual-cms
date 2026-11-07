# Astro visual CMS – sicher begrenzter Spike

Ein ausführbarer, absichtlich kleiner Spike zu Issue #1. Er rendert eine echte Astro-MDX-Seite und erlaubt, die Bildreihenfolge über eine separate lokale Editor-UI zu ändern. Änderungen schreiben ausschließlich die feste Datei `src/pages/fixture.mdx` dieses Spikes.

## Start

Voraussetzung: Node.js `>=22.23.4` und pnpm `11.23.0`.

```sh
pnpm install
pnpm dev
```

- Editor: <http://127.0.0.1:4322>
- Astro-Seite: <http://127.0.0.1:4321/fixture/>

`pnpm dev` legt bei Bedarf drei zufällige RGB-Noise-JPEGs mit Sharp in `public/images/` an und erhält sie bei weiteren Starts/Builds. Die Dateien sind generiert und in Git ignoriert. Die Editor-Seite läuft in einem eigenen Node-Server und zeigt die Astro-Seite in einem iframe. Native Drag-and-drop-Sortierung sowie zugängliche Hoch-/Runter-Buttons patchen dieselbe MDX-Fixture lokal.

## Checks

```sh
pnpm test             # Unit-, Compile-, JPEG- und HTTP-E2E-Tests
pnpm run test:e2e     # HTTP-E2E-Test allein
pnpm run verify       # Tests, danach Astro-Build plus optimierte Fixture-Bilder prüfen
```

Der E2E-Test startet beide Server auf eigenen Testports, lädt die gerenderte MDX-Seite, reordert über die lokale API, wartet über einen auf vier Sekunden begrenzten Preview-Ready-Endpunkt auf Astos tatsächlich aktualisierte Galerie-Markierung, prüft den iframe-Ziel-HTML-Output sowie den Konflikt bei einem stale Hash und stellt danach die Fixture bytegenau wieder her. Während Speichern/Synchronisieren sind Drag und Buttons deaktiviert; Fehler und stale Konflikte werden im Statusfeld angezeigt. Der Build-Verify baut denselben Slug zweimal mit unterschiedlichen Quellpixeln, vergleicht die dekodierten WebP-Pixel und baut anschließend mit restaurierter Quelle erneut, damit `dist/` zur Ausgangsquelle passt. Die temporäre Testquelle wird im `finally` wiederhergestellt. Der DnD-Client wird syntaktisch und auf Handler/Alternativen geprüft; der HTTP-E2E-Test deckt Patch und Preview-Ready ab, ist aber kein echter Browser-/Playwright-Test.

## Begrenzter Quellpatch

Die Fixture verwendet bewusst das reale Artikelmuster:

```mdx
export const SORTING = ["noise-fixture-01", "noise-fixture-02", "noise-fixture-03"];
<Gallery sorted={SORTING} />
```

Der Patch-Parser verlangt genau einen `export const SORTING` mit einem Literal-Array aus den drei bekannten Test-Slugs sowie genau eine `<Gallery sorted={SORTING} />`. Er ersetzt ausschließlich die Array-Ausdrucksbytes und erhält alle übrigen Quellbytes. Er lehnt dynamische Werte, Spread-Attribute/-Elemente, Kommentare, unbekannte Slugs, doppelte Einträge und stale SHA-256-Hashes ab. Kommentare oder Syntax, die bereits der MDX-Parser ablehnt, werden ebenfalls fail-closed als nicht unterstützte Fixture gemeldet.

Die Schreib-API ist ein separater Dev-Server, an `127.0.0.1` gebunden, prüft Host, Origin und JSON-Content-Type, hat ein Request-Limit, ist bei `NODE_ENV=production` deaktiviert und wird nicht in den Astro-Build eingebunden. Sie ist kein Produktions-Endpunkt. Das ist **keine allgemeine CMS-Sicherheitsbehauptung**: Der Spike validiert nur diese eine Fixture-Struktur und ist weder ein allgemeiner MDX-Editor noch ein Sandbox-/Content-Security-System.

## `astro:assets`-Image-Experiment

`SlugImage.astro` importiert `Image` aus `astro:assets`. `resolveFixtureImageMetadata(slug)` löst ausschließlich die drei fest erlaubten Slugs auf lokale Dateien auf und liest deren Maße/Format mit Sharp. Es baut ein Image-Metadata-Objekt und versieht es mit einem nicht-enumerierbaren `fsPath`, entsprechend der Laufzeitform, die Astro 7.4.7 für importierte Images nutzt.

Der Build ist ein konkreter, eng begrenzter Nachweis: Astro rendert alle drei Slugs, gibt drei transformierte WebP-Dateien aus, und der aktive Vite-Guard bricht ab, falls eine der Fixture-JPEGs als Vite-Image-Modul aufgelöst wird. Der resolver hängt einen SHA-256-Hash der Quelldatei an `ImageMetadata.src`; dadurch ändert sich Astos Transform-Hash auch dann, wenn Slug und Transformoptionen gleich bleiben. Dafür werden keine `import`- oder `import.meta.glob`-Bildimporte für die Testbilder verwendet.

Wichtige Grenze: `fsPath` ist hier eine nachgebildete interne Metadaten-Konvention, keine zugesicherte öffentliche Resolver-API. In Astro 7.4.7 liest `node_modules/astro/dist/assets/internal.js` den Dateipfad aus importierter Metadatenform; `node_modules/astro/dist/assets/vite-plugin-assets.js` erzeugt diese Form für ESM-Image-Module. Die Typen dokumentieren importierte lokale `ImageMetadata`; einfache URL-Strings für `public/` benötigen dagegen Breite/Höhe und werden nicht optimiert (`node_modules/astro/dist/assets/types.d.ts`). Dass dieses kleine Experiment mit dem installierten Sharp-Service baut, macht es nicht zu einer vollständigen oder versionsstabilen `Image`-Kompatibilität. Der Guard belegt nur, dass diese drei Fixture-Bilder nicht als Vite-Image-Module geladen werden — nicht Vite-Freiheit für beliebige Projekte oder Assets.

## Nicht integriert / spätere Arbeit

- Das Referenzprojekt lädt Bilder über Slugs und `src/images/image-service.ts` → `slug-map`. Dieser Spike verbindet sich **nicht** mit diesem Resolver oder dessen Metadaten und ändert keine Datei in `reisinger.pictures`. Die Test-Fixture nutzt eine eigene statische Slug-Tabelle.
- Kein produktiver Schreibpfad, Upload, allgemeiner AST-Editor, Authentisierung, Multi-User-/Race-Handling oder 1:1-Astro-Image-Wrapper.
- Eine spätere Migration ist als Planung-/Prüfprozedur unter `.agents/skills/astro-image-migration/SKILL.md` abgegrenzt. Sie sollte erst nach Bewertung der Resolver-Stabilität angewandt werden; dieser Spike startet keine produktive Migration.

## UI-Bausteine

Die UI nutzt daisyUI `card` für die Bereiche, `list` für die sortierbaren Einträge, `btn` für die Move-Aktionen und `alert` für Statusfeedback. Die Defaults bleiben neutral; die `alert`-Statusfarbe ist die semantische Feedback-Ausnahme.
