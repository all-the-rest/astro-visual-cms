# Editor package (development only)

Install the package tarball in an Astro project with `npm install /path/to/astro-visual-cms-editor-0.1.0.tgz` (or use the published package name once a release is published). The integration is deliberately dev-only: it injects the loopback bridge only for `astro dev`, and the editor write server refuses to start under `NODE_ENV=production`.

```js
// astro.config.mjs
import { defineConfig } from 'astro/config'
import { createLoopbackDevIntegration } from '@astro-visual-cms/editor/integration'

export default defineConfig({ integrations: [createLoopbackDevIntegration({
  editorPort: 4322,
  previewRoutes: [{ id: 'home', path: '/' }, { id: 'references', path: '/referenzen/' }],
})] })
```

Start the server with trusted, project-owned JSON configuration (never derive these values from browser input):

```json
{
  "port": 4322,
  "sitePort": 4321,
  "projectRoot": ".",
  "contentConfigPath": "src/content.config.ts",
  "fixturePath": "src/pages/fixture.mdx",
  "previewRoutes": [{ "id": "references", "label": "Referenzen", "path": "/referenzen/" }]
}
```

Run `npx astro-visual-cms-editor --config ./avcms-editor.json` (or invoke `node_modules/@astro-visual-cms/editor/src/editor/cli.mjs --config ...`). Paths in the JSON file are resolved relative to that file. `projectRoot` and `contentConfigPath` must be supplied together; route lists are validated as trusted same-origin paths. The toolbar registers `Seite bearbeiten` only during `astro dev`, opens a separate local editor tab, maps only exact trusted preview paths to route IDs, and leaves the preview tab untouched. If Astro's toolbar is disabled or unavailable, start the same CLI and open `http://127.0.0.1:4322/` directly (use the configured editor port if different). A no-token `/api/health` endpoint allows only the configured local preview origin; POST origin, host, content-type, and session-token guards are unchanged. The server module is also available at `@astro-visual-cms/editor/server` for callers that need direct `createEditorServer(options)` control.

