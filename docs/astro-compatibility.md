# Astro compatibility checkpoints

The configured CI compatibility matrix targets Node 24 / pnpm 11.23.0 at fixed
Astro checkpoints `7.2.4`, `7.2.10`, `7.3.8`, and `7.4.7`. These representative
versions do not establish generic compatibility with every Astro 7 release or
future minor. Issue #1 remains **Partial**.

Run one checkpoint with `npm run verify:astro-compat -- 7.2.4` (or another listed
version). Each invocation creates a fresh temporary consumer, runs `npm pack`,
installs that actual tarball alongside the exact Astro version, and removes the
temporary project and dev process in `finally`. It exercises an imported Astro
component with explicit target/instance markers and an Astro-optimized image,
`base: '/compat/'`, a trusted preview route, production build assertions, and a
real `astro dev` request to the prefixed route and optimized image endpoint.
Development HTML and the generated page-script module must expose the injected
bridge. Production HTML is checked for the expected rendered markers and optimized
asset; every file under `dist/` is scanned for bridge or toolbar markers.

Astro 7.2.4 exercises the component from an `.astro` page and deliberately does
not install MDX. For 7.2.10, 7.3.8, and 7.4.7, the same component is additionally
imported from an MDX route with `@astrojs/mdx@8.1.3`. MDX coverage starts at
7.2.10 because that MDX release declares peer dependency `astro: ^7.2.10`.
These registry-installed exact versions are isolated to the temporary fixture;
the production dependency graph is unchanged.

Compatibility coverage is intentionally bounded to this fixture and these
checkpoints. It does not resolve unknown syntax, alter the local `astro dev`
workflow, or address races with non-cooperating writers. Only explicit trusted
markers and adapter mappings establish source mapping.

The separate `pnpm run verify:collection-astro` gate remains pinned to Astro
7.4.7 and checks planner-generated static collection Content Sync, inferred field
types, and rendering. That collection-specific path is not covered by the version
matrix and has no cross-version compatibility claim.

The integration lifecycle hook is still restricted to `command === 'dev'`;
existing lifecycle and production-isolation tests cover that contract. The matrix
adds actual packed-tarball build/dev checks at its listed Astro checkpoints, but
does not replace the dedicated Content Sync or external production-consumer gates.

The manual `reisinger.pictures` acceptance additionally covered Astro 7.4.1 with
`@astrojs/mdx` 8.1.0 and Satteri 0.10.5 for the bounded visual Markdown draft
(including the Satteri 0.10 `setProperty` mutator). That checkpoint is
manual-only: it is not part of this matrix and the matrix does not configure a
Markdown draft target. See [external-acceptance.md](external-acceptance.md).
