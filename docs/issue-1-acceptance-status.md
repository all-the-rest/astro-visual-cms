# Issue #1 acceptance status

Status is evidence-scoped: passing a synthetic fixture does not establish support
for arbitrary Astro projects or MDX. “Partial” means the criterion is only proven
for the documented syntax/version/fixture; it is not release acceptance.

| Issue #1 acceptance criterion | Status | Existing evidence / remaining gate |
| --- | --- | --- |
| Dev-only install leaves production free of CMS routes/bridge/write API; ordinary build works without CMS processes | **Partial** | `pnpm run verify:build` covers the repo build; `pnpm run verify:external-production` installs the local tarball into a disposable `powerbros.at` copy, scans output for toolbar/UI/bridge/write markers, runs Astro preview without the editor, verifies `/referenzen/`, and confirms the CMS endpoints are 404. That real-consumer production-isolation proof is Astro 7.2.4 only. A new packed-tarball CI matrix checks synthetic integration/build/dev behavior at Astro 7.2.4, 7.2.10, 7.3.8, and 7.4.7; this is representative fixture evidence, not a general external-project matrix. Consumer accessibility coverage remains open. |
| Discover supported `glob()` schemas; unsupported loaders read-only; create entries/collections and show exact diffs | **Partial** | `pnpm run pack:smoke` on the installed tarball/Astro 7.4.7 verifies config and existing-entry previews without writes, then verifies those replacements fail closed. It creates a Unicode YAML entry by exclusive creation after exact preview confirmation, runs an Astro production build, and asserts that the generated route renders the entry. Schema extensions are proposal-only; new-collection config diffs containing a relative loader base remain preview-only and are not exported. Earlier Astro 7.2.4 `powerbros.at` copies exercised schema writes under the superseded replacement policy; those results are historical and are not current write-path acceptance evidence. `file()`/custom loaders intentionally stay read-only. |
| No-op byte equality and exact supported edits; malformed/ambiguous inputs never write | **Partial** | Range-patch tests cover Unicode, BOM, CRLF, comments, no-op, stale hashes and unsupported syntax. A configured MDX component no-op is now tested with a BOM/CRLF source containing frontmatter-like comments, imports, JSX comments, an unconfigured prop/expression, and a nested unknown component; it reports no diff and retains exact source. The installed-package UI smoke also verifies that an unchanged prop shows the no-op status, presents no confirmation, sends no commit, and leaves the bytes unchanged. V1 has no generic MDX open/save editor; arbitrary/unconfigured MDX remains read-only, so broader round-trip behavior is not claimed. |
| Imported/nested unknown MDX plus literal gallery reorder; exact unchanged bytes; compile; reject spread; define comment behavior | **Partial** | Synthetic MDX unit/browser and installed-tarball tests cover literal gallery and typed imported-component adapters, unchanged bytes, compilation, spread rejection and fail-closed comment cases. The installed Astro 7.4.7 tarball smoke edits only a configured literal while preserving an unconfigured prop, nested Markdown prose and a second imported Astro component in the slot; production/dev rendering remains unchanged after proposal-only confirmation. It also covers typed MDX/Astro-gallery proposals with unchanged source. Older disposable Astro 7.2.4 `powerbros.at` probes exercised real consumer syntax, including imported `.astro` components and the internal `Galerie.astro` array, but their confirmed-write/HMR results predate the current proposal-only policy and are not current write-path acceptance evidence. The project's broader MDX corpus and arbitrary DOM-to-source provenance remain unestablished. |
| Click/edit a known Markdown node; actual Astro preview updates; ambiguous output disabled; responsive presets/navigation/HMR work | **Partial** | Issue #15 adds a separate dev-only visual draft for one exact root-level plain-text paragraph on the synthetic Content Layer showcase. Its authenticated preview returns only the exact range diff; the iframe is updated with `textContent`, source files remain unchanged, stale revisions lock the draft, and this path creates no proposal/export or legacy MDX preview/commit request. The isolated-copy browser gate covers click/keyboard, mobile width, duplicate/transformed output, stale source, no-op, and the explicitly read-only sample collections. A manual full-filesystem copy of `reisinger.pictures` then repeated click/keyboard selection, exact diff, no-op, stale 409, duplicate/transformed read-only output and unchanged source trees on Astro 7.4.1 / `@astrojs/mdx` 8.1.0 / Satteri 0.10.5; production `dist` stayed free of editor markers and `/api/*` returned 404. That run found and fixed a Satteri 0.10 `setProperty` crash and an editor-CSS dependency on the consumer's Tailwind scan (see [external-acceptance.md](external-acceptance.md)). This establishes only one configured external node, not arbitrary Markdown/MDX, the external project's general output, generalized DOM-to-source provenance, or #1/#14 acceptance. |
| External concurrent edit conflicts; traversal/symlink/cross-origin/message attacks fail closed; loopback default | **Partial** | Existing-source replacement is blocked centrally before any writer, including injected writers; the unsafe opt-out is rejected. The legacy manual-proposal handoff covers fixture/Astro galleries, collection fields/config, and configured MDX/Markdown proposal adapters; export rereads and checks the base revision (plus collection-config revision for entry edits), and a disposable MDX browser regression confirms that stale proposals are not downloaded. Issue #15's visual draft is deliberately separate and has no proposal/export handoff. These are best-effort checks, not a portable CAS or merge. Exclusive creation remains permitted. General conflict merge and intended-consumer integration remain open. This does not establish full issue #14 or umbrella issue #1 acceptance. |
| Unit/E2E/fixtures/production/accessibility/license checks on pinned and current Astro; limitations documented | **Partial** | Unit, synthetic E2E, package smoke and version-pinned Astro 7.2.4/7.4.7 probes exist. The packed-tarball Astro matrix has passed locally at 7.2.4, 7.2.10, 7.3.8, and 7.4.7; its new CI job awaits execution. Astro 7.2.10+ also covers an imported `.astro` component on an MDX route with `@astrojs/mdx` 8.1.3. These fixed synthetic checkpoints do not prove every Astro 7 minor or arbitrary consumer behavior. `pnpm run verify:licenses` gates only the editor production graph, not dev/build tooling or legal compliance. The Axe browser audit covers the editor fixture at desktop/mobile sizes and configured-MDX diff confirmation, excluding the preview iframe and arbitrary consumer/editor states. Full compatibility and broader accessibility evidence remain open. |

