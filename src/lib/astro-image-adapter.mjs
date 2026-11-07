import { resolveImageSource } from './image-slug-resolver.internal.mjs'

/**
 * Private, experimental adapter for Astro 7.4.7's current Image metadata shape.
 * Astro internally reads the non-enumerable `fsPath`; this is not a supported
 * public Astro API and the path must not cross the resolver's metadata contract.
 */
export async function resolveAstroImageMetadata(slug) {
  const { metadata, sourcePath } = await resolveImageSource(slug)
  Object.defineProperty(metadata, 'fsPath', {
    value: sourcePath,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return metadata
}
