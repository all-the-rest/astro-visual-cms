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
pnpm run browser-tests # echte Chromium-Browsertests für den Galerie-Editor
pnpm run verify       # Tests, danach Astro-Build plus optimierte Fixture-Bilder prüfen
```

Der HTTP-E2E-Test startet beide Server auf eigenen Testports, wartet auf Astos tatsächlich aktualisierte Galerie-Markierung und stellt die Fixture bytegenau wieder her. Die getrennte Playwright-Konfiguration nutzt Chromium und ausschließlich `browser-tests/**/*.spec.ts`; die Server laufen auf `127.0.0.1:15321` (Astro) und `127.0.0.1:15322` (Editor), ohne vorhandene Server wiederzuverwenden. Der Browser-Test prüft Galeriewahl, Drag-and-drop und Button-Sortierung, den wirklich neu gerenderten Astro-iframe samt unveränderter zweiter Galerie und begrenzt den MDX-Patch auf das gewählte Array. Die Fixture wird auch bei Testfehlern in `finally` bytegenau wiederhergestellt. Zusätzlich prüft ein mobiler Viewport auf horizontalen Overflow. Chromium lokal einmalig mit `pnpm exec playwright install chromium` installieren; CI installiert es samt System-Abhängigkeiten. Der Build-Verify baut denselben Slug zweimal mit unterschiedlichen Quellpixeln, vergleicht die dekodierten WebP-Pixel und baut anschließend mit restaurierter Quelle erneut, damit `dist/` zur Ausgangsquelle passt.

## Begrenzter Quellpatch

Die Fixture verwendet bewusst das reale Artikelmuster:

```mdx
export const SORTING = ["noise-fixture-01", "noise-fixture-02", "noise-fixture-03"];
<Gallery sorted={SORTING} />
```

Der Parser erkennt mehrere eindeutig importierte Galerien und ihre getrennten exportierten Literal-Arrays; ein zusätzliches `id`-Attribut ist nicht erforderlich. Er akzeptiert beliebige eindeutige String-Slugs, während der feste Demo-Server die renderbaren Bilder auf sein Manifest beschränkt. Der Patch ersetzt ausschließlich das ausgewählte Array und erhält alle übrigen Quellbytes. Dynamische Werte, Spread-Attribute/-Elemente, Kommentare, mehrdeutige oder mehrfach verwendete Arrays, doppelte Einträge und stale SHA-256-Hashes werden abgelehnt. Weitere Grenzen und die konfigurierbare Importidentität stehen in [docs/gallery-editor.md](docs/gallery-editor.md).

Die Schreib-API ist ein separater Dev-Server, an `127.0.0.1` gebunden, prüft Host, Origin und JSON-Content-Type, hat ein Request-Limit, ist bei `NODE_ENV=production` deaktiviert und wird nicht in den Astro-Build eingebunden. Sie ist kein Produktions-Endpunkt. Das ist **keine allgemeine CMS-Sicherheitsbehauptung**: Der Spike validiert nur diese eine Fixture-Struktur und ist weder ein allgemeiner MDX-Editor noch ein Sandbox-/Content-Security-System.

## `astro:assets`-Image-Experiment

`SlugImage.astro` verwendet `Image` aus `astro:assets`. `resolveImageMetadata(slug)` liefert für Einträge des expliziten Demo-Manifests URL, Maße und Format; absolute Dateipfade sind nicht Teil dieses öffentlichen Metadatenvertrags. Der Resolver validiert unter anderem Slugs, Manifest, Dateien und Bildformat. Ein separater privater Adapter ergänzt für Astro 7.4.7 ein nicht-enumerierbares `fsPath`.

Der Build ist ein konkreter, eng begrenzter Nachweis: Astro rendert alle drei Slugs, gibt drei transformierte WebP-Dateien aus, und der aktive Vite-Guard bricht ab, falls eine der Fixture-JPEGs als Vite-Image-Modul aufgelöst wird. Der Resolver hängt einen SHA-256-Hash der Quelldatei an `ImageMetadata.src`; dadurch ändert sich Astros Transform-Hash auch dann, wenn Slug und Transformoptionen gleich bleiben. Dafür werden keine `import`- oder `import.meta.glob`-Bildimporte für die Testbilder verwendet. Ein CDN oder Proxy muss den `content`-Query-Parameter in seinen Cache-Key aufnehmen (oder bei Änderungen gezielt invalidieren); ignoriert oder entfernt es Query-Parameter, kann es trotz geändertem Quellinhalt eine alte Antwort ausliefern.

Wichtige Grenze: `fsPath` ist eine nachgebildete interne Astro-Konvention, keine zugesicherte öffentliche Resolver-API. In Astro 7.4.7 liest `node_modules/astro/dist/assets/internal.js` den Dateipfad aus importierter Metadatenform; einfache URL-Strings für `public/` werden dagegen nicht optimiert. Der private Adapter setzt vertrauenswürdige lokale Dateien voraus: Der Resolver weist Symlinks im gesamten Bild-Root-Pfad zurück, aber zwischen Validierung und Astos späterem Lesen kann sich eine Datei ändern (TOCTOU). Die Demo bindet ihren Astro-Root an das Verzeichnis von `astro.config.mjs`; ein anderer Root erfordert eine angepasste Resolver-Konfiguration. Der Guard und die Builds belegen das Verhalten der Demo-Bilder, nicht Vite-Freiheit für beliebige Projekte. Vollständige oder versionsstabile `Image`-Kompatibilität wird nicht zugesichert.

## Nicht integriert / spätere Arbeit

- Das Referenzprojekt lädt Bilder über Slugs und `src/images/image-service.ts` → `slug-map`. Dieser Spike verbindet sich **nicht** mit diesem Resolver oder dessen Metadaten und ändert keine Datei in `reisinger.pictures`. Die Test-Fixture nutzt eine eigene statische Slug-Tabelle.
- Kein produktiver Schreibpfad, Upload, allgemeiner AST-Editor, Authentisierung, Multi-User-/Race-Handling oder 1:1-Astro-Image-Wrapper.
- Eine spätere Migration ist als Planung-/Prüfprozedur unter `.agents/skills/astro-image-migration/SKILL.md` abgegrenzt. Sie sollte erst nach Bewertung der Resolver-Stabilität angewandt werden; dieser Spike startet keine produktive Migration.

## UI-Bausteine

Die UI nutzt daisyUI `card` für die Bereiche, `list` für die sortierbaren Einträge, `btn` für die Move-Aktionen und `alert` für Statusfeedback. Die Defaults bleiben neutral; die `alert`-Statusfarbe ist die semantische Feedback-Ausnahme.
