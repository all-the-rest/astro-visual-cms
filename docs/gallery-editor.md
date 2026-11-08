# Galerie-Editor-Demo

Diese Demo erweitert den lokalen Galerie-Editor auf mehrere Galerien in einer einzelnen, synthetischen MDX-Seite. `src/pages/fixture.mdx` enthält Beispielprosa, Markdown und eine absichtlich unbekannte Astro-Komponente. Der Text ist vollständig erfunden; das ist keine Anbindung an `reisinger.pictures` oder an reale Inhalte. Dies bleibt ein **Prototyp**, kein produktionsreifes CMS.

## Unterstützte Form

Der Editor bearbeitet ausschließlich den fest verdrahteten Pfad `src/pages/fixture.mdx`. Client-Anfragen können keinen Datei- oder Verzeichnispfad angeben. Die Galerie-Arrays werden AST-gezielt gefunden und nur dann akzeptiert, wenn:

- genau ein Default-Import aus der konfigurierten Galerie-Quelle als Galerie-Identität dient (ein lokaler Import-Alias ist erlaubt),
- jede erkannte Galerie genau ein `sorted={ARRAY_NAME}` hat; ihre interne Editor-ID stammt aus dem eindeutig gebundenen Array-Export,
- ein optionales statisches `id` exakt `ARRAY_NAME` entspricht,
- `ARRAY_NAME` genau einmal als direkte, einzelne `export const`-Deklaration vorkommt,
- der Export ein nicht-leeres Array aus eindeutigen String-Literalen ist; der Parser kennt keine Slug-Liste,
- das Array ausschließlich als `sorted`-Wert dieser Galerie verwendet wird.

Mehrfach verwendete Arrays, Spread-Attribute, dynamische Werte, mehrdeutige Exporte, Kommentare und leere oder doppelte Werte innerhalb eines Arrays werden fail-closed abgelehnt. Nicht verbundene JSX-Komponenten werden nicht als Galerien interpretiert. Dynamisches, mehrdeutiges oder sonst nicht unterstütztes MDX bleibt **read-only**. Das ist absichtlich eine kleine unterstützte MDX-Teilmenge, kein allgemeiner MDX-Editor.

Der Patchbereich stammt aus dem JavaScript-AST innerhalb des zugehörigen MDX-ESM-Blocks. Ein einzelnes führendes UTF-8-BOM wird für das MDX-Parsing entfernt und bei der Rückabbildung der AST-Offsets als ein UTF-16-Codepunkt berücksichtigt; es bleibt in den Quelldaten erhalten. CRLF und Unicode vor oder nach dem Zielbereich bleiben unverändert. Nur das ausgewählte Array wird ersetzt; alle Quellzeichen außerhalb dieses Bereichs bleiben erhalten. Eine identische angeforderte Reihenfolge liefert exakt die ursprüngliche Quelle und den ursprünglichen Hash mit `diff: null` – es gibt weder Formatierungs- noch Schreibvorgang. Der Adapter parst auch die Ausgabe erneut, bevor er sie zurückgibt.

Die Diff-Offsets in der Preview sind JavaScript-String-/UTF-16-Codeeinheiten, keine UTF-8-Bytepositionen. Der Preview-Response enthält den exakten Bereich `before`/`after`, Offsets, Hashes und eine kurzlebige Preview-ID; er enthält weder vollständigen Quelltext noch Dateipfad.

## Writer und Konfliktgrenze

Der Dateischreiber liest die Originalbytes und prüft den erwarteten SHA-256-Hash, schreibt die neue Quelle in eine zufällig benannte temporäre Datei im selben Verzeichnis und prüft den Hash der Originaldatei unmittelbar vor dem atomaren Rename erneut. Fehlt die exakte kleingeschriebene 64-stellige Hash-Angabe oder stimmt eine Prüfung nicht, gibt es `STALE_HASH` (HTTP 409) und keinen Commit; Fehler räumen die temporäre Datei bestmöglich auf. Der injizierbare Dateisystemvertrag des Writers umfasst nur `readFile`, `writeFile`, `rename` und `unlink`.

