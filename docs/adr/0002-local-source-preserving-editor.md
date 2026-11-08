# ADR 0002: Continue with a local source-preserving Astro editor

- **Status:** Accepted for the next prototype phase; not production-ready
- **Issue:** [#1](https://github.com/all-the-rest/astro-visual-cms/issues/1)
- **Date:** 2026-11-07
- **Scope:** Architecture choice after Phase 0 only; no production-content migration

## Context

Phase 0 compared TinaCMS, `astro-dev-edit`, Opace, and the existing prototype
against the same isolated copy of `src/pages/fixture.mdx`. The fixture includes
imports, two exported literal gallery-order arrays, two `<Gallery>` instances,
synthetic prose, and an unknown component. The required operation is to reorder
one gallery without rewriting unrelated MDX.

## Decision

Continue with **Option B**: a local-only Astro editor backed by our own guarded,
source-preserving adapter. Keep the editor separate from Astro rendering and
patch only a proven source range. The current supported operation remains the
small literal-gallery subset demonstrated by the prototype; this ADR does not
approve a general MDX writer or a production CMS.

Do not adopt TinaCMS, `astro-dev-edit`, or Opace as the core for this use case.
They may be reconsidered as optional integrations if a later requirement fits
their content model.

## Evidence

The spike used Astro 7.4.7, Node 26.8.1, and pnpm 11.23.0. The baseline and both
third-party Astro builds succeeded. Both candidate dev servers returned HTTP
200 with the same fixture rendering and gallery orders.

| Candidate | Result on the required source shape |
| --- | --- |
| `astro-dev-edit` 0.11.1 (MIT) | One package and one integration were sufficient to start. In the browser, selecting the rendered Gallery content reported that it was rendered by a package component and could not be edited there. Its collection entry editor does not provide the required source-array reorder for this page. |
| Opace `@opacedev/astro-visual-editor` 0.1.0-beta.7 (MIT) | One package and one integration were sufficient to start. Its Builder showed “Page structure: 0 controls” on the fixture. Its supported structural arrays are JSON/JSONC or YAML; unstructured MDX expressions are refused. The tested beta tag differs from npm's `latest` tag, so any future trial must pin a version. |
| TinaCMS 3.15.1, `@tinacms/astro` 0.8.0, CLI 4.0.4 (Apache-2.0) | `tinacms init` left the fixture untouched and generated a separate demo. A Tina collection targeting the fixture generated a local schema/admin with `tinacms build --local --skip-cloud-checks --noTelemetry`; the default cloud build failed without credentials. The Astro build then required an SSR adapter and Tina integration. Tina's MDX model registers custom components as schema templates rather than importing them in the body, so this fixture needs content-model/rendering changes. |
| Existing source-preserving prototype | `pnpm test` passed 46/46 tests and `pnpm test:e2e` passed 1/1, including a persisted reorder of one gallery, Astro preview verification, and unchanged other-gallery order. |

The three candidate copies retained the exact fixture bytes: their SHA-256
matched the common copy (`15c38141f92c1d3e110cc67bae4326e32443a39e9b5a702147585c99d2a7537f`).
The detailed comparison and command evidence are recorded in the Phase 0
[Issue #1 comment](https://github.com/all-the-rest/astro-visual-cms/issues/1#issuecomment-6712613345).

## Consequences and next gates

- Continue with a time-boxed local prototype; do not edit real project content.
- Unknown, dynamic, ambiguous, or unsupported MDX remains read-only. A rejected
  edit must not write source; stale hashes must conflict rather than overwrite.
- Generalize the adapter contract only after documenting its accepted syntax
  and testing exact-range preservation, failure cases, and production-build
  isolation. Preserve the current fixture as a regression test.
- Do not claim production readiness until conflict handling, lifecycle/security
  boundaries, supported Astro versions, and production isolation are verified.

## Phase 3 follow-on (2026-11-08)

The development-only editor now has an opt-in, server-configured content-collection
catalog and confirmed frontmatter-scalar edits for a narrowly supported static
Astro subset. The default synthetic gallery workflow is unchanged when no trusted
collection config is supplied. Collection creation remains read-only; a
server-configured, diff-only planner for static schema-field extension now has an
authenticated preview/confirm/cancel API. This follow-on does not expand the ADR
into a general content writer or approve production use. The supported paths,
patterns, validation boundary, and
remaining race/security limitations are documented in
[`gallery-editor.md`](../gallery-editor.md#phase-3-collection-editor-experimentell-nicht-produktionsreif).

### Phase 3 schema configuration write slice (2026-11-08)

Only one field may be added to an already supported static collection schema.
The config target remains server-trusted; preview binds the original config hash,
exact diff, and operation; commit replans before using the atomic writer. New
collection creation remains read-only, and the UI has no config-edit controls yet.
This narrowly tested capability does not establish Astro/Zod compatibility or
production readiness.

## Phase 4 bounded adapter experiment (2026-11-08)

A pure adapter now demonstrates literal string-prop edits on imported MDX
components using a trusted module specifier and an explicit prop allow-list.
The adapter is deliberately limited to an exact imported default binding,
configured static identity attribute, and existing quoted string props. See
[`gallery-editor.md`](../gallery-editor.md#phase-4-adapter-experiment-not-production-ready)
for the supported syntax and unresolved identity-analysis limits.

### Phase 4 editor integration (2026-11-08)

The adapter is now optionally wired through trusted server-side target
configuration to a path-free catalog and authenticated preview/confirm API.
The UI only appears when targets are configured and renders the exact source
diff using text nodes. Commits revalidate and use the existing atomic source
writer. The feature remains a local prototype: shadowing/binding ambiguity,
hostile concurrent filesystem changes, visual preview of arbitrary target
routes, broader literal forms, and release compatibility gates remain unresolved.
