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

Ohne diese Serveroptionen bleibt die bisherige Galerie-Demo unverändert und `GET /api/collections` meldet `configured: false`. HTTP-Anfragen können weder Projekt-/Config-/Entry-Pfade noch Importidentitäten setzen. Die Config wird mit Babel analysiert, nie importiert oder ausgeführt. Unterstützt wird nur ein exportiertes statisches Literal-`collections`-Objekt mit direkt importiertem `defineCollection`, statischem `glob()`-Loader und direktem `z.object({...})`. Erkennung der kleinen Feldteilmenge ist Metadaten-Erkennung, **keine** Ausführung oder vollständige Zod-Validierung.

Die Serverintegration katalogisiert höchstens 250 passende Einträge je Collection, 64 Collections, 500 Einträge/16 MiB insgesamt und 20.000 gescannte Verzeichniseinträge pro Inspection. Sie gibt nur IDs relativ zur Collection-Base sowie SHA-256-Hashes aus, keine absoluten Pfade oder Quelltexte. Einträge sind ausschließlich `.md`/`.mdx`; aktuell bewiesene Pattern sind exakt `*.md`, `*.mdx`, `**/*.md` und `**/*.mdx`. Andere Globs/Loader bleiben mit sichtbarem Grund read-only. Config-Datei, Base-Verzeichnisse, alle geprüften Vorfahren und passende Dateien müssen reguläre, nicht-symlinkte Pfade strikt innerhalb des absoluten Projektroots sein. Symlinks, fehlende Roots, Traversal, nicht unterstützte Patterns und übergroße Dateien lassen die betroffene Config/Collection read-only. Config-/Entry-Quellen sind auf 1 MiB, JSON-Requests auf 8 KiB begrenzt.

Im UI können vorhandene Top-Level-Frontmatter-Skalare bearbeitet werden, wenn das direkt erkannte Schema `string`, endliche `number`, `boolean` oder ein statisches String-`enum` vorgibt. `date`, Arrays und unsichere Feldnamen bleiben read-only. Der Server verlangt Collection-ID, relative Entry-ID, Feld, JSON-Skalar und erwarteten Content-Hash; er löst den Eintrag selbst erneut unter der konfigurierten Base auf, prüft Glob-Mitgliedschaft und analysiert Config und YAML erneut. Preview zeigt nur den exakten Skalarbereich. Es wird ausschließlich nach expliziter Bestätigung mit derselben Session, Preview-ID und Operation geschrieben. Stale Hashes liefern 409. Preview, Cancel und abgelehnte Operationen schreiben nicht. Same-origin/Host-Prüfungen, Session-Token, JSON-Schema-/Größenlimits und die CSP gelten auch für diese Endpunkte.

`planCollectionCreation(...)` und `planCollectionFieldExtension(...)` bleiben Diff-Planer, keine Writer. Collection-Erstellung und Schema-Erweiterung sind in dieser Phase ausdrücklich read-only; es gibt dafür keine Commit-Route. Nach einer künftigen bestätigten Schema-/Collection-Konfigurationsänderung muss der Nutzer Astros Content Sync bzw. Dev-Server-Neustart prüfen. Beim Commit wird die Config direkt vor dem Entry-Writer erneut gehasht und die Entry-Mitgliedschaft nochmals geprüft; zwischen dieser Prüfung und Rename bleibt eine lokale TOCTOU-Race möglich. Der Writer erhält die vorhandenen POSIX-Rechte des Entry-Files, aber keine sonstigen Metadaten. Er ist kein prozessübergreifendes Compare-and-Swap. Die Astro-Versionen, vollständige Zod-/Astro-Validierung, umfassendere Globs, symlink-freie TOCTOU-Garantien und ein sicherer Mehrprozessbetrieb sind nicht abgedeckt. Dies ist ein lokaler Prototyp und **keine** Produktionsfreigabe.
