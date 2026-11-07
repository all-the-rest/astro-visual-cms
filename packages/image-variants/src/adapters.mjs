function validateGeneratedImage(image) {
  if (!image || typeof image !== 'object' || typeof image.slug !== 'string' ||
      !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      !Array.isArray(image.variants) || image.variants.length === 0 ||
      image.variants.some((variant) => !variant || variant.format !== 'webp' || typeof variant.url !== 'string' ||
        !Number.isSafeInteger(variant.width) || !Number.isSafeInteger(variant.height))) {
    throw new TypeError('Expected one generated V1 image-variants result.')
  }
}

/** Adapt generated technical metadata to the common URL-based image metadata shape. */
export function toImageMetadata(image) {
  validateGeneratedImage(image)
  const largest = image.variants.at(-1)
  return Object.freeze({ src: largest.url, width: image.width, height: image.height, format: 'webp' })
}

/** Return source metadata with responsive srcset and an explicit sizes value. */
export function toResponsiveImage(image, { sizes = '100vw' } = {}) {
  validateGeneratedImage(image)
  if (typeof sizes !== 'string' || sizes.length === 0) throw new TypeError('sizes must be a non-empty string.')
  return Object.freeze({
    ...toImageMetadata(image),
    srcset: image.variants.map(({ url, width }) => `${url} ${width}w`).join(', '),
    sizes,
  })
}
