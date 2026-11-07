import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validateImageVariantsManifest } from './config.mjs'

function stripQueryAndHash(value) {
  const suffix = value.search(/[?#]/)
  return suffix < 0 ? value : value.slice(0, suffix)
}

function filesystemPathFromId(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (/^file:/i.test(value)) {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    url.search = ''
    url.hash = ''
    return path.resolve(fileURLToPath(url))
  }

  const pathname = stripQueryAndHash(value)
  if (pathname.startsWith('/@fs/')) {
    const filesystemPath = pathname.slice('/@fs/'.length)
    return path.resolve(path.isAbsolute(filesystemPath) ? filesystemPath : `/${filesystemPath}`)
  }
  return path.isAbsolute(pathname) ? path.resolve(pathname) : null
}

function resolveImportedPath(source, importer) {
  const directPath = filesystemPathFromId(source)
  if (directPath) return directPath

  const importerPath = filesystemPathFromId(importer)
  if (!importerPath || typeof source !== 'string' || !/^\.\.?[\\/]/.test(source)) return null

  const pathname = decodeURIComponent(stripQueryAndHash(source))
  if (!pathname) return null
  return path.resolve(path.dirname(importerPath), pathname)
}

function mightNameConfiguredSource(source, configuredNames) {
  if (typeof source !== 'string') return false
  const pathname = stripQueryAndHash(source)
  const candidates = [pathname]
  try {
    candidates.push(decodeURIComponent(pathname))
  } catch {
    // Keep the raw spelling too; a malformed URI must not make a configured
    // basename disappear from the fail-closed check below.
    const raw = pathname.replaceAll('\\', '/').toLocaleLowerCase('en-US')
    if ([...configuredNames].some((name) => raw.includes(name))) return true
  }
  return candidates.some((candidate) => {
    const basename = candidate.replaceAll('\\', '/').split('/').at(-1)
    return configuredNames.has(basename.normalize('NFC').toLocaleLowerCase('en-US'))
  })
}

async function canonicalPath(candidate) {
  try {
    return { path: await realpath(candidate), resolved: true }
  } catch {
    return { path: path.resolve(candidate), resolved: false }
  }
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  if (process.platform === 'win32') {
    return normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
  }
  return normalizedLeft === normalizedRight
}

/**
 * Vite/Rollup guard that rejects configured JPEGs imported as image modules.
 * Pass the sourceRoot used by the generator so same-basename files elsewhere
 * in the project can be resolved and allowed.
 */
export function createSourceJpegImportGuard(sourceManifest, sourceRoot) {
  const getManifest = typeof sourceManifest === 'function'
    ? sourceManifest
    : () => sourceManifest
  const getSourceRoot = typeof sourceRoot === 'function'
    ? sourceRoot
    : () => sourceRoot

  return {
    name: 'astro-visual-cms-image-variants:source-jpeg-import-guard',
    enforce: 'pre',
    async resolveId(source, importer) {
      const manifest = validateImageVariantsManifest(getManifest())
      const configuredRoot = getSourceRoot()
      if (typeof configuredRoot !== 'string' || configuredRoot.length === 0) {
        throw new TypeError('The source JPEG import guard requires a configured sourceRoot.')
      }
      const sourceRootPath = path.resolve(configuredRoot)
      const configuredPaths = manifest.images.map(({ file }) => path.resolve(sourceRootPath, file))
      const configuredNames = new Set(manifest.images.map(({ file }) => file.normalize('NFC').toLocaleLowerCase('en-US')))

      let importedPath
      try {
        importedPath = resolveImportedPath(source, importer)
      } catch (error) {
        if (!mightNameConfiguredSource(source, configuredNames)) throw error
      }

      // Let Vite resolve aliases and other supported specifiers to their actual
      // file before comparing. skipSelf prevents this guard from recursing.
      if (!importedPath && typeof this?.resolve === 'function') {
        try {
          const resolved = await this.resolve(source, importer, { skipSelf: true })
          if (typeof resolved === 'string') importedPath = filesystemPathFromId(resolved)
          else if (resolved?.id) importedPath = filesystemPathFromId(resolved.id)
        } catch (error) {
          if (!mightNameConfiguredSource(source, configuredNames)) throw error
        }
      }

      if (importedPath) {
        const actual = await canonicalPath(importedPath)
        for (const configuredPath of configuredPaths) {
          const configured = await canonicalPath(configuredPath)
          if (samePath(actual.path, configured.path)) {
            throw new Error('Configured source JPEGs must be transformed at build time, not imported as Vite image modules.')
          }
        }
        if (!actual.resolved && mightNameConfiguredSource(source, configuredNames)) {
          throw new Error('Could not safely resolve a possible configured source JPEG import.')
        }
        return undefined
      }

      if (mightNameConfiguredSource(source, configuredNames)) {
        throw new Error('Could not safely resolve a possible configured source JPEG import.')
      }
      return undefined
    },
  }
}