Es bleibt ein nicht eliminierter Race-Abschnitt zwischen der letzten Hashprüfung und `rename`: Ein externer Schreiber kann in genau diesem Abschnitt noch ändern, und der Rename kann diese Änderung ersetzen. Der Demo-Server ist für einen einzelnen lokalen Prozess gedacht. Der doppelte Hash-Check und der atomare Rename sind **kein** prozessübergreifendes Compare-and-Swap und keine Produktionsgarantie.

## Adapter-Vertrag

`createGalleryPatchAdapter({ galleryImportSource })` bindet eine vom vertrauenswürdigen Server vorgegebene Galerie-Importidentität und liefert:

- `inspect(source)` mit `{ galleries: [{ id, order }], hash }`.
- `patch(source, galleryId, requestedOrder, expectedHash)` mit `{ source, galleries, hash, diff }`; `diff` ist bei No-op `null`, andernfalls `{ start, end, before, after }`.

`patch` akzeptiert ausschließlich dieselben eindeutigen Slugs in anderer Reihenfolge und verlangt den aktuellen SHA-256-Hash der vollständigen Quelle. Ein fehlender, ungültiger oder veralteter Hash führt zu `STALE_HASH`; der Adapter schreibt nicht selbst auf die Festplatte. Beim Anwenden ersetzt er nur den AST-basiert ermittelten Arraybereich und validiert das Ergebnis erneut. Die bisherigen `inspectFixture`- und `patchFixtureSource`-Exports bleiben als kompatible Wrapper erhalten.

Die standardmäßige Importidentität ist `../components/Gallery.astro`. Nur vertrauenswürdiger Servercode darf beim Erzeugen eines Adapters eine andere relative Modulidentität konfigurieren, z. B. `createGalleryPatchAdapter({ galleryImportSource: '../../content/components/Gallery.astro' })`. Die Konfiguration wird gegen relative Modul-Spezifizierer validiert, nicht aus MDX oder HTTP-Anfragen übernommen. Die Identität wird gegen den AST-Importtext geprüft; der Parser löst den Import nicht auf und greift nicht auf Dateien zu.

Der HTTP-Client kann für eine Preview nur `galleryId`, `order` und `hash` senden. Der Server lehnt zusätzliche Felder ab, verwendet ausschließlich den fest kodierten Pfad `src/pages/fixture.mdx` und reicht keinen Client-Pfad oder eine Client-Importidentität an den Adapter weiter. Für diese lokale Demo prüft er Slugs zusätzlich gegen das synthetische Bildmanifest. Diese Ressourcen-Allowlist ist Serverkonfiguration, kein Teil der generischen Parser-API.

## Bedienung, Diff-Bestätigung und Vorschau

Die UI lässt eine Galerie auswählen und deren Einträge nativ per Drag-and-drop oder mit ↑/↓-Buttons sortieren. Ein Sortiervorgang ruft zuerst `POST /api/preview` auf. Der Server prüft aktuelle Quelle und Adapter, erzeugt eine kurzlebige, einmal verwendbare Preview-Bindung und liefert nur die beschriebene Änderung. Die UI zeigt `before`/`after`; erst der explizite Bestätigungsbutton sendet `POST /api/commit`.

Commit verlangt dieselbe Session, Preview-ID und dieselbe Operation. Der Server prüft erneut den Quellhash, erzeugt denselben Patch erneut, vergleicht Diff und Ergebnis-Hash mit der bestätigten Preview, validiert die Ausgabe erneut mit MDX-/Galerieadapter und Bildmanifest und ruft erst dann den bestehenden atomaren Writer auf. Eine Änderung nach der Vorschau liefert HTTP 409 und lässt die externe Änderung bestehen. Der frühere direkte `/api/reorder`-Schreibweg existiert nicht mehr.

Die Demo-Fixture hat absichtlich dieselbe MDX-Form wie `<Gallery sorted={SORTING} />` ohne `id`. Preview-Readiness hängt daher nicht von einem Source-`id`-Prop ab: sie prüft die erwartete Anzahl und Reihenfolge der gerenderten Galerie-Marker. Die lokale Vorschau bietet Desktop-, Tablet- und Mobil-Presets mit tatsächlichen iframe-Viewportmaßen (1280×800, 768×1024 und 390×844) und feste Navigation zwischen synthetischer Start- und Fixture-Seite. Routen werden aus vertrauenswürdigen Konstanten zusammengesetzt; es gibt kein URL-Eingabefeld.