The first named target in Issue #1, `reisinger.pictures`, was unavailable for the
2026-11-07 evidence above. A checkout was provided for a later session. On
2026-11-10, a disposable full-filesystem copy (including ignored production
content, excluding `.git` and `node_modules`) passed the target's documented
`pnpm install --frozen-lockfile` and `pnpm run build` gates with Astro 7.4.1;
`astro check` reported 0 errors, warnings, or hints and the static build produced
281 pages. The build retained existing route-conflict and missing-overview
warnings. Target dev routes `/portfolio/akt/boudoir-fine-art/` and
`/shootings/sport/` returned HTTP 200 and rendered their real MDX/Astro
composition, galleries, images, and slots. This is baseline project evidence,
**not** a completed local-package/editor acceptance run. Existing MDX imports,
custom components, and named Astro slots were inventoried in the copy only.

A later 2026-11-10/11 run installed the current packed editor into a new
full-filesystem copy and configured one real, unique, single-line prose
paragraph on a real Content Layer route. The real dev page marked exactly that
paragraph; click and keyboard selection, exact source-range diff, no-op,
stale-revision 409, duplicate-source read-only status and duplicate/transformed
DOM read-only behavior all passed. The copy's content, component and page trees
stayed byte-identical, the original checkout matched its pre-run digest, and the
production build (Astro 7.4.1, `@astrojs/mdx` 8.1.0, Satteri 0.10.5) contained
no editor marker or bridge; preview `/api/*` returned 404. This run exposed and
fixed a Satteri 0.10 mutator crash and an editor stylesheet dependency on the
consumer's Tailwind scan. Details, digests and open gates are in
[external-acceptance.md](external-acceptance.md). It remains one configured
node and does not close #1, #14, #16 or #18.

The CMS repository now includes a separate synthetic counterpart at
`/reisinger-sample/editorial/showcase/`: the same style of mixed `glob()` pattern,
an imported tag vocabulary, a `file()` loader, real-looking MDX imports, two
literal galleries, nested components and named slots. It contains only generated
noise images and fictional text. `pnpm run build` on the CMS repository passed
with Astro 7.4.7 and generated that route; a dev-browser request returned HTTP
200 and verified the rendered head/hero/body/post-contact slots and both
galleries. This proves only the synthetic Astro shape compiles and renders. The
editor offers only the single documented synthetic visual Markdown draft; it
does not offer general visual Markdown editing. The sample does not make
unsupported collection schemas or arbitrary MDX editable.

Earlier disposable `powerbros.at` probes used automatic replacement/edit/HMR,
but those results predate this policy and are not current write-path evidence.
The installed-tarball Astro 7.4.7 smoke and synthetic browser proofs establish
only the documented adapters. Intended-project review and production-content
coverage remain open.

Additional installed-tarball adapter evidence comes from a disposable clone at
`/tmp/opencode/reisinger.pictures`; it lacks ignored production content. On its
Astro 7.4.1 install, the current tarball rendered synthetic `AreaSection.astro`
with its nested `ReviewSocialLink.astro` slot, discovered its configured MDX
target, returned HTTP 200 for preview and HTTP 409 (`SOURCE_REPLACEMENT_DISABLED`)
for confirmed replacement, and exported a path-free proposal bound to the exact
source hash; the synthetic source remained byte-identical. This is adapter
evidence only and does not replace the full-filesystem baseline evidence above.

These probes do not establish production readiness or general MDX support. None
of the evidence above closes #1 or #14.
