---
name: astro-component-blocks
description: Extend the dev-only Astro visual CMS block editor by adding a trusted block type or a new scalar field kind, and implement or change its source operations, preview flow, proposals, and tests without weakening the trust boundary.
---

# Astro component blocks — implementation guide

Use this skill when a change touches the block catalog (`blockTypes`), field
descriptors, block source operations, the dev preview overlay, or the block
proposal. Block targets are `.mdx` or `.md` files containing generated component
calls; they are **not** a JSON/directive model and not a general MDX editor.

Read before editing:

- `src/lib/mdx-blocks.mjs` — catalog, parsing, `patch`/`inspect`/`describe`
- `src/editor/mdx-block-preview.mjs` — Vite overlay, bridge, fail-closed checks
- `src/editor/markdown-preview.mjs` — virtual `.astro` module for `.md`
- `src/editor/server.mjs` (`/api/mdx-blocks*`) — operations, pending previews
- `src/editor/index.html` — controls, block list, preview/proposal client
- `docs/editor-package.md`, "Native MDX block editor (dev only)" — user contract
- tests: `test/mdx-blocks.test.mjs`, `test/mdx-block-server.test.mjs`,
  `test/mdx-block-preview.test.mjs`, `test/markdown-preview.test.mjs`,
  `test/mdx-block-virtual-preview.test.mjs`, `browser-tests/block-editor.spec.ts`

## 1. Trust boundary

- The catalog is trusted project configuration, passed to
  `createMdxBlocksAdapter({ blockTypes, format })` and to
  `createLoopbackDevIntegration({ mdxBlockTargets, previewRoutes })`; both sides
  must receive the same catalog. Never derive block types, fields, import
  sources, paths, or allowlists from browser input.
- The editor never imports, bundles, evaluates, or introspects `.astro` files.
  It only knows `importSource` (a string) and `componentName`; rendering happens
  solely through Astro's own dev route.
- Everything is dev-only: the integration registers the bridge only for
  `astro dev`, the write server refuses `NODE_ENV=production`, and
  `scripts/verify-build.mjs` plus `scripts/package-smoke.mjs` scan for
  `mdx-blocks-panel`, `avcms:mdx-block-preview`, `__avcms/mdx-block-preview`,
  and `/api/mdx-blocks`. A change that leaks editor code into `dist` is a
  failure, not a trade-off.

## 2. Adding a block type

