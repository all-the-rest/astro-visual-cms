import { IMAGE_MANIFEST } from './demo-image-manifest.mjs'
import { resolveImageSource, validateImageManifest } from './image-slug-resolver.internal.mjs'

/**
 * Public slug-based metadata contract. Returned metadata contains only a local
 * web URL and image properties; filesystem paths are reserved for the private
 * Astro 7.4.7 adapter. The manifest is trusted repository input, not a request
 * supplied path map. Local files can still change between validation and Astro
 * reading them (TOCTOU); deployments must treat these sources as trusted.
 */
export async function resolveImageMetadata(slug) {
  const { metadata } = await resolveImageSource(slug)
  return metadata
}

// Keep the fixture API stable for existing consumers of the spike.
export const resolveFixtureImageMetadata = resolveImageMetadata

export { IMAGE_MANIFEST, validateImageManifest }
