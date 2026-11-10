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

## Current editor boundary and work queue

The default editor still opens its original bounded gallery fixture; it does not
currently expose this new collection route as an editable Markdown document.
Rendering a complex page is not the same as providing a visual MDX editor.

- [#15 — visual Markdown editing for imported Content Layer pages](https://github.com/all-the-rest/astro-visual-cms/issues/15)
- [#16 — fail-closed writes and revision-bound manual proposals](https://github.com/all-the-rest/astro-visual-cms/issues/16)
- [#17 — canonical macOS test roots without weaker path checks](https://github.com/all-the-rest/astro-visual-cms/issues/17)
- [#18 — safe support for reisinger-style Content Layer loaders](https://github.com/all-the-rest/astro-visual-cms/issues/18)

Issues #1 and #14 remain open. None of these issues is closed or implemented by
adding this sample; they define the next work needed to reach a useful visual
Astro Markdown editor.