Add the descriptor to the trusted JSON in `src/editor/sample-dev-config.mjs` /
`playwright.editor.config.json` (and the consumer's config), for example:

```json
{
  "type": "callout",
  "label": "Hinweisbox",
  "description": "Hervorgehobener Hinweis.",
  "importSource": "../components/Callout.astro",
  "componentName": "Callout",
  "idProp": "cmsId",
  "fields": [
    { "name": "title", "type": "string", "label": "Titel", "required": true },
    { "name": "tone", "type": "enum", "label": "Ton", "values": ["info", "warning"], "default": "info" }
  ]
}
```

`normalizeBlockTypes` accepts exactly `type, label, description, importSource,
componentName, idProp, fields`. An unknown key is rejected
(`INVALID_BLOCK_CONFIG`), because a silently ignored key would let a project
believe it configured a guardrail that does not exist. Bounds:

- 1–32 block types; `type` matches `^[A-Za-z][A-Za-z0-9_-]{0,63}$`
- `label` required, ≤80 chars; `description` ≤240
- `importSource` non-empty, ≤512 chars, no control characters
- `componentName` and `idProp` are JS identifiers; `idProp` defaults to `id`
- `type`, `importSource`, and `componentName` are each unique across the catalog
- `fields` ≤32 per type, field names unique, and `idProp` may not also be a field

The identity is a single static string attribute matching
`^[A-Za-z0-9_-]{1,128}$` and unique per target. Add a synthetic fixture page and
a preview route; do not point a test at real content.

## 3. Adding a field kind

The implemented kinds are exactly `string | number | boolean | enum`. There is
no plugin registry and no extension kind is implemented today; a new kind is a
source change. Treat this as the full checklist — finishing only some steps is
an incomplete change:

1. **Descriptor validation** — extend the allowed `type` list and the
   constraint rules in `normalizeField` (`src/lib/mdx-blocks.mjs`). Reject
   constraint keys that do not apply instead of ignoring them, and validate
   `default` through `validValue`.
2. **`validValue(field, value)`** — a total, pure predicate: no coercion, no
   `NaN`/`Infinity`, explicit length/value bounds. It is the single gate used by
   descriptors, parsing, patching, and defaults.
3. **`staticValue` (source → value)** — accept exactly the literal forms
   `encodeValue` emits, and nothing wider. Today: `name="…"` or
   `name={"…"}`/`name={'…'}` for string/enum, `name={true|false|number}` for
   scalars. MDX already decodes JSX character references, so compare decoded
   values, not raw bytes.
4. **`encodeValue` (value → source)** — must round-trip byte-for-byte:
   `validValue(x)` ⇒ `staticValue(encodeValue(x)) === x`. Keep the output on one
   line and inside one attribute; `.md` zone ownership requires single-line
   self-closing calls.
5. **Control rendering** — add the branch in `createMdxBlockFieldControls`
   (`src/editor/index.html`): label text from `field.label || field.name`,
   `data-block-field`, DaisyUI classes, input type and constraints, and
   `field.required` display. UI strings stay German.
6. **Capture and normalisation** — extend `readMdxBlockFieldValues` (typed
   value, empty handling, `Number.NaN` on invalid numbers) and
   `captureMdxBlockFieldControls` (rerender preservation). Empty-optional rules
   must not silently drop a required or defaulted value.
7. **Diff and operation production** — `patch` must emit a minimal source range:
   `set` uses `propRanges` and `encodeValue`; a missing optional prop inserts
   before `/>`; `add` goes through `blockMarkup`. Never re-serialise the whole
   tag, and return `diff: null` for a no-op.
8. **`.md` zone rules** — the kind must survive the marked zone in
   `markdownZone`: no imports in a newly created zone, no children/spreads/
   extra attributes, no multi-line markup. Otherwise the target must stay
   read-only.
9. **Proposal metadata** — `diffs` must carry exact `before`/`after` and
   `hash`/`nextHash` per operation so the proposal stays revision-bound.
10. **Fail closed** — if the kind cannot be parsed back unambiguously, rendered
    in both formats, or round-tripped without loss, do not ship it: reject with
    `INVALID_BLOCK_CONFIG` (descriptor) or `UNSUPPORTED_BLOCK_SOURCE` (source).

## 4. Reordering and structural operations

`patch` accepts only the ordered operations `add`, `set`, `move`, `remove`;
each operation applies to the source produced by the previous one, and the
server threads `nextHash` into the next revision. Unknown keys, unknown block
ids, unknown props, and values outside `validValue` are rejected.

`move` takes `delta: -1 | 1` and swaps two adjacent blocks only. A move is
refused with `UNSUPPORTED_BLOCK_ORDER` when the gap contains anything except
whitespace (`.mdx`) or whitespace plus generated import lines (`.md`);
reordering must never relocate unrelated Markdown. Boundary moves fail with
`BLOCK_MOVE_BOUNDARY`; a swap that changes nothing reports `diff: null`.

Ordering must stay a bounded, revision-bound source operation. Today the block
list exposes `Nach oben` / `Nach unten` buttons that both emit the same
`{ action: 'move', blockId, delta }`. Drag and drop for blocks is **not
implemented**; if it is added it must reuse that exact operation, share the
same bounds and read-only conditions, and be covered by the same browser test —
never a separate reorder model.

## 5. Preview expectations

- The draft must actually render in the real Astro dev route before the editor
  offers confirmation. `prepareMdxBlockOperations` posts the preview, waits for
  the bridge, posts `avcms:mdx-block-preview`, waits for the iframe reload, then
  posts `avcms:mdx-block-rendered`; only a successful acknowledgement creates
  the draft and pending proposal.
- A reload alone is not proof. `mdx-block-preview.mjs` requires
  `draft.loads > 0` (`PREVIEW_NOT_OVERLAID` otherwise) and detects Content
  Layer routes through the `astroMarkdownContentEntry` query
  (`CONTENT_LAYER_UNSUPPORTED`), because those render stored collection data.
- Failures are explicit. A 5xx render drops the in-memory draft and reloads the
  saved source immediately; any error resets the overlay and, when a previous
  draft was superseded, restores and re-renders it. Source bytes are never
  touched. Never report success for an unconfirmed or failed render.
- The overlay is bounded: 30 s render grace (`PREVIEW_RENDER_TIMEOUT_MS`),
  15 min acknowledged lifetime (`PREVIEW_OVERLAY_LIFETIME_MS`), both capped,
  plus explicit reset and orphan reclaim. Keep the server's pending-preview TTL
  ≥ the overlay lifetime.
- `.md` never goes through MDX. `buildMarkdownPreviewModule` regenerates only
  catalog blocks, renders the body with the project's Markdown processor
  (including final `metadata.frontmatter` and image handling), and loads an
  in-memory virtual `.astro` module. Missing final metadata, unrepresentable
  frontmatter, or a render failure fails closed.

## 6. Proposal semantics

Existing sources are never written; there is no opt-out. Confirmation calls
`/api/mdx-blocks/commit`, which fails with 409 `SOURCE_REPLACEMENT_DISABLED`, so
the editor exports a manual proposal via `setSourceProposal`:

- `schemaVersion: 1`, `type: 'astro-visual-cms-source-proposal'`
- `target: { kind: 'mdx-blocks', id, sourceFormat }` — `md` or `mdx`
- `baseHash`/`proposedHash`, `change.operations`, `diff` and `diffs` with exact
  ranges; no file path and no complete source
- `application` for block proposals: `mode: 'literal-markdown'`,
  `rendersAsComponents: false`, `conversion: 'none'` for `.md`;
  `mode: 'mdx'`, `rendersAsComponents: true`, `conversion: 'none'` for `.mdx`

Download rechecks the bound revision and discards a stale proposal. Never claim
that `.md` content becomes executable: applying a proposal to a `.md` file
leaves the generated calls as literal Markdown/HTML text, and `.md` → `.mdx`
conversion is not implemented (issue #21 remains open). `.md` targets may not be
renamed, replaced, unlinked, or given a sibling `.mdx`.

## 7. Required tests for every extension

- Unit accept/reject: every new descriptor bound, unknown key, duplicate
  type/import/component/field/identity, and malformed operation.
- Round-trip: byte-identical source for no-op edits; only the intended range for
  `add`/`set`/`move`/`remove`; preservation of BOM, CRLF, Unicode, frontmatter,
  comments, and unconfigured props. Compile the result with
  `@mdx-js/mdx` `compile` for `.mdx`.
- `.md`: literal `{...}`, JSX-looking text, `import`/`export`, code fences, and
  leading raw HTML stay ordinary Markdown; ambiguous zone or missing end marker
  is read-only; the file is never renamed or written.
- Server: path-free catalog, ordered multi-operation preview against each
  intermediate revision, stale hash, expired/mismatched preview, cancellation,
  and refused commit.
- Real Astro integration: `test/mdx-block-virtual-preview.test.mjs` style — the
  actual dev route renders the draft, Content Layer is refused, a failing
  component discards the draft and the saved source recovers.
- Browser: extend `browser-tests/block-editor.spec.ts` (config
  `playwright.editor.config.json`) for add/edit/move/remove, rendered preview,
  unchanged bytes on disk, and the downloaded proposal shape.
- Production isolation: `pnpm run verify:build` plus the package smoke must
  still prove that no editor, bridge, or write route reaches `dist`.

## 8. Do not

- Do not accept component imports, file paths, catalog entries, or allowlists
  from browser input, URL parameters, or request bodies.
- Do not add dynamic props, spreads, slots/children, event handlers, or aliased
  imports as editable constructs; they make a target read-only.
- Do not silently downgrade an unsupported descriptor or value to `string`, nor
  ignore unknown descriptor keys.
- Do not write, rename, or delete existing sources, and do not claim a `.md`
  proposal becomes components or that `.md` → `.mdx` conversion exists.
- Do not confirm a preview that Astro did not render or whose route did not load
  the draft, and do not leave an unbounded overlay behind.