Der Editor-Server ist auf Loopback beschränkt, prüft für Requests den Host und für schreibende POSTs zusätzlich Origin, JSON-Content-Type und Session-Token. Request-Größe und Body-Schema sind begrenzt. Bei jedem Serverstart wird ein kryptografisch zufälliges 32-Byte-Session-Token erzeugt. Das Editor-HTML holt es über `GET /api/session` vom gleichen lokalen Ursprung; Preview und Commit verlangen es im Header `x-editor-token`, der Vergleich erfolgt konstantzeitlich. State- und Fehler-JSON enthalten das Token nicht. Nach einem Serverneustart lädt die UI bei einem 403 die Sitzung und den State erneut. Das Token ist ein zusätzlicher Schutz für diese lokale Editor-Session, kein Ersatz für die übrigen Herkunftsprüfungen.

Das Editor-Dokument nutzt eine restriktive CSP: Inline-Editor-Skript nur mit zufälliger Nonce, APIs nur same-origin, Stylesheet und Iframe nur vom konfigurierten Astro-Origin; es gibt kein Wildcard-CORS.

`ASTRO_BASE_PATH` konfiguriert den Astro-Basispfad, z. B. `/demo/`. Werte mit Traversal, Query, Hash, Prozentkodierung oder unsicheren Segmenten werden abgelehnt. Astro, Bild-URLs, Editor-Stylesheet, feste Iframe-Routen und der serverseitige Preview-Ready-Abruf verwenden denselben normalisierten Pfad. Eine dev-only Astro-Integration bindet Astros eigenen Dev-Server zusätzlich an `127.0.0.1`. Sie registriert keine Routen, Client-Skripte oder Schreiblogik und verändert weder `build` noch `preview`.

Der eigenständige Server meldet einen belegten Port verständlich und beendet sich mit Fehlerstatus; bei SIGINT/SIGTERM schließt er den HTTP-Server geordnet. Scheitert das anfängliche Laden von `/api/state`, zeigt die UI den Fehler und versucht es alle zwei Sekunden erneut. Anders als der generische Parser validiert der feste Demo-Server Bild-Slugs gegen das bestehende `FIXTURE_IMAGE_SLUGS`-Manifest; unbekannte Bilder werden nicht an die Galerie weitergereicht. Der Resolver verweigert außerdem nicht vorhandene Dateien. Der bestehende Export `FIXTURE_IMAGE_SLUGS` bleibt für Bildauflösung und Build-Verifikation kompatibel. Der Server verweigert den Start bei `NODE_ENV=production`; das sind Grenzen dieser lokalen Demo, keine Produktions-Sicherheits- oder CMS-Zusage.

## Tests und Grenzen

`pnpm test` prüft die AST-Teilmenge, LF/CRLF, Unicode, BOM, Kommentare, No-op, Originalbereichserhalt, stale/malformed hashes, Preview-/Bestätigungsablauf, Konflikte ohne Überschreiben, unbekannte JSX-Komponenten, serverseitige Manifestgrenzen, CSP/Host/Origin/Token, sichere Basispfade und eine echte Präfixroute in einer isolierten synthetischen Astro-App. Separate Writer-Tests prüfen stale Hash ohne Schreibzugriff, externe Änderung zwischen den beiden Reads (kein Rename, Temp-Datei entfernt), exakte Bytes im Happy Path und die dokumentierte verbleibende Race-Grenze (Änderung direkt vor Rename wird überschrieben). Der HTTP-E2E-Test nutzt einen Präfixpfad, wartet auf Astros gerenderte Galerien und bestätigt, dass externe Änderungen nach einer Preview erhalten bleiben. `pnpm run verify:build` prüft zusätzlich, dass das statische Produktions-Build keine lokalen Editor/API-Routen oder Editor-UI enthält. `pnpm run browser-tests` prüft im Browser CSP, Presets, Routenwechsel, Diff-Bestätigung, HMR/Readiness und Reorder. Diese Demo verspricht weder einen allgemeinen MDX-Parser noch produktiven Betrieb.

## Phase 3: Collection-Editor (experimentell, nicht produktionsreif)

