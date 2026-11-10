# Reisinger-shaped synthetic Astro sample

The `/reisinger-sample/editorial/showcase/` route is a synthetic regression
fixture modeled on the structure of the local `reisinger.pictures` project. It
contains no copied production prose, photos, metadata, client names, or secrets.
Its gallery uses the generated `noise-fixture-*` images already owned by this
repository.

| Real-project shape | Synthetic sample equivalent |
| --- | --- |
| Astro 7.4.x, MDX, static Content Layer collections | The existing pinned Astro/MDX app plus `src/content.config.ts` and `src/content/reisinger-like/` |
| `glob()` pattern excluding underscore-prefixed files, mixed `.md`/`.mdx` extensions | `**/[^_]*.{md,mdx}` in the `editorialSample` loader |
| Coerced dates and imported tag vocabulary | `z.coerce.date()` and `REISINGER_SAMPLE_TAGS` |
| Both glob and `file()` loaders | `editorialSample` and the synthetic JSON `sampleSummary` collection |
| MDX prose, ESM imports, exported gallery arrays, imported `Gallery.astro` | The synthetic `showcase/index.mdx` entry and generated image slugs |
| Custom components and opaque props | Local synthetic card/review components and an unknown component with an opaque expression prop |
| Nested Astro composition with named `head`, `hero`, `intro`, and `postContact` slots plus a default body slot | `ReisingerSampleLayout.astro`, the dynamic content route, and a nested MDX component assigned to a named slot |

This fixture is intentionally more complex than the existing gallery-only
`/fixture/` page. It is evidence that the sample Astro application can build and
render the relevant document structure; it is **not** evidence that the editor
can generally edit arbitrary Markdown/MDX, imported components, expressions,
Content Layer schemas, or DOM output. The current collection discovery subset
does not support the mixed brace/character-class glob or imported enum values;
that collection must remain visibly read-only until separately supported.

## Dev-only visual Markdown draft boundary

The repository's `pnpm dev` launcher also exposes this route in the local editor.
Only the exact, unique, root-level, one-line plain-text paragraph
`This fictional sentence is the one supported visual draft in the sample.` is
configured as a target. The dev-only MDX marker is inserted only when the
configured source file parses to that exact paragraph and source range. Selection
is bound to the same-origin preview frame, its per-load nonce, the configured
target/instance IDs, one rendered marker, and text that exactly matches the
catalogue. Click and keyboard selection are supported. Duplicate, transformed,
missing, formatted, or otherwise ambiguous output stays read-only.

The separate `GET /api/markdown-drafts` catalogue and authenticated
`POST /api/markdown-drafts/preview` endpoint expose only the target text, SHA-256
revision, and exact UTF-16 source-range diff. The preview endpoint re-reads and
revalidates the configured file for every request; a stale revision is rejected.
It has no commit route and returns no source path or full source. The UI updates
only the selected iframe element's `textContent`, and reset reloads the source
page. This visual draft is separate from the legacy MDX proposal/export UI and
does not call its preview or commit endpoints, set a shared proposal, write a file,
or enable handoff/export.

The mixed `editorialSample` glob/imported-enum collection and `sampleSummary`
`file()` collection remain visibly read-only. This does not implement #18 or
schema/loader support. All unselected prose, frontmatter, imports, JSX, opaque
expressions, nested components, and named slots remain outside the configured
range. The adapter parses MDX only; it never evaluates it. The marker plugins
support both the Satteri 0.10 `setProperty` and Satteri 0.11 `setField`
mutators; an unknown processor leaves the page readable and unmarked.

A manual acceptance run on a fresh full-filesystem copy of the real
`reisinger.pictures` checkout repeated these checks on Astro 7.4.1 /
`@astrojs/mdx` 8.1.0 / Satteri 0.10.5. It found and fixed the Satteri 0.10
crash and the editor's hidden dependency on the consumer's Tailwind scan. The
evidence, isolation digests, production-isolation scan and remaining gates are
recorded in [external-acceptance.md](external-acceptance.md). That run is
manual and does not close #1, #14, #16 or #18.

`pnpm run browser-tests:markdown-draft-copy` exercises the actual Content Layer
route in an isolated copy, including click/keyboard selection, exact diff,
no-op, duplicate/transformed rendered output, stale revisions, read-only
collection status, narrow layout, and unchanged copied/tracked source. The
production build must not contain the draft panel, bridge, or API route. This is
still only a synthetic acceptance slice; it is not general MDX provenance,
production readiness, or external-project evidence.

- [#15 — visual Markdown editing for imported Content Layer pages](https://github.com/all-the-rest/astro-visual-cms/issues/15)
- [#16 — fail-closed writes and revision-bound manual proposals](https://github.com/all-the-rest/astro-visual-cms/issues/16)
- [#17 — canonical macOS test roots without weaker path checks](https://github.com/all-the-rest/astro-visual-cms/issues/17)
- [#18 — safe support for reisinger-style Content Layer loaders](https://github.com/all-the-rest/astro-visual-cms/issues/18)

Issues #1 and #14 remain open. Issue #15's synthetic draft does not satisfy their
acceptance criteria, implement #18, or authorize editing production content.
