# Astro Visual CMS – lokaler, begrenzt schreibender Astro-Editor

Das Repository enthält das installierbare Paket `@astro-visual-cms/editor` sowie eine synthetische Demo-/Testanwendung. Das Paket startet einen loopback-only Editor und eine Astro-Dev-Integration; Bearbeitung bleibt auf explizit konfigurierte, getestete Adapter beschränkt. Es ist kein allgemeiner visueller MDX-Editor und kein Produktions-CMS.

Für Paketinstallation, Astro-Konfiguration, vertrauenswürdige Serveroptionen, Supportgrenzen und nachgewiesene Projektkopien siehe [Editor-Paket](docs/editor-package.md). Ein reproduzierbarer Tarball-Installationsgate ist `npm run pack:smoke`.

## Repository-Fixture starten

Die lokale Demo rendert eine Astro-MDX-Seite und ändert über die separate Editor-UI die Bildreihenfolge ausschließlich in der synthetischen Datei `src/pages/fixture.mdx`. Die komplexere Route `/reisinger-sample/editorial/showcase/` bildet zusätzlich typische Content-Layer-, MDX-Import-, Komponenten- und Slot-Strukturen aus einem realen Astro-Projekt nach. Sie enthält ausschließlich synthetische Texte und generierte Noise-Testbilder; sie erweitert nicht den allgemeinen Editor-Vertrag.

## Start

Voraussetzung: Node.js `>=22.12.0` und pnpm `11.23.0` (lokal verifiziert mit Node.js `26.10.0`).

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
pnpm run verify       # Tests, synthetischer Sharp/Astro-Static-Build und bestehender Astro-Build
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

## Synthetischer Sharp-Build-Time-Nachweis (Issue #6)

`pnpm run verify:sharp-build` baut die separate App unter `fixtures/sharp-build/` dreimal als echte Astro-Production-Builds. Ein repo-eigenes Sharp-Skript erzeugt dafür ausschließlich temporäre 320×180-Noise-JPEGs, validiert eine kleine technische Slug-/Datei-/Format-/Limit-/Breiten-Manifestform und schreibt responsive WebP-Varianten mit voller SHA-256-Quellkennung in den Dateinamen. Die Breiten der Fixture sind 80, 160 und 320 Pixel; pro Eingabe gelten höchstens 1 MB und 100.000 Pixel. Die Astro-Seite rendert statisches HTML mit `<picture>`, `srcset` und `<img>`; ein Vite-Guard verweigert JPEG-Quellimporte. Der Verify prüft HTML, genau die erwarteten WebP-Dateien, deren dekodierte Maße und Pixel, deterministische Wiederholung sowie geänderte Pixel beim Austausch und bytegenauen Wiederherstellen derselben Slug-Quelle. Quellen, Manifest, Public-Dateien, Cache und Builds liegen in einem eigenen temporären Verzeichnis und werden nach dem Lauf entfernt.

Der Nachweis behauptet nur **JPEG-Eingabe → statische WebP-Varianten zur Build-Zeit**. Er ist eine synthetische Fixture, kein Produktionspaket und keine Änderung an `reisinger.pictures`. Die technische Manifestausgabe enthält Slug, Maße und generierte Variant-URLs/-Maße; YAML, Alt-/Beschreibungstexte und kuratierte EXIF-Daten sind nicht Teil der gemeinsamen Verarbeitung. Der Fixture-Verbraucher setzt sein rein synthetisches Alt-Text-Beispiel selbst. AVIF-Eingabe oder -Ausgabe wird nicht unterstützt oder beansprucht. Sharp wendet keine EXIF-Orientierung an; JPEGs mit Orientation-Tag können daher in gespeicherter Pixelorientierung statt gedreht gerendert werden. Ausgabe-WebP übernimmt keine EXIF-Metadaten.

Der Astro-Build-Nachweis wurde mit den in diesem Repository gepinnten Versionen **Astro 7.4.7** und **Sharp 0.35.5** ausgeführt; das ist keine Kompatibilitätszusage für andere Versionen. Die Sharp-Generator-Unit-Tests laufen unabhängig davon gegen dieselbe gepinnte Sharp-Version.

Die Varianten sind normale statische Dateien unter `/variants/`; Hosting und CDN müssen diese Pfade unverändert aus dem Astro-Build ausliefern. Da der vollständige Quellhash im Dateinamen steht, erhalten Pixeländerungen neue URLs und unveränderte Eingaben reproduzierbare URLs/Bytes. Ein CDN kann diese unveränderlichen URLs lang cachen; ein Deployment muss selbst entscheiden, wann nicht mehr referenzierte alte Dateien entfernt werden. Der unabhängige `astro:assets`-Prototyp oben bleibt davon getrennt: Sein privater `fsPath`-Adapter ist weiterhin eine nicht zugesicherte Astro-Implementierungsannahme und **nur prototype-only**, nicht Bestandteil oder Voraussetzung dieses statischen Sharp-Nachweises.

## Nicht integriert / spätere Arbeit

- Das Referenzprojekt lädt Bilder über Slugs und `src/images/image-service.ts` → `slug-map`. Dieser Spike verbindet sich **nicht** mit diesem Resolver oder dessen Metadaten und ändert keine Datei in `reisinger.pictures`. Die Test-Fixture nutzt eine eigene statische Slug-Tabelle.
- Kein produktiver Schreibpfad, Upload, allgemeiner AST-Editor, Authentisierung, Multi-User-/Race-Handling oder 1:1-Astro-Image-Wrapper.
- Eine spätere Migration ist als Planung-/Prüfprozedur unter `.agents/skills/astro-image-migration/SKILL.md` abgegrenzt. Sie sollte erst nach Bewertung der Resolver-Stabilität angewandt werden; dieser Spike startet keine produktive Migration.

## UI-Bausteine

Die UI nutzt daisyUI `card` für die Bereiche, `list` für die sortierbaren Einträge, `btn` für die Move-Aktionen und `alert` für Statusfeedback. Die Defaults bleiben neutral; die `alert`-Statusfarbe ist die semantische Feedback-Ausnahme.
