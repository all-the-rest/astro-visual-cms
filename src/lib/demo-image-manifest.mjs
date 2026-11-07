/**
 * Trusted, repository-owned image sources. Paths are deliberately file names
 * rather than caller-provided paths; the resolver confines them to public/images.
 */
export const IMAGE_MANIFEST = Object.freeze([
  Object.freeze({
    slug: 'noise-fixture-01',
    file: 'noise-fixture-01.jpg',
    format: 'jpeg',
    maxBytes: 5 * 1024 * 1024,
    maxPixels: 16_000_000,
  }),
  Object.freeze({
    slug: 'noise-fixture-02',
    file: 'noise-fixture-02.jpg',
    format: 'jpeg',
    maxBytes: 5 * 1024 * 1024,
    maxPixels: 16_000_000,
  }),
  Object.freeze({
    slug: 'noise-fixture-03',
    file: 'noise-fixture-03.jpg',
    format: 'jpeg',
    maxBytes: 5 * 1024 * 1024,
    maxPixels: 16_000_000,
  }),
])

// Backward-compatible slug list used by the editor and fixture parser.
export const FIXTURE_IMAGE_SLUGS = Object.freeze(IMAGE_MANIFEST.map(({ slug }) => slug))
