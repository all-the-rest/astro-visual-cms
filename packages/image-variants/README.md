# `@astro-visual-cms/image-variants`

Repository-local V1 package for generating static WebP variants from bounded
synthetic or project-local JPEG inputs. It is private and is not yet published.

```js
import { generateImageVariants } from '@astro-visual-cms/image-variants'

const result = await generateImageVariants({
  manifest: {
    version: 1,
    images: [{
      slug: 'sample-cover',
      file: 'sample-cover.jpg',
      format: 'jpeg',
      maxBytes: 1_000_000,
      maxPixels: 100_000,
      widths: [80, 160, 320],
    }],
  },
  sourceRoot: './source-images',
  outputDir: './public/variants',
  publicPath: '/variants',
})
```

The source identity is the full SHA-256 of original JPEG bytes. Output paths
include a namespace for the V1 transform policy and Sharp/libvips versions, then
the full source hash, shared across widths. Files are additive and immutable;
the package never rewrites source images or prunes old cache entries. Invalid
regular cache files are atomically repaired; valid files with different bytes
are not overwritten. Complete cache hits are verified against freshly encoded
bytes, favoring integrity over avoiding Sharp transform work.

## Optional legacy CDN compatibility

The opt-in `@astro-visual-cms/image-variants/legacy-cdn` export projects a V1
result onto the legacy manifest shape and can copy its generated files to the
legacy object keys. It does not change the core result, root exports, URLs, or
default Astro integration behavior:

```js
import { generateImageVariants } from '@astro-visual-cms/image-variants'
import {
  projectLegacyManifest,
  writeLegacyVariantArtifacts,
} from '@astro-visual-cms/image-variants/legacy-cdn'

const result = await generateImageVariants(config)
const generated = new Date().toISOString()
const projection = projectLegacyManifest(result, {
  publicPath: '/variants', // exact publicPath used for V1 generation
  generated,
  baseUrl: 'https://cdn.example.test', // optional canonical origin only
})

const written = await writeLegacyVariantArtifacts(result, {
  publicPath: '/variants',
  generated,
  sourceDir: './public/variants', // V1 outputDir
  outputDir: './legacy-public',
  baseUrl: 'https://cdn.example.test',
  // overwrite: true, // only when replacing existing mutable legacy objects deliberately
})
```

`projectLegacyManifest` is a pure projection and returns `{ manifest, artifacts }`.
The manifest has exactly `{ version: 1, generated, images }`; each image entry
has only `{ hash, width, height, variants }`. The legacy hash is the first 16
hex characters of the full source hash. Artifact metadata separately identifies
each public `url` and relative `objectKey`. The adapter derives the full hash
only from URLs that exactly match the supplied V1
`publicPath`, the result's transform namespace, and the V1 full-hash/width path
pattern. It rejects malformed or mixed-hash results, duplicate slugs/keys, and
distinct full hashes with the same 16-hex truncation (`LEGACY_HASH_COLLISION`).
The `generated` timestamp is explicit, ISO-8601 UTC with millisecond precision;
the projection does not read the clock. `baseUrl`, when supplied, must be a
canonical HTTP(S) origin without credentials or a path.

`writeLegacyVariantArtifacts` reads only the expected V1 files derived from
those validated URLs and copies their bytes beneath the caller's `outputDir`.
It rejects symlinked roots, directory components, source files, and legacy
targets; each artifact is capped at 64 MiB and one operation at 256 MiB before
copy allocation; it does not prune unrelated files. Existing legacy keys fail by
default. With `overwrite: true`, each existing regular file is replaced
atomically using a same-directory temporary file and rename. The return value's
`invalidationUrls` lists every published public URL in overwrite mode, including
keys that may have appeared after preflight; the adapter does not purge a CDN.
A batch is atomic per file, not as a whole. If a later file fails after earlier
keys were published, the rejected error includes those successful URLs in its
`invalidationUrls` property so callers can still invalidate them.

Source and destination roots must be trusted and not concurrently modified while
the writer runs. Portable Node path APIs cannot prevent a hostile process from
swapping checked directories between path validation and filesystem operations.

Legacy keys are mutable and use weaker identity than V1 URLs. The legacy
consumer's historical quality-75 WebP bytes are not byte-compatible with V1's
quality-82/effort-4 outputs. Rebuilding or changing transform policy/encoder
versions can therefore change bytes at the same legacy URL. Do not claim
immutable caching for legacy URLs; replacing them requires deliberate CDN
invalidation. The default refusal avoids accidental replacement, and explicit
overwrite is an operator decision.

The primary package entry points are the root core,
`@astro-visual-cms/image-variants/cli`, and
`@astro-visual-cms/image-variants/astro`. Supplementary supported exports are
`@astro-visual-cms/image-variants/config` (shared config helpers) and
`@astro-visual-cms/image-variants/legacy-cdn` (the optional legacy projection/copy adapter) and
`@astro-visual-cms/image-variants/astro/StaticImage.astro` (the static component).
The root also exports `createSourceJpegImportGuard(manifest, sourceRoot)` as an
advanced Vite/Rollup helper; the Astro integration installs it automatically.

The `./astro` export adds a build/dev integration and the virtual
`virtual:astro-visual-cms/image-variants` technical manifest. The optional
`./astro/StaticImage.astro` component renders ordinary static `<picture>` and
`<img>` markup from those public URLs. This is not an `astro:assets` `Image`
adapter: public URLs are not passed through Astro's image optimizer, and no
private Astro filesystem fields are fabricated. Alt text and descriptive
metadata remain consumer-owned. Astro automatically includes the virtual module's
TypeScript declarations through its injected project types.

See [`docs/adr/0001-static-image-variants.md`](../../docs/adr/0001-static-image-variants.md)
for the complete V1 contract. The synthetic Astro end-to-end verifier is
`pnpm run verify:image-variants-astro` (also included in `pnpm run verify`); it
uses generated Noise JPEGs in a temporary app root to exercise a real build,
dev HTTP serving, watch invalidation, failed-generation preservation, and
recovery.
