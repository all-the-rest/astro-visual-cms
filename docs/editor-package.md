# Editor package (development only)

Install the package in an Astro project with `npm install --save-dev @all-the.rest/astro-visual-cms`, or install a local release tarball with `npm install /path/to/all-the.rest-astro-visual-cms-0.1.0.tgz`. The integration is deliberately dev-only: it injects the loopback bridge only for `astro dev`, and the editor write server refuses to start under `NODE_ENV=production`.

```js
// astro.config.mjs
import { defineConfig } from 'astro/config'
import { createLoopbackDevIntegration } from '@all-the.rest/astro-visual-cms/integration'

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

Run `npx astro-visual-cms-editor --config ./avcms-editor.json` (or invoke `node_modules/@all-the.rest/astro-visual-cms/src/editor/cli.mjs --config ...`). Paths in the JSON file are resolved relative to that file. `projectRoot` and `contentConfigPath` must be supplied together; route lists are validated as trusted same-origin paths. The toolbar registers `Seite bearbeiten` only during `astro dev`, opens a separate local editor tab, maps only exact trusted preview paths to route IDs, and leaves the preview tab untouched. If Astro's toolbar is disabled or unavailable, start the same CLI and open `http://127.0.0.1:4322/` directly (use the configured editor port if different). A no-token `/api/health` endpoint allows only the configured local preview origin; POST origin, host, content-type, and session-token guards are unchanged. The server module is also available at `@all-the.rest/astro-visual-cms/server` for callers that need direct `createEditorServer(options)` control.

Set `"fixturePath": null` when the demo gallery is not used. This explicitly disables that adapter without affecting configured Astro galleries or other editor panels. A configured but unreadable or unsupported fixture remains an error; omitting `fixturePath` is not a substitute for the explicit opt-out.

The editor page loads the target project's stylesheet for its theme and also its own generated `editor.generated.css` from the editor origin, so bounded preview layout, daisyUI component styles and responsive columns do not depend on the consumer's Tailwind content scan. Regenerate the file with `pnpm run build:editor-css`; `pnpm run verify:editor-css` (part of `verify`) fails when the committed stylesheet is stale. The generated file includes daisyUI's default theme and is loaded after the project stylesheet, so the editor chrome uses those defaults rather than the consumer's own daisyUI theme; this affects only the local editor page, not the preview iframe.

