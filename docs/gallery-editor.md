# Galerie-Editor-Demo

Diese Demo erweitert den lokalen Galerie-Editor auf mehrere Galerien in einer einzelnen, synthetischen MDX-Seite. `src/pages/fixture.mdx` enthält Beispielprosa, Markdown und eine absichtlich unbekannte Astro-Komponente. Der Text ist vollständig erfunden; das ist keine Anbindung an `reisinger.pictures` oder an reale Inhalte.

## Unterstützte Form

Der Editor bearbeitet ausschließlich den fest verdrahteten Pfad `src/pages/fixture.mdx`. Client-Anfragen können keinen Datei- oder Verzeichnispfad angeben. Die Galerie-Arrays werden AST-gezielt gefunden und nur dann akzeptiert, wenn:

- genau ein Default-Import aus der konfigurierten Galerie-Quelle als Galerie-Identität dient (ein lokaler Import-Alias ist erlaubt),
- jede erkannte Galerie genau ein `sorted={ARRAY_NAME}` hat; ihre interne Editor-ID stammt aus dem eindeutig gebundenen Array-Export,
- ein optionales statisches `id` exakt `ARRAY_NAME` entspricht,
- `ARRAY_NAME` genau einmal als direkte, einzelne `export const`-Deklaration vorkommt,
- der Export ein nicht-leeres Array aus eindeutigen String-Literalen ist; der Parser kennt keine Slug-Liste,
- das Array ausschließlich als `sorted`-Wert dieser Galerie verwendet wird.

Mehrfach verwendete Arrays, Spread-Attribute, dynamische Werte, mehrdeutige Exporte, Kommentare und leere oder doppelte Werte innerhalb eines Arrays werden fail-closed abgelehnt. Nicht verbundene JSX-Komponenten werden nicht als Galerien interpretiert. Das ist absichtlich eine kleine unterstützte MDX-Teilmenge, kein allgemeiner MDX-Editor.

Der Patchbereich stammt aus dem JavaScript-AST innerhalb des zugehörigen MDX-ESM-Blocks. Nur das ausgewählte Array wird ersetzt; alle Quellzeichen außerhalb dieses Bereichs bleiben erhalten. Jeder Schreibvorgang verlangt den aktuellen SHA-256-Hash. Ein veralteter Hash führt zum Konflikt statt zu einem Überschreiben.

Die Parser-API verwendet standardmäßig `../components/Gallery.astro`. Vertrauenswürdiger Servercode kann pro Aufruf eine andere relative Importidentität vorgeben: `inspectFixture(source, { galleryImportSource: '../../content/components/Gallery.astro' })`; `patchFixtureSource` nimmt dieselbe Option als fünftes Argument. Die Option wird nicht aus MDX oder HTTP-Anfragen gelesen und akzeptiert nur relative Modul-Spezifizierer, keine absoluten Dateipfade oder URLs. Die Identität wird gegen den AST-Importtext geprüft; der Parser löst den Import nicht auf und greift nicht auf Dateien zu.

## Bedienung und Vorschau

Die UI lässt eine Galerie auswählen und deren Einträge nativ per Drag-and-drop oder mit ↑/↓-Buttons sortieren. Der Dev-Server speichert nur die interne Binding-ID, die Reihenfolge und den erwarteten Hash. Die Demo-Fixture hat absichtlich dieselbe MDX-Form wie `<Gallery sorted={SORTING} />` ohne `id`. Preview-Readiness hängt daher nicht von einem Source-`id`-Prop ab: sie prüft die erwartete Anzahl und Reihenfolge der gerenderten Galerie-Marker.

Der Editor-Server ist auf Loopback beschränkt, prüft Host und Origin, begrenzt Request-Größe und akzeptiert nur die erwarteten JSON-Felder. Anders als der generische Parser validiert der feste Demo-Server Bild-Slugs gegen das bestehende `FIXTURE_IMAGE_SLUGS`-Manifest; unbekannte Bilder werden nicht an die Galerie weitergereicht. Der Resolver verweigert außerdem nicht vorhandene Dateien. Der bestehende Export `FIXTURE_IMAGE_SLUGS` bleibt für Bildauflösung und Build-Verifikation kompatibel. Der Server verweigert den Start bei `NODE_ENV=production`; das sind Grenzen dieser lokalen Demo, keine Produktions-Sicherheits- oder CMS-Zusage.

## Tests und Grenzen

`pnpm test` prüft die AST-Teilmenge, Originalbereichserhalt, stale hashes, unbekannte JSX-Komponenten, beliebige synthetische Parser-Slugs, serverseitige Manifestgrenzen, Mehrfachverwendung, UI-Skript-Handler und einen HTTP-E2E-Ablauf mit Astro-Rendern und Multi-Galerie-Preview-Readiness. Der E2E-Test bedient keinen echten Browser; Drag-and-drop und Tastaturaktionen werden nicht per Playwright simuliert. Diese Demo verspricht weder einen allgemeinen MDX-Parser noch produktiven Betrieb.