Die Collection-Ansicht ist nur aktiv, wenn vertrauenswürdiger Servercode `createEditorServer` mit **beiden** Optionen `projectRoot` (absoluter Projektpfad) und `contentConfigPath` (relativ dazu oder absolut innerhalb davon) erzeugt. Beispiel für einen projektspezifischen Dev-Launcher:

```js
createEditorServer({
  projectRoot: '/absoluter/pfad/zum/vertrauenswuerdigen-astro-projekt',
  contentConfigPath: 'src/content.config.mjs',
})
```

Ohne diese Serveroptionen bleibt die bisherige Galerie-Demo unverändert und `GET /api/collections` meldet `configured: false`. HTTP-Anfragen können weder Projekt-/Config-/Entry-Pfade noch Importidentitäten setzen. Die Config wird mit Babel analysiert, nie importiert oder ausgeführt. Unterstützt wird nur ein exportiertes statisches Literal-`collections`-Objekt mit direkt importiertem `defineCollection`, statischem `glob()`-Loader und direktem `z.object({...})`. `defineCollection()` darf direkt im Objekt stehen oder über eine unveränderte, ausschließlich dort referenzierte top-level `const` gebunden sein. `z` wird aus `astro:content` oder `astro/zod` akzeptiert. Andere/referenziell mehrfach verwendete Bindings bleiben read-only. Erkennung der kleinen Feldteilmenge ist Metadaten-Erkennung, **keine** Ausführung oder vollständige Zod-Validierung.

Die Serverintegration katalogisiert höchstens 250 passende Einträge je Collection, 64 Collections, 500 Einträge/16 MiB insgesamt und 20.000 gescannte Verzeichniseinträge pro Inspection. Sie gibt nur IDs relativ zur Collection-Base sowie SHA-256-Hashes aus, keine absoluten Pfade oder Quelltexte. Einträge sind ausschließlich `.md`/`.mdx`; aktuell bewiesene Pattern sind exakt `*.md`, `*.mdx`, `**/*.md` und `**/*.mdx`. Andere Globs/Loader bleiben mit sichtbarem Grund read-only. Config-Datei, Base-Verzeichnisse, alle geprüften Vorfahren und passende Dateien müssen reguläre, nicht-symlinkte Pfade strikt innerhalb des absoluten Projektroots sein. Symlinks, fehlende Roots, Traversal, nicht unterstützte Patterns und übergroße Dateien lassen die betroffene Config/Collection read-only. Config-/Entry-Quellen sind auf 1 MiB, JSON-Requests auf 8 KiB begrenzt.

Im UI können vorhandene Top-Level-Frontmatter-Skalare bearbeitet werden, wenn das direkt erkannte Schema `string`, endliche `number`, `boolean` oder ein statisches String-`enum` vorgibt. `date`, Arrays und unsichere Feldnamen bleiben read-only. Der Server verlangt Collection-ID, relative Entry-ID, Feld, JSON-Skalar und erwarteten Content-Hash; er löst den Eintrag selbst erneut unter der konfigurierten Base auf, prüft Glob-Mitgliedschaft und analysiert Config und YAML erneut. Preview zeigt nur den exakten Skalarbereich. Es wird ausschließlich nach expliziter Bestätigung mit derselben Session, Preview-ID und Operation geschrieben. Stale Hashes liefern 409. Preview, Cancel und abgelehnte Operationen schreiben nicht. Same-origin/Host-Prüfungen, Session-Token, JSON-Schema-/Größenlimits und die CSP gelten auch für diese Endpunkte.

