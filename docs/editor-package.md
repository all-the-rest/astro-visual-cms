# Editor package (development only)

Install the package tarball in an Astro project with `npm install /path/to/astro-visual-cms-editor-0.1.0.tgz` (or use the published package name once a release is published). The integration is deliberately dev-only: it injects the loopback bridge only for `astro dev`, and the editor write server refuses to start under `NODE_ENV=production`.

```js
// astro.config.mjs
import { defineConfig } from 'astro/config'
import { createLoopbackDevIntegration } from '@astro-visual-cms/editor/integration'

export default defineConfig({ integrations: [createLoopbackDevIntegration({ editorPort: 4322 })] })
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

Run `npx astro-visual-cms-editor --config ./avcms-editor.json` (or invoke `node_modules/@astro-visual-cms/editor/src/editor/cli.mjs --config ...`). Paths in the JSON file are resolved relative to that file. `projectRoot` and `contentConfigPath` must be supplied together; route lists are validated as trusted same-origin paths. The server module is also available at `@astro-visual-cms/editor/server` for callers that need direct `createEditorServer(options)` control.

The editor's gallery API remains the original bounded demo fixture adapter; custom preview route selection and static content collection discovery do not make it a general-purpose content editor. Use an actual fixture file conforming to the existing supported demo shape if the gallery UI/API is enabled. MDX paragraph and component adapters support only their explicitly configured syntaxes; this package does not claim general MDX compatibility.

Supported static `glob()` collections also expose a confirmed “new Markdown entry” workflow when every required schema field is in the scalar string/number/boolean/enum subset or has a static default. The filename is a single lowercase slug; nested paths, rich fields and unsupported schemas remain unavailable/read-only. The editor previews the generated YAML frontmatter before confirmation, revalidates the trusted collection config, and creates by exclusive hard link so an existing path is never replaced. Optional/defaulted values are omitted/applied according to the discovered schema; Astro Content Sync is responsible for refreshing the collection after creation.

Verified integration/build points: Astro 7.2.4 and 7.4.7. The peer range `>=7.2.4 <8` is intentionally conservative within the verified major; it is not a claim that every version in that range has been tested. Astro is an optional peer because the server-only API does not require Astro. The package declares Node >=22.12; the package-consumer smoke was run on Node 26.10.0.

`npm run pack:smoke` packs the actual npm tarball, checks its allowlisted contents, installs it into a disposable Astro 7.4.7 consumer with `@astrojs/mdx`, and starts the installed-package editor. It confirms a new static `glob()` collection by exact config diff, creates a Unicode YAML entry only after preview confirmation, then runs an Astro production build and verifies the new collection route renders that entry. It also builds a synthetic MDX page, starts Astro dev, and verifies collection discovery, exact numeric-field preview/commit, source-byte preservation, the live Content Sync reorder and new-entry render, the trusted custom route, and a literal MDX-component preview/commit after HMR. This proves only those narrow adapters; it does not establish general MDX authoring/round-trip compatibility. In a separate full copy of the real Astro 7.2.4 `powerbros.at` project installed from the local tarball using pnpm, `astro check`/build passed. Through the editor, `referenzen/2024-08-20-porec.md` changed only `order: 1` to `order: 6` (87 bytes before and after); the running `/referenzen/` HTTP response reordered the 2024 rows to `Rovinj > Pula > Umag > Moosmayr > Porec`. The earlier string-field workflow also rendered “Quarter-Show JKU Astros — CMS smoke”. Synthetic Gallery fixture/config additions and all edits were confined to disposable copies; the original project remained untouched.

`pnpm run verify:external-production` repeats the package-install/production-isolation check against `/projects/powerbros.at` in a disposable full-project copy (override the source with `ASTRO_CMS_CONSUMER=/path/to/astro/project`). It installs the actual local npm tarball, adds the dev-only integration to the copied Astro config, runs that project's normal production build without starting the editor, scans `dist` for CMS routes/UI/bridge/write-API markers, then starts only `astro preview` and checks the real `/referenzen/` route plus a 404 from `/api/collections`. All source/config/content changes and build output stay in the temporary copy, which is removed on exit. This command requires an offline pnpm cache for the consumer and currently uses config anchors matching `powerbros.at`; it is a pinned external-project regression probe, not a generic compatibility test.

Runtime dependency license evidence was collected with `pnpm licenses list -P --json`: direct dependencies are `@babel/parser` (MIT), `@mdx-js/mdx` (MIT), and `yaml` (ISC); the resolved runtime dependency tree reported MIT, ISC, and BSD-3-Clause licenses. Re-run the command against the exact resolved package graph when preparing a release.
