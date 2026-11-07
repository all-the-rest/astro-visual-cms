/** Prevent manifest sources from silently reverting to static Vite image imports. */
export function createImageManifestImportGuard(manifest) {
  const imageFiles = new Set(manifest.map(({ file }) => file.toLocaleLowerCase('en-US')))

  return {
    name: 'image-manifest-import-guard',
    enforce: 'pre',
    resolveId(source) {
      const rawPath = source.replace(/[?#].*$/, '')
      const candidates = [rawPath]
      try {
        candidates.push(decodeURIComponent(rawPath))
      } catch {
        // An invalid URI escape cannot name a manifest file.
      }

      const isManifestImage = candidates.some((candidate) => {
        const platformNeutralPath = candidate.replaceAll('\\', '/')
        const basename = platformNeutralPath.slice(platformNeutralPath.lastIndexOf('/') + 1)
          .toLocaleLowerCase('en-US')
        return imageFiles.has(basename)
      })
      if (isManifestImage) {
        throw new Error('Manifest image files must be resolved by slug, not as Vite image modules.')
      }
    },
  }
}