`planCollectionCreation(...)` bleibt diff-only. Die API bietet Preview/Commit/Cancel für genau eine neue statische glob Collection über `/api/collections/config/create/{preview,commit,cancel}` sowie bestehende Ein-Feld-Erweiterungen über `/api/collections/config/{preview,commit,cancel}`. Das lokale Editor-UI bietet dafür nun capability-gesteuerte Formulare mit expliziter Bestätigung des exakten Source-Diffs. Es bietet keine nicht unterstützten Optionen und erstellt weder Ordner noch Content. Das Gesamtwerkzeug bleibt experimentell und **nicht produktionsreif**. Die Collection muss einen bereits vorhandenen, regulären, symlinkfreien Basisordner innerhalb des Projektroots verwenden; der Editor erstellt weder Ordner noch Content-Dateien. Clients liefern nur statische Collection-/Feldwerte und den aktuellen Config-Hash; Config-Pfad, Importidentitäten und Loader bleiben serverseitig vertrauenswürdig und die nötigen Imports müssen bereits explizit vorliegen. Nicht unterstützte oder dynamische Config-Syntax bleibt read-only. Antworten enthalten nur den exakten Quellbereich-Diff, weder Config-Inhalt noch absolute Pfade. Nach einer bestätigten Config-Änderung müssen Astro Content Sync bzw. der Dev-Server-Neustart geprüft werden. Beim Commit wird die Config unmittelbar vor dem Writer erneut geplant/gehasht. Der Writer erhält vorhandene POSIX-Rechte, aber keine sonstigen Metadaten; er ist kein prozessübergreifendes Compare-and-Swap. Vollständige Zod-/Astro-Validierung, symlink-freie TOCTOU-Garantien und sicherer Mehrprozessbetrieb sind nicht abgedeckt. Dies ist ein lokaler Prototyp und **keine** Produktionsfreigabe.
# Phase 4 adapter experiment (not production-ready)

`src/lib/mdx-props-patch.mjs` provides an isolated, source-preserving adapter for
configured imported MDX components. Its trusted configuration binds one default
import module specifier (the local JSX binding is taken from that import), static
`id` identity prop, and explicit
editable prop allow-list. Only existing, JSON-compatible quoted string props can
be patched; dynamic values, spreads, duplicate identities, unknown props, and
unsupported imports are read-only. The adapter replaces only the literal range.
It does not evaluate MDX or configuration and accepts no filesystem path.

The dev-only server can optionally receive `mdxComponentTargets`, an array of
trusted `{ id, projectRoot, filePath, importSource, idProp, editableProps }`
records. Roots and absolute target files are configuration-only, validated at
startup and before access; symlink paths are rejected. `GET /api/mdx-components`
returns a path-free catalog. Authenticated `POST /api/mdx-components/preview`
and `/commit` use exact operation schemas, the same origin/host/token guards and
8 KiB request limit as other writes, at most 16 configured targets, 1 MiB per
source, 500 matching component instances, and one-shot five-minute preview bindings. No write
occurs until a matching explicit commit; stale sources conflict. The API is
experimental and exposed in the editor when configured targets are present. The
UI limits edits to catalogued instances and allow-listed props, previews the exact
source delta, and writes only after explicit confirmation. Unsupported MDX syntax remains
read-only. Writer lifecycle limitations described above still apply; do not use
this with real content or treat it as production-ready, and make no readiness
claim. JavaScript shadowing and every MDX binding ambiguity are not resolved.

`pnpm run browser-tests:readonly` separately runs a browser acceptance check in
a temporary copy of this tracked Astro project (with repo-local dependencies
linked, no install/network). It introduces duplicate static IDs in that copy and
checks this exact duplicate-ID case fails closed in Astro 7.4.7. It does not
establish general output provenance, compatibility, or production readiness.

`pnpm run browser-tests:unmapped` uses a separate copy and changes only the
synthetic component's rendered marker identity (`id.toUpperCase()`), leaving
the source catalog valid. Clicking that transformed output must show an explicit
read-only explanation, disable the MDX editing controls, and issue no preview or
commit request. This proves fail-closed behavior for this one marker mismatch;
it does not derive or establish general DOM-to-source provenance.

`pnpm run browser-tests:gallery-copy` adds an unknown Astro wrapper around one
literal gallery in another temporary copy, commits a reorder through the editor,
and checks the exact copied-MDX delta plus the rendered order after Astro
recompiles the route. It then changes the copied gallery to a JSX spread and
checks that both catalog inspection and the authenticated preview endpoint
reject it without changing the copied source. The tracked fixture and component
are asserted byte-identical throughout. This remains a synthetic fixture on the
repository's pinned Astro version—not a claim of compatibility with an external
project or general MDX support.

