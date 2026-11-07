/** Only synthetic fixture inputs and transform limits belong in this manifest. */
export const SOURCE_MANIFEST = Object.freeze([
  Object.freeze({
    slug: 'synthetic-noise-one',
    file: 'synthetic-noise-one.jpg',
    format: 'jpeg',
    maxBytes: 1_000_000,
    maxPixels: 100_000,
    widths: Object.freeze([80, 160, 320]),
  }),
  Object.freeze({
    slug: 'synthetic-noise-two',
    file: 'synthetic-noise-two.jpg',
    format: 'jpeg',
    maxBytes: 1_000_000,
    maxPixels: 100_000,
    widths: Object.freeze([80, 160, 320]),
  }),
])
