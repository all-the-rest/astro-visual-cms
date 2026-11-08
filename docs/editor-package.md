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

Verified integration/build points: Astro 7.2.4 and 7.4.7. The peer range `>=7.2.4 <8` is intentionally conservative within the verified major; it is not a claim that every version in that range has been tested. Astro is an optional peer because the server-only API does not require Astro. The package declares Node >=22.12; the package-consumer smoke was run on Node 26.10.0.

`npm run pack:smoke` packs the actual npm tarball, checks its allowlisted contents, installs it into a disposable Astro 7.4.7 consumer with `@astrojs/mdx`, builds a synthetic MDX page, and starts both the installed-package editor and Astro dev server. It verifies static collection discovery, the trusted custom route, an explicit literal MDX-component preview/commit, exact source preservation outside the selected prop, and the rendered update after Astro HMR. This proves that narrow adapter path only; it does not establish general MDX authoring/round-trip compatibility. A separate full copy of the real Astro 7.2.4 `powerbros.at` project was installed from the local tarball using pnpm; its `pnpm run build`/`astro check` passed and the editor UI rendered its actual “Quarter-Show JKU Astros” entry through `/referenzen/`. Synthetic Gallery fixture/config additions were confined to the disposable copy. The original working tree and content remained untouched.

Runtime dependency license evidence was collected with `pnpm licenses list -P --json`: direct dependencies are `@babel/parser` (MIT), `@mdx-js/mdx` (MIT), and `yaml` (ISC); the resolved runtime dependency tree reported MIT, ISC, and BSD-3-Clause licenses. Re-run the command against the exact resolved package graph when preparing a release.