`pnpm run browser-tests:collection-copy` adds a synthetic static MDX glob
collection and Astro content route only inside another temporary copy. It checks
the path-free collection catalog, edits one existing string frontmatter field
through preview and explicit confirmation, verifies no write occurs before
confirmation, and checks the exact copied-entry delta and Astro-rendered value
after Content Sync. The MDX body, component output, rank field, copied config and
route source, and tracked fixture/component are checked unchanged. This is
limited to the repository's pinned Astro/MDX setup and does not establish
external consumer compatibility or production readiness.

The Phase 5 in-context selection proof is opt-in at the rendered-node level: a
trusted component may render `data-astro-visual-cms-target` and
`data-astro-visual-cms-instance` only when it can preserve the exact configured
source target identity. The browser proof configures exactly one synthetic
`EditorUnknownChip` target in its test harness; that component emits marker IDs
from literal MDX `id` props. The dev-only Astro bridge and editor accept
selection messages only from the exact preview frame/origin with a per-load
nonce, then resolve both IDs against the actual server-loaded supported MDX
catalog. The test exercises the real preview/commit API, verifies the exact
source delta and confirms the saved value appears in the Astro iframe. Normal
standalone startup still configures no MDX targets; embedding applications must
provide trusted targets server-side. No marker means no selection. This is not
general DOM-to-source provenance and does not support computed, repeated or
ambiguous output, real-project compatibility, or production readiness.

`pnpm run browser-tests:markdown-copy` adds one explicitly configured plain-text
paragraph to an isolated Astro 7.4.7 copy. Its marker is emitted by the pinned
Sätteri MDX `mdastPlugins` pipeline only in `dev`, for the exact configured MDX
file, after parsing verifies a single paragraph with an exact source range. The
test selects it through the nonce-bound preview bridge, previews and confirms a
single text-range patch, checks Astro's rerender, and verifies a second paragraph
removes the marker and is rejected by the edit API without a write. Formatting,
links, JSX, expressions, multiline text, multiple nodes, and processor setups
without the supported Sätteri hook are refused at dev startup when an editable
Markdown target is configured. This is one synthetic,
version-pinned acceptance slice; external Astro/MDX consumer compatibility and
production readiness remain unverified.

### External static Markdown collection probe (2026-11-08)

The real project `/projects/powerbros.at` is pinned to Astro 7.2.4 and declares
two `glob()` Markdown collections through top-level `const` bindings, with `z`
imported from `astro/zod`. On a temporary content/config copy (not the project
checkout), discovery found two editable collections; `referenzen` had 12
entries and its `event` field was editable. The API probe previewed one field
without writing, confirmed a byte-exact single-scalar patch, then introduced a
competing copied-file edit and observed HTTP 409 with those bytes preserved. The
original entry SHA-256 stayed unchanged.

A separate full temporary project copy retained the installed dependency graph
and imported `createLoopbackDevIntegration()` from the local worktree by file
URL (no package installation or original config change). Its `pnpm run build`
completed successfully, including `astro check`, and generated files contained
neither the bridge challenge nor the integration identifier. `astro dev` served
`/referenzen/`; editing a copied Markdown entry caused its updated value to
appear through the live route after Content Sync/HMR. Recorded probe output:
`PROJECT_BUILD=PASS; Astro check passed=true; production bridge absent=true`,
`DEV_ROUTE=PASS`, and `CONTENT_SYNC_HMR=PASS (true)`. All temporary copies were
removed; the external worktree remained clean and the tested entry retained
SHA-256 `f0e5a8da81aa080121a3dcc64e7603ec56641ce10972c8c3477a5d1d79e1130b`.
This establishes one external project's local-source integration, production
isolation, and static Markdown file-change HMR slice. A combined follow-up ran
the external editor API and Astro dev server together after the copied project
build: `EDITOR_PREVIEW_NO_WRITE=true`, `CONFIRMED_SOURCE_PATCH_EXACT=true`, and
`EDITOR_COMMIT_TO_ASTRO_CONTENT_SYNC_HMR=true`. One no-build attempt against the
copied pnpm dependency tree returned a ClientRouter "No cached compile metadata"
500; rerunning after the copy's successful project build passed. This copy-only
metadata behavior is not established for a normally installed project.

These probes do not establish a distributable package install, a configured MDX
target, browser iframe/editor interaction, MDX compatibility, ClientRouter/
navigation behavior, broader external compatibility, or production readiness.
The project has no `@astrojs/mdx` dependency.
