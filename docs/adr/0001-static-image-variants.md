# ADR 0001: Shared build-time image variants for Astro

- **Status:** Accepted; repository-local package contract
- **Issue:** [#8](https://github.com/all-the-rest/astro-visual-cms/issues/8)
- **Scope:** Technical pixel variants only. This does not authorize a production migration.

## Context

PR #7 proves that a synthetic Astro static build can use Sharp-generated,
content-addressed WebP files without importing source JPEGs as Vite image
modules. This ADR formalizes that repository-local proof as a maintained
package API and Astro integration.

Consuming projects have their own slug/content catalogs and descriptive
metadata. In the reference project, YAML provides descriptions and curated
EXIF fields; these must not become dependencies or outputs of the shared pixel
pipeline.

## Decision

Create one repository-local package, tentatively named
`@astro-visual-cms/image-variants`, with three public entry points:

| Export | Responsibility |
| --- | --- |
| `@astro-visual-cms/image-variants` | Astro-independent Node/Sharp core and versioned technical manifest types. |
| `@astro-visual-cms/image-variants/cli` | Explicit `generate` command for CI and non-Astro build scripts; delegates to the core. |
| `@astro-visual-cms/image-variants/astro` | First-class Astro integration; delegates to the same core during builds and development. |

These are the three **primary** entry points. The package also supports the
following supplementary exports, as declared in `packages/image-variants/package.json`:

| Export | Responsibility |
| --- | --- |
| `@astro-visual-cms/image-variants/config` | The shared manifest/config validation and loading functions, also re-exported from the package root. |
| `@astro-visual-cms/image-variants/astro/StaticImage.astro` | Static `<picture>/<img>` component for rendering the Astro integration's result. |
| `createSourceJpegImportGuard` from `@astro-visual-cms/image-variants` | Advanced Vite/Rollup plugin helper; takes a manifest and its `sourceRoot`. The Astro integration installs it automatically. |

Keep one package version and implementation. Keep it private/repository-local
until the contract and synthetic integration are validated; publishing is a
separate decision. The CLI does not replace or downgrade the Astro integration.

The Astro integration generates files before Astro consumes/copies public
assets. In dev it generates once at startup and watches only configured source
files and the manifest. Changes are serialized/debounced and update the same
static files/manifest; generated outputs are excluded from the watch set. There
is no request-time image transform service or generated image-file module in
Vite's graph; the integration may expose a metadata-only virtual module.
Supported build/SSR modes must serve the resulting static asset paths through
the host deployment.

## V1 API contract

### Configuration and source manifest

The core entry point exposes:

```js
generateImageVariants({ manifest, sourceRoot, outputDir, publicPath })
```

The CLI and Astro integration accept the same configuration and call this
function; neither reimplements transforms. The versioned source manifest has
this technical-only shape:

```js
{
  manifest: {
    version: 1,
    images: [{
      slug: 'sample-cover',
      file: 'sample-cover.jpg', // basename under sourceRoot, not an arbitrary path
      format: 'jpeg',
      maxBytes: 1_000_000,
      maxPixels: 100_000,
      widths: [80, 160, 320],
    }],
  },
  sourceRoot: './source-images',
  outputDir: './public/variants',
  publicPath: '/variants',
}
```

The manifest is a versioned, technical-only JSON object. Slugs/files must be
unique; slugs are stable consumer-selected identifiers.
V1 accepts local JPEG files only, a bounded list, strictly increasing widths,
and configured byte/pixel limits under fixed package hard ceilings: 16 images,
5 MiB per source, 10 million source pixels, 8 variants per image, and a maximum
variant width of 8192 pixels. A requested width may not exceed the source
width. Traversal,
symlinked roots/ancestors/sources, non-files, missing files, malformed JPEGs,
and limit violations fail closed. `outputDir` is a dedicated generated-assets
directory. V1 never prunes old cache entries: a source change adds new
content-addressed files, and cleanup remains a separate operation until it can
be proven safe. A failed generation does not publish a new technical manifest
and does not remove the previous usable output.

### Technical result and content identity

The result is a V1 technical manifest:

```js
{
  version: 1,
  transformNamespace: 'v1-webp-q82-e4__sharp-<version>__vips-<version>',
  images: [{
    slug: 'sample-cover',
    width: 320,
    height: 180,
    variants: [{
      url: '/variants/<transform-namespace>/<hash-prefix>/<64-hex-hash>_160.webp',
      format: 'webp',
      width: 160,
      height: 90,
    }],
  }],
}
```

URLs are public paths, never filesystem paths. Compute the full, lowercase
64-hex SHA-256 over the **original source image buffer before encoding any
variants**. All widths for one source share that hash. Do not hash encoded WebP
bytes. Store each file as
`<transform-namespace>/<hash-prefix>/<hash>_<width>.webp` under `outputDir`;
`hash-prefix` is the first two characters of the full hash. The namespace
includes the output schema/transform policy and the Sharp/libvips versions, so
encoder or policy upgrades cannot silently reuse stale output. Source-byte
changes change every variant URL; unchanged source bytes and transform namespace
retain their identity. V1 output is WebP at quality 82 and effort 4. Future
consumers needing a 16-hex legacy URL use a separate URL adapter; the core hash
is not truncated.

If the current full source hash, transform namespace, and every requested variant
are present and valid, regenerate the expected WebP bytes and compare them
byte-for-byte before reusing the files. This integrity check detects valid but
incorrect cache content; it spends transform CPU on cache hits but does not
rewrite matching files. If the hash/namespace changes or any requested variant
is missing, generate the complete requested set; expose the new technical
manifest only after successful generation. A malformed or wrong-dimension
regular cache file at the expected path is atomically repaired; a valid file
with different bytes is treated as a content collision and is not overwritten.
Existing files are never removed as part of this process. The source hash is a
cache identity, not a security boundary.

`publicPath` is a canonical absolute URL path prefix (default `/variants`),
independent of filesystem paths; literal whitespace is rejected. In Astro,
`outputDir` must map to that same location beneath
`publicDir`. Deployments/CDNs must serve these paths unchanged and include
the full path in the cache key. New URLs are safe to cache immutably. A deploy
may retain old content-addressed assets while old HTML is still served; the
package does not delete remote CDN objects.

### Astro surface

The `astro` export provides an `imageVariants(config)` integration. It accepts
the same options as the core, or a JSON `configFile` containing those options.
Inline relative paths resolve against Astro's configured project root. Paths
from a config file also resolve against that project root for Astro; the CLI
resolves them against the config file's directory. The integration requires
SSG (`output: 'static'`) for V1; server output is not
claimed until a separate deployment test proves how the adapter serves public
assets. It performs initial generation during `astro:config:setup`, before
Vite/Astro consumes public assets. During dev, it registers source/manifest
watchers in `astro:server:setup`: only configured source files and, when using
`configFile`, that file are added to the integration's watch set. Changes are
serialized/debounced, generated output is excluded, and watch resources are
removed on `astro:server:done`. A build generation error fails the build; a dev
generation error is reported while preserving the last successful manifest
and files, and the watcher remains able to recover on a later valid change.

The core also exports `toImageMetadata(image)`, which returns the consumer-
neutral `{ src, width, height, format }` shape, and
`toResponsiveImage(image, { sizes })`, which adds responsive `srcset`/`sizes`
data. `src` is the largest generated WebP URL; dimensions describe the source
image. These adapters contain no project catalog or descriptive metadata.

The integration exposes the generated technical manifest through one
documented virtual module, for example:

```js
import { getImageVariants } from 'virtual:astro-visual-cms/image-variants'
import StaticImage from '@astro-visual-cms/image-variants/astro/StaticImage.astro'
const image = getImageVariants('sample-cover')
```

```astro
<StaticImage image={image} alt="Consumer-owned descriptive text" sizes="100vw" />
```

The lookup returns the V1 technical result for a known slug and fails clearly
for unknown slugs. The virtual module contains no source paths or descriptive
metadata. The integration injects the corresponding ambient TypeScript module
declaration during Astro config completion so consumers can type imports of
`imageVariants`, `getImageVariants`, and the default manifest. A package Astro component renders a static `<picture>/<source>/<img>`
from generated public URLs and receives `alt` from the consumer. It does not use
Astro's `Image` optimizer: import-free public URLs are not claimed to be
optimizable by `astro:assets`, and the package never fabricates private
`fsPath`. `sourceRoot` and `outputDir`
must be filesystem paths; the Astro adapter resolves relative paths against
Astro's configured project root and requires generated output to be within
`publicDir`. `publicPath` is an absolute URL path prefix (default
`/variants`), independent of filesystem paths and configured deployment base.
Integration tests must prove startup generation, watch invalidation, static
asset HTTP serving, full source-hash URLs, and same-slug pixel changes without
source image imports.

The CLI contract is `image-variants generate --config <file>` and writes the
same technical result as JSON to stdout; it is independently usable without
Astro. Config files are JSON and contain the same manifest and path fields. The
core receives normalized absolute filesystem paths. Configuration validation
and error semantics are shared with the CLI and Astro integration.

The advanced root export `createSourceJpegImportGuard(manifest, sourceRoot)` is
a Vite/Rollup pre-resolution plugin. It compares resolved imported file paths to
the configured manifest files, including relative imports resolved against the
importer; unresolved imports that could name a configured file fail closed.
Consumers should normally use the Astro integration instead of installing this
helper themselves.

## Metadata ownership and explicit non-goals

- YAML loading, alt/description text, categories, app flags, and curated EXIF
  remain in each consuming project or a later project-specific package.
- No `astro:assets` `Image` optimizer claim, no private `fsPath`, and no
  request-time transform service.
- No AVIF, non-JPEG sources, EXIF copying, EXIF orientation normalization,
  animation, remote inputs, or runtime transforms in V1.
- The current evidence is pinned to Node `>=22.23.4`, Astro `7.4.7`, and Sharp
  `0.35.5`; broader support requires an explicit CI matrix.
- No production `reisinger.pictures` migration or content/image changes.

## Consequences and validation before extraction

The synthetic Astro integration proof must exercise both `astro build` and a
running `astro dev` server, and verify watch updates with generated noise JPEGs
only. It must also prove cleanup safety, generation failure behavior, the Vite
source-import guard, deterministic output, and recovery when a source changes.
The shared package is repository-local; publication remains a separate decision.