V1 is supported only alongside the local `astro dev` server. The integration does not register its bridge or toolbar for build/preview, but the standalone editor is a separate process: starting it manually while a production/preview process runs may still enable local source writes if the editor process itself does not have `NODE_ENV=production`. That mode is unsupported; do not run the editor against a production site or expose it to a network. Current loopback/origin/session controls are not production authentication. Any future production/remote mode is tracked for V2 in [issue #13](https://github.com/all-the-rest/astro-visual-cms/issues/13).

For an imported MDX component, trusted editor JSON can declare scalar fields:

```json
{"mdxComponentTargets":[{"id":"home-hero","projectRoot":".","filePath":"src/content/home.mdx","importSource":"../../components/Hero.astro","idProp":"cmsId","fields":[{"name":"heading","type":"string","label":"Heading"},{"name":"priority","type":"number","min":1,"max":5,"step":1},{"name":"visible","type":"boolean"},{"name":"tone","type":"enum","values":["light","dark"]}]}]}
```

`editableProps: ["heading"]` remains shorthand for string fields. Only the documented static literal forms are editable; unconfigured props are preserved but never exposed for editing. Spreads and dynamic expressions in configured fields remain read-only, and component code is never evaluated. See [gallery-editor.md](gallery-editor.md) for the exact boundary.

The configured MDX component panel checks its selected target revision on a bounded two-second poll and when the editor regains focus. A clean value refreshes automatically; a dirty value is retained and gets explicit discard/reload or reapply choices. A detected conflict displays the baseline scalar, latest observed scalar, and retained local draft separately; unavailable external values are labeled, and values are inserted as text. Reapply requests a new preview against the then-current supported state. Confirming an existing-source edit does not write the file: it creates a path-free, revision-bound manual proposal. Before download, the editor checks that the base revision is still current; a failed or stale check discards the proposal. The proposal is not merged or applied automatically. Polling is best-effort (not a filesystem watch), and can only detect revisions observed by a successful poll.

### Native MDX block editor (dev only)

The block editor uses a separate trusted component catalog and edits only supported top-level self-closing JSX calls in MDX. It does not convert content into a JSON/Directive model. For each block type, configuration declares the component import and scalar prop allowlist. Any nested or inline use of a configured component makes the entire target unsupported and read-only, not just that invocation. Unsupported spreads, dynamic values, children/slots, or ambiguous ordering also make the target read-only; unconfigured props are preserved but are not editable. Add, edit, move, and remove produce ordered, source-range diffs against the exact base revision. All proposed MDX is parsed before preview and then loaded through Astro's real dev route; the editor only enables confirmation after that route reloads, the Astro bridge responds, and the route actually requested/transformed the draft source rather than rendering cached HTML. A failed/unconfirmed Astro reload, a route that never evaluates the source, or an Astro Content Layer entry rendered from the collection store cancels the pending proposal, resets the trusted in-memory overlay, reports the reason in the UI, and reloads the saved source.

A `.md` target is never renamed, replaced, unlinked, or written, and no sibling `.mdx` file is created or removed. In a `.md` file, `{...}`, JSX-looking text, `import`/`export` lines, code fences and raw HTML are ordinary Markdown in Astro — they are content, not executable syntax. The preview therefore does not hand the saved Markdown to MDX: it keeps the generated block calls inside an explicit editor-owned zone delimited by `<!-- astro-visual-cms:blocks:start -->` and `<!-- astro-visual-cms:blocks:end -->`, regenerates each call from validated catalog props, renders the untouched Markdown body with the project's own Markdown processor (so headings, code fences, raw HTML, frontmatter layout and Astro image handling keep their normal `.md` output), and emits a virtual `.astro` page inside the dev server that composes those two parts. The virtual page is in-memory only; the real `.md` path and bytes stay intact. A target without a frontmatter layout emits the same default charset and `maybeRenderHead()` instruction as Astro's own `.md` page, so collected project styles and page scripts match the saved route. Only exact catalog-generated imports and single-line, fully validated component calls between those markers are editable blocks; every other JSX-looking or expression-looking sequence, including leading raw HTML whose element name happens to match a configured component, stays ordinary Markdown. Ambiguous content inside the markers, a missing closing marker, or an unsupported layout makes the target read-only instead of being reinterpreted. Frontmatter is parsed as data and validated, never re-emitted as YAML or module source, and the preview carries the final `metadata.frontmatter` returned by the active Markdown processor rather than the raw YAML, so Satteri/remark/rehype metadata changes match the saved page; a processor that does not return final metadata, unrepresentable frontmatter, or a Markdown render failure fails the preview closed instead of falling back to MDX. A confirmed block change for a `.md` target is still a plain Markdown proposal: the generated calls are preview components and remain literal Markdown/HTML text in a `.md` page unless the project renders that path as MDX, and the editor never renames the file to make them executable. The proposal records `target.sourceFormat` as `md` and `application.mode` as `literal-markdown` with `rendersAsComponents: false`; applying it does not perform an `.md`-to-`.mdx` conversion (issue #21). This is a semantics guarantee, not a sandbox: project content is trusted, `.mdx` targets are MDX by definition and execute as they do in `astro dev`, and raw HTML in Markdown is still rendered by the site's configured Markdown pipeline.

Cancellation, reset, a failed render, an invalidated preview, and proposal export all leave the source path untouched. An acknowledged overlay is never unbounded: it expires after 15 minutes by default, clears its draft, invalidates the virtual module, and reloads the Astro preview. A pending confirmation stays valid at least as long as the rendered overlay (16 minutes by default versus the overlay's 15 minutes, including the render grace), so a rendered draft cannot outlive the preview that authorizes it. If the window still elapses (for example after a browser sleep or a very long editing session), confirming does not silently drop the draft: the editor re-runs the trusted preview flow against the retained base revision and asks for confirmation again. If that renewal fails because the source changed, the draft is clearly discarded, the overlay is reset to the saved source, and the failure is reported. In addition, the editor reclaims an overlay for the currently displayed target whenever it has no local draft for it, so reloading the editor page cannot leave a lost session's draft rendered. That reclaim is serialized: its accepted reset reloads the preview iframe, so the editor waits for that reload and keeps preview-starting controls disabled until it completes, instead of letting the reload reject a fresh draft inserted in between. Reclaiming never writes, deletes, or changes source bytes; the bounded expiry remains the fallback for targets that are not displayed.

The editor server and Astro dev integration must receive matching trusted target catalogs (never from browser input). For example, the editor JSON may contain:

```json
{
  "mdxBlockTargets": [{
    "id": "page-blocks",
    "projectRoot": ".",
    "filePath": "src/pages/blocks.mdx",
    "previewRouteId": "blocks",
    "blockTypes": [{
      "type": "callout",
      "label": "Callout",
      "componentName": "Callout",
      "importSource": "../components/Callout.astro",
      "idProp": "cmsId",
      "fields": [
        { "name": "title", "type": "string", "required": true },
        { "name": "tone", "type": "enum", "values": ["info", "warning"] }
      ]
    }]
  }]
}
```

The Astro config must pass the same target (with absolute `projectRoot` and `filePath`) to `createLoopbackDevIntegration({ mdxBlockTargets, previewRoutes: [{ id: 'blocks', path: '/blocks/' }] })`. This installs the authenticated in-memory Vite overlay only for `astro dev`; build/preview never get the block bridge or routes. `.md` targets are previewed through a generated in-memory Astro page whose body is rendered by the project's Markdown processor; the file name and bytes are not changed, and no background conversion or filesystem cleanup is performed. Confirmation still creates only a path-free, base-revision-bound manual proposal: existing MDX is never replaced by the editor. The proposal exports the operation list, its `sourceFormat` (`md` or `mdx`), the exact changed ranges, and for `.md` an `application` block stating that the diff stays literal Markdown/HTML text and performs no `.mdx` conversion; it never exposes the file path or complete source. The disposable package smoke exercises add/render/proposal/reset against an installed tarball, and production gates scan for the editor and bridge markers.

The existing Collection-field panel also polls its catalog on a bounded two-second interval and on editor focus. Clean forms follow the latest observed entry revision; edited scalar drafts survive panel rerenders, source outages, stale previews/commits, and explicit preview cancellation. A conflict displays the baseline and latest observed SHA-256 revisions plus the local draft, without exposing source paths or frontmatter values through the catalog. An unavailable or unsupported source blocks reapply; otherwise the user must explicitly reapply to create a fresh exact diff and confirm it. Confirmation produces a manual proposal, not an entry write; download rechecks both the entry and content-config hashes. Polling is best-effort, not a filesystem watch or real-time guarantee. No universal CAS guarantee is claimed for arbitrary writers.

Collection entry creation retains the slug and scalar field values across polling, rerenders, and API failures. A changed or unavailable content-config revision keeps the draft visible with baseline/latest hashes and requires an explicit reapply followed by the normal exact-diff confirmation. If the current schema no longer supports a retained field, reapply is blocked rather than silently dropping that value. Successful creation clears the draft; cancelling a preview does not. This polling remains best-effort and is not a compare-and-swap guarantee.

Schema extension and collection-creation forms likewise retain edited values—including empty and unchecked values—plus the selected collection across observed config revisions and unavailable polls, even before submission. Conflicts require explicit discard or reapply against the latest supported schema, followed by a fresh exact preview and confirmation. Schema extension confirmation creates a manual proposal for the existing config; collection creation remains preview-only when its exact config diff contains a relative loader base, so no path-bearing proposal is exported. Neither operation writes the config. These polls are best-effort observations, not real-time notifications or universal compare-and-swap guarantees.

Gallery ordering polls fixture and Astro-internal gallery state on a bounded interval and editor focus. Dirty orders are retained across observed changes and unavailable polls; cancelling a preview leaves the local order visible so it can be previewed again or explicitly discarded. Conflict reapply is offered only when the local order remains an exact permutation of the latest target, and always creates a fresh preview. Confirmation creates a manual proposal rather than replacing the source. Polling is best-effort, not a filesystem watch or universal compare-and-swap guarantee.

The editor's gallery API remains the original bounded demo fixture adapter; custom preview route selection and static content collection discovery do not make it a general-purpose content editor. Use an actual fixture file conforming to the existing supported demo shape if the gallery UI/API is enabled. MDX paragraph and component adapters support only their explicitly configured syntaxes; this package does not claim general MDX compatibility. The visual-draft marker supports both Satteri 0.10's `setProperty` and Satteri 0.11's `setField` node mutators; an unknown processor leaves the page readable and unmarked.

Gallery, Content Collections, and configured MDX component panels load independently. Omitting `fixturePath` is a configuration error; use `"fixturePath": null` to disable the demo-gallery adapter explicitly. If a configured fixture path is unreadable or is not a supported Gallery fixture, the editor reports that Gallery panel as unavailable but still loads other configured panels; the same source file may be used as a path anchor without being a Gallery fixture.

Supported static `glob()` collections also expose a confirmed “new Markdown entry” workflow when every required schema field is in the scalar string/number/boolean/enum subset or has a static default. The filename is a single lowercase slug; nested paths, rich fields and unsupported schemas remain unavailable/read-only. The editor previews the generated YAML frontmatter before confirmation, revalidates the trusted collection config, and creates by exclusive hard link so an existing path is never replaced. Optional/defaulted values are omitted/applied according to the discovered schema; Astro Content Sync is responsible for refreshing the collection after creation.

Verified package integration/build points: Astro 7.2.4 and 7.4.7. A manual packed-tarball acceptance on a full copy of the real `reisinger.pictures` project also exercised Astro 7.4.1 with `@astrojs/mdx` 8.1.0 and Satteri 0.10.5 for the bounded visual Markdown draft (dev render, selection, exact diff, no-op, stale revision and production isolation); see [external-acceptance.md](external-acceptance.md). A separate synthetic custom-component dev probe ran on Astro 7.4.1 earlier, but did not test that consumer's production build. The peer range `>=7.2.4 <8` is intentionally conservative within the verified major; it is not a claim that every version in that range has been tested. Astro is an optional peer because the server-only API does not require Astro. The package declares Node >=22.12; the package-consumer smoke was run on Node 26.10.0.

`pnpm run pack:smoke` packs the actual npm tarball, checks its allowlisted contents, installs it into a disposable Astro 7.4.7 consumer with `@astrojs/mdx`, and starts the installed-package editor. It verifies that config, existing collection-entry, MDX-component, MDX-block, and Astro-gallery previews leave source bytes unchanged and confirmed replacements are refused. The installed UI exports path-free, base-revision-bound proposals for typed MDX fields and blocks, plus an Astro-internal gallery. Its MDX fixtures retain unconfigured props, nested Markdown prose, and imported Astro components in slots; block preview is confirmed by rendering the synthetic component in the real Astro dev route before proposal/reset. A `.md` block target is rendered through the project's Markdown pipeline plus a virtual Astro page by the real Astro route without changing its path or bytes; a synthetic Astro component render failure verifies that confirmation is withheld and the original Markdown path/bytes remain untouched. The virtual-preview suite also runs a real Satteri metadata plugin (transformed `metadata.frontmatter` must reach the preview layout), proves leading raw HTML is not claimed as an editor block, and detects a real Astro Content Layer route instead of falsely confirming a non-overlaid draft. Production build, dev rendering, and post-proposal rendering verify those regions remain intact. The smoke also creates a Unicode YAML entry by exclusive creation after preview confirmation, runs an Astro production build, and verifies that the new collection route renders the entry. It checks the trusted custom route, Dev Toolbar route launch, and unchanged Astro rendering after refused edits. This proves only those narrow adapters; it does not establish general MDX authoring/round-trip compatibility or full integration with the intended external consumer. The smoke launches Playwright Chromium; install it first with `npx playwright install chromium` when running locally.

Existing-source replacement is intentionally disabled on all supported platforms. The former hash-check-plus-rename helper has a race window and is not a portable filesystem compare-and-swap. `safeSourceReplacementMode: false` is rejected; neither configuration nor request data can opt out. Existing-source edits are manual handoffs only. Exclusive creation of a genuinely new collection entry remains enabled.

The intended-project gate for `reisinger.pictures` remains open: its real checkout is not available in this workspace, and the disposable clone lacks ignored production content. Against that clone's Astro 7.4.1 installation, the current tarball rendered synthetic `AreaSection.astro` with its nested `ReviewSocialLink.astro` slot, discovered the configured MDX target, returned HTTP 200 for preview and HTTP 409 (`SOURCE_REPLACEMENT_DISABLED`) for confirmation, and exported a path-free proposal bound to the exact base hash. The synthetic source stayed byte-identical. This is useful custom-component adapter evidence, not a substitute for production-content or full intended-project acceptance.

### Historical disposable-consumer probes (before proposal-only replacement policy)

The following Astro 7.2.4 `powerbros.at` probes were run in disposable copies and establish adapter parsing, discovery, selection, and render compatibility for those fixtures only. Their historical confirmed-write/HMR results predate the current fail-closed replacement policy; they do not describe current editor behavior and are not current write-path acceptance evidence.

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
reorder picker with a separate Astro-gallery preview/commit API. A preview
describes only the configured array range while retaining object slices and the
array's separator/whitespace slots. Reads reject symlinked paths, files over
1 MiB, and invalid UTF-8. Preview tokens are same-session, short-lived, and
one-shot; confirmation is refused by the existing-source replacement policy
and can produce a manual proposal. This is not general Astro DOM/source
provenance.
# Source replacement policy

Source replacement is blocked by default. The editor keeps reads and previews
available, but returns HTTP 409 (`SOURCE_REPLACEMENT_DISABLED`) before invoking
any replacement writer. This central guard covers fixture/gallery, configured
MDX, Astro gallery, collection-field, and collection schema/config replacement
endpoints, including injected writers. Exclusive creation of a new collection
entry remains permitted and cannot replace an existing path. Request bodies
cannot change this trusted server policy.

There is no configuration or request-body opt-out. The legacy
`safeSourceReplacementMode: false` is rejected. The low-level hash-check-plus-
rename helper remains unused by server replacements; a deterministic writer
test documents its race window, where an edit after the final hash read can be
overwritten by rename.

After a current, matching preview is confirmed, the shared proposal UI covers
fixture galleries, configured Astro galleries, collection fields, collection
schema extensions, and configured MDX/Markdown edits. The downloadable JSON
contains a target kind/public ID, base and proposed SHA-256 revisions, a typed
change, and the exact changed range. Collection-entry target IDs are opaque
per-proposal tokens; raw collection-entry IDs (which may contain nested paths)
remain in editor memory and are not exported. The proposal excludes the source
file path and full source. Creating a new collection remains preview-only when
its exact config diff contains a relative loader base: that path-bearing diff is
not exported. Before download, the UI rereads the target revision (and the
content-config revision for collection entries); stale or unavailable revisions
cancel the export. Proposals are manual handoffs only: they are not merged,
applied, or an atomic write. Exclusive creation of a genuinely new collection
entry is the only source-writing editor operation retained.

Node's ordinary hash-check-plus-rename writer cannot provide portable
compare-and-swap against uncooperative filesystem writers. The default policy
therefore fails closed rather than claiming atomic revision-bound writes. This
removes automatic replacement as an integration capability until a stronger
write primitive is available; it does not resolve issue #14 or prove
integration in every consumer project.
