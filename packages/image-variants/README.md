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

The primary package entry points are the root core,
`@astro-visual-cms/image-variants/cli`, and
`@astro-visual-cms/image-variants/astro`. Supplementary supported exports are
`@astro-visual-cms/image-variants/config` (shared config helpers) and
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