V1 is supported only alongside the local `astro dev` server. The integration does not register its bridge or toolbar for build/preview, but the standalone editor is a separate process: starting it manually while a production/preview process runs may still enable local source writes if the editor process itself does not have `NODE_ENV=production`. That mode is unsupported; do not run the editor against a production site or expose it to a network. Current loopback/origin/session controls are not production authentication. Any future production/remote mode is tracked for V2 in [issue #13](https://github.com/all-the-rest/astro-visual-cms/issues/13).

For an imported MDX component, trusted editor JSON can declare scalar fields:

```json
{"mdxComponentTargets":[{"id":"home-hero","projectRoot":".","filePath":"src/content/home.mdx","importSource":"../../components/Hero.astro","idProp":"cmsId","fields":[{"name":"heading","type":"string","label":"Heading"},{"name":"priority","type":"number","min":1,"max":5,"step":1},{"name":"visible","type":"boolean"},{"name":"tone","type":"enum","values":["light","dark"]}]}]}
```

`editableProps: ["heading"]` remains shorthand for string fields. Only the documented static literal forms are editable; unconfigured props are preserved but never exposed for editing. Spreads and dynamic expressions in configured fields remain read-only, and component code is never evaluated. See [gallery-editor.md](gallery-editor.md) for the exact boundary.

The editor's gallery API remains the original bounded demo fixture adapter; custom preview route selection and static content collection discovery do not make it a general-purpose content editor. Use an actual fixture file conforming to the existing supported demo shape if the gallery UI/API is enabled. MDX paragraph and component adapters support only their explicitly configured syntaxes; this package does not claim general MDX compatibility.

Gallery, Content Collections, and configured MDX component panels load independently. If `fixturePath` is absent from the bounded Gallery syntax or is unsupported, the editor reports that Gallery panel as unavailable but still loads other configured panels; the same source file may be used as a path anchor without being a Gallery fixture.

Supported static `glob()` collections also expose a confirmed “new Markdown entry” workflow when every required schema field is in the scalar string/number/boolean/enum subset or has a static default. The filename is a single lowercase slug; nested paths, rich fields and unsupported schemas remain unavailable/read-only. The editor previews the generated YAML frontmatter before confirmation, revalidates the trusted collection config, and creates by exclusive hard link so an existing path is never replaced. Optional/defaulted values are omitted/applied according to the discovered schema; Astro Content Sync is responsible for refreshing the collection after creation.

Verified integration/build points: Astro 7.2.4 and 7.4.7. The peer range `>=7.2.4 <8` is intentionally conservative within the verified major; it is not a claim that every version in that range has been tested. Astro is an optional peer because the server-only API does not require Astro. The package declares Node >=22.12; the package-consumer smoke was run on Node 26.10.0.

`npm run pack:smoke` packs the actual npm tarball, checks its allowlisted contents, installs it into a disposable Astro 7.4.7 consumer with `@astrojs/mdx`, and starts the installed-package editor. It confirms a new static `glob()` collection by exact config diff, creates a Unicode YAML entry only after preview confirmation, then runs an Astro production build and verifies the new collection route renders that entry. It also builds a synthetic MDX page, starts Astro dev, and verifies collection discovery, exact numeric-field preview/commit, source-byte preservation, the live Content Sync reorder and new-entry render, the trusted custom route, Dev Toolbar route launch, and typed component controls with confirmed MDX edits after HMR even though its Gallery fixture is intentionally unsupported. This proves only those narrow adapters; it does not establish general MDX authoring/round-trip compatibility. The smoke launches Playwright Chromium; install it first with `npx playwright install chromium` when running locally.

In a separate full copy of the real Astro 7.2.4 `powerbros.at` project installed from the local tarball using pnpm, `astro check`/build passed. Through the editor, `referenzen/2024-08-20-porec.md` changed only `order: 1` to `order: 6` (87 bytes before and after); the running `/referenzen/` HTTP response reordered the 2024 rows to `Rovinj > Pula > Umag > Moosmayr > Porec`. The earlier string-field workflow also rendered “Quarter-Show JKU Astros — CMS smoke”. Synthetic Gallery fixture/config additions and all edits were confined to disposable copies; the original project remained untouched.

A fresh disposable copy additionally verified the typed custom-component workflow against Astro 7.2.4 with `@astrojs/mdx@7.0.0`: a real `.astro` component imported into a page-level MDX file rendered string, number, boolean, enum, and an unconfigured `className`; the editor previewed/confirmed a title change, changed only that quoted source literal, and Astro HMR rendered the new value. The same browser run opened the editor from Astro's actual Dev Toolbar, selected the configured `references` route in a separate tab, and fell back to the default route for an unmapped page. `pnpm run build`/Astro check passed with 0 errors, warnings, or hints.

The project's actual `src/components/Galerie.astro` internal `imageNames: GalleryImage[]` is now covered by the separate trusted `astroGalleryTargets` adapter (not the MDX-prop adapter). In another disposable Astro 7.2.4 copy, the API exposed all six literal `{ name, alt }` entries even though the unrelated demo `/api/state` fixture returned 422. The browser selected the configured Astro gallery, previewed and confirmed swapping the first two images, received HTTP 200, and Astro HMR rendered `Show Vereinte Kraft > Show Raus aus dem Alltag`. The copied source exactly matched the original apart from those two object literal slices swapping positions; the configured array's other source bytes were retained. `astro check`/build then passed with 0 errors, warnings, or hints. The original `Galerie.astro` and `content.config.ts` hashes remained `423737c3a19ab4817e855d75022bb01d6bed7f930ff3474999bfb93a8d534027` and `41d13df73fe583d1226de464076ecea444ba2bfa4ee1277a12f0f4d64a1d13bb`; the original git worktree remained clean.

A separate disposable Astro 7.2.4 `powerbros.at` copy verified the existing in-context source-mapping contract on a synthetic page-level MDX fixture and imported `.astro` component. The component emitted trusted `data-astro-visual-cms-target`/`data-astro-visual-cms-instance` markers for two static MDX IDs. Clicking the second rendered component selected exactly `source-map-two`; clicking an unmarked heading did not change selection, and selection itself issued no preview/commit request or source write. A confirmed label edit changed only the second literal, preserved its sibling, and updated the active Astro preview. This proves the explicit marker/configured-identity workflow in that consumer/version, not automatic provenance for the project's existing output or arbitrary DOM.

For no-op preservation, a unit regression covers a BOM/CRLF MDX source with Unicode frontmatter-like content, comments, imports, an opaque expression prop, and a nested unknown component. The configured unchanged prop returns `diff: null` and the exact original source; changing it patches only its quoted literal. The installed-tarball UI smoke also enters the current value, verifies the explicit “unchanged; nothing written” status, no confirmation panel or commit request, and byte-identical MDX source. This is limited to the configured scalar adapter, not a generic MDX open/save workflow.

`pnpm run verify:external-production` repeats the package-install/production-isolation check against `/projects/powerbros.at` in a disposable full-project copy (override the source with `ASTRO_CMS_CONSUMER=/path/to/astro/project`). It installs the actual local npm tarball, adds the dev-only integration to the copied Astro config, runs that project's normal production build without starting the editor, scans `dist` for toolbar, CMS UI, bridge, and write-API markers, then starts only `astro preview` and checks the real `/referenzen/` route plus 404s from the collection, MDX-component, Astro-gallery, and health endpoints. All source/config/content changes and build output stay in the temporary copy, which is removed on exit. This command requires an offline pnpm cache for the consumer and currently uses config anchors matching `powerbros.at`; it is a pinned external-project regression probe, not a generic compatibility test.

`pnpm run verify:licenses` is part of `pnpm run verify` and CI. It reads pnpm's resolved production dependency license report, fails on missing/mismatched metadata or licenses outside the reviewed MIT/ISC/BSD-3-Clause allowlist, and prints the package/version counts. The current graph has 117 package entries (120 resolved versions): 114 MIT, 2 ISC, and 1 BSD-3-Clause. This is an automated metadata/policy gate, not legal advice or a review of all development/build tools; re-review the resolved graph and any license-policy change before release.

The browser accessibility gate uses dev-only `@axe-core/playwright`/`axe-core` 4.14.0 (MPL-2.0); neither is a runtime dependency of the published editor package.
# Trusted Astro internal gallery arrays

For a component whose own Astro frontmatter declares a literal object array,
configure `astroGalleryTargets` separately from `mdxComponentTargets`:

```json
{
  "astroGalleryTargets": [{
    "id": "powerbrosGallery",
    "projectRoot": "../powerbros.at",
    "filePath": "src/components/Galerie.astro",
    "variableName": "imageNames",
    "identityProperty": "name",
    "labelProperty": "alt"
  }]
}
```

Paths are trusted server configuration, not browser input. This adapter only
supports one top-level `const` array of plain object literals in Astro
frontmatter, with unique literal identity and label strings. Comments, spreads,
computed values, and other ambiguous syntax fail closed. It only reorders
existing objects; the editor exposes supported configured targets in the same
reorder picker with a separate Astro-gallery preview/commit API. The diff
replaces only the configured array range while retaining object slices and the
array's separator/whitespace slots. Reads reject symlinked paths, files over
1 MiB, and invalid UTF-8. Preview tokens are same-session, short-lived, and
one-shot; commits recheck the source hash and parser before the atomic write.
This is not general Astro DOM/source provenance.
# Safe source replacement mode

The trusted JSON file passed to `astro-visual-cms-editor --config <path>` may
set `safeSourceReplacementMode: true` (the CLI passes this server-side option
through; request bodies cannot set it).
This is an explicit opt-in mitigation: it keeps source reads and previews
available, but rejects every attempt to replace an existing source file with
HTTP 409 (`SOURCE_REPLACEMENT_DISABLED`) before invoking the configured writer.
This central guard covers gallery, MDX, collection, schema/config and fixture
replacement endpoints, including an injected writer. Exclusive creation of a
new collection entry remains permitted and cannot replace an existing path.
Clients cannot enable or disable the mode in request data.

This mode does not automatically apply edits, merge competing changes, or
provide optimistic-locking compare-and-swap. Hash checking followed by rename
in normal mode is not atomic against uncooperative writers. The default remains
normal mode for compatibility; this mitigation must be explicitly enabled and
does not resolve issue #14, which remains open.
