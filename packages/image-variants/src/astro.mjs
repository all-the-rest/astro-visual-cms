import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { generateImageVariants } from './core.mjs'
import { loadImageVariantsConfig, resolveImageVariantsConfig } from './config.mjs'
import { toImageMetadata, toResponsiveImage } from './adapters.mjs'
import { createSourceJpegImportGuard } from './source-import-guard.mjs'

export const IMAGE_VARIANTS_VIRTUAL_ID = 'virtual:astro-visual-cms/image-variants'
const RESOLVED_VIRTUAL_ID = `\0${IMAGE_VARIANTS_VIRTUAL_ID}`
const REGENERATION_DEBOUNCE_MS = 75

function filesystemPath(value, baseDir, fallback) {
  if (value === undefined || value === null) return fallback
  if (value instanceof URL) {
    if (value.protocol !== 'file:') throw new TypeError('Astro image-variants directories must be file URLs.')
    return path.resolve(fileURLToPath(value))
  }
  if (typeof value !== 'string') throw new TypeError('Astro image-variants directories must be filesystem paths.')
  return path.resolve(baseDir, value)
}

function getProjectRoot(astroConfig) {
  const root = filesystemPath(astroConfig.root, process.cwd(), process.cwd())
  return path.resolve(root)
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function validateAstroOutput(config, publicDir) {
  if (!isWithinDirectory(publicDir, config.outputDir)) {
    throw new Error('Astro image-variants outputDir must be a dedicated directory within publicDir.')
  }
  const relative = path.relative(publicDir, config.outputDir).split(path.sep).join('/')
  const expectedPublicPath = `/${relative}`
  if (config.publicPath !== expectedPublicPath) {
    throw new Error(`Astro image-variants publicPath must match outputDir's public location (${expectedPublicPath}).`)
  }
}

function renderVirtualModule(manifest) {
  const serialized = JSON.stringify(manifest)
  return `const manifest = ${serialized};
const bySlug = new Map(manifest.images.map((image) => [image.slug, image]));
export const imageVariants = manifest;
export function getImageVariants(slug) {
  const image = bySlug.get(slug);
  if (!image) throw new Error('Unknown image-variants slug: ' + String(slug));
  return image;
}
export default manifest;
`
}

function makeVirtualModulePlugin(state) {
  return {
    name: 'astro-visual-cms-image-variants:virtual-manifest',
    resolveId(id) {
      return id === IMAGE_VARIANTS_VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined
      if (!state.manifest) throw new Error('Image-variants manifest is unavailable before Astro config setup.')
      return renderVirtualModule(state.manifest)
    },
  }
}

function resolveConfiguredOptions(options, projectRoot) {
  if (options && typeof options === 'object' && !Array.isArray(options) && Object.hasOwn(options, 'configFile')) {
    if (Object.keys(options).length !== 1 || typeof options.configFile !== 'string' || options.configFile.length === 0) {
      throw new TypeError('Astro imageVariants accepts either shared config options or { configFile } only.')
    }
    const configFile = path.resolve(projectRoot, options.configFile)
    return loadImageVariantsConfig(configFile, { baseDir: projectRoot }).then((config) => ({ config, configFile }))
  }
  return Promise.resolve({
    config: resolveImageVariantsConfig(options, { baseDir: projectRoot }),
    configFile: null,
  })
}

function imageSourcePaths(config) {
  return config.manifest.images.map(({ file }) => path.join(config.sourceRoot, file))
}

function reportDevError(logger, error) {
  const message = `Image-variants regeneration failed; preserving the last successful manifest and files: ${error.message}`
  if (typeof logger?.error === 'function') logger.error(message)
  else console.error(message)
}

/** Astro adapter: build-time generation, metadata virtual module, and exact-file dev watching. */
export function imageVariants(options) {
  const state = { config: null, configFile: null, manifest: null, projectRoot: null, publicDir: null }
  const virtualPlugin = makeVirtualModulePlugin(state)
  const importGuard = createSourceJpegImportGuard(() => state.config?.manifest, () => state.config?.sourceRoot)

  async function loadNextConfig() {
    if (state.configFile) {
      const config = await loadImageVariantsConfig(state.configFile, { baseDir: state.projectRoot })
      validateAstroOutput(config, state.publicDir)
      return config
    }
    return state.config
  }

  return {
    name: 'astro-visual-cms-image-variants',
    hooks: {
      'astro:config:setup': async ({ config: astroConfig, updateConfig }) => {
        if ((astroConfig.output ?? 'static') !== 'static') {
          throw new Error('Image variants V1 requires Astro output: "static"; server output is not supported.')
        }
        state.projectRoot = getProjectRoot(astroConfig)
        state.publicDir = filesystemPath(astroConfig.publicDir, state.projectRoot, path.join(state.projectRoot, 'public'))
        const configured = await resolveConfiguredOptions(options, state.projectRoot)
        state.config = configured.config
        state.configFile = configured.configFile
        validateAstroOutput(state.config, state.publicDir)
        state.manifest = await generateImageVariants(state.config)
        updateConfig({ vite: { plugins: [virtualPlugin, importGuard] } })
      },

      'astro:config:done': async ({ injectTypes }) => {
        const content = await readFile(new URL('../virtual-manifest.d.ts', import.meta.url), 'utf8')
        injectTypes({ filename: 'image-variants.d.ts', content })
      },

      'astro:server:setup': async ({ server, logger }) => {
        const watcher = server.watcher
        const watchedPaths = new Set()
        let closed = false
        let timer
        let running = false
        let rerun = false
        let activeGeneration = Promise.resolve()

        async function refreshWatchPaths(config) {
          const next = new Set([...imageSourcePaths(config), ...(state.configFile ? [state.configFile] : [])])
          const add = [...next].filter((filename) => !watchedPaths.has(filename))
          const remove = [...watchedPaths].filter((filename) => !next.has(filename))
          if (add.length) await watcher.add(add)
          if (remove.length) await watcher.unwatch(remove)
          watchedPaths.clear()
          for (const filename of next) watchedPaths.add(filename)
        }

        async function regenerate() {
          try {
            const nextConfig = await loadNextConfig()
            validateAstroOutput(nextConfig, state.publicDir)
            state.config = nextConfig
            await refreshWatchPaths(nextConfig)
            const nextManifest = await generateImageVariants(nextConfig)
            const changed = JSON.stringify(state.manifest) !== JSON.stringify(nextManifest)
            state.manifest = nextManifest
            if (changed) {
              const virtualModule = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID)
              if (virtualModule) server.moduleGraph.invalidateModule(virtualModule)
              server.ws?.send({ type: 'full-reload' })
            }
          } catch (error) {
            reportDevError(logger, error)
          }
        }

        function beginRegeneration() {
          if (closed) return
          if (running) {
            rerun = true
            return
          }
          running = true
          activeGeneration = regenerate().finally(() => {
            running = false
            if (rerun && !closed) {
              rerun = false
              scheduleRegeneration()
            }
          })
        }

        function scheduleRegeneration() {
          if (closed) return
          clearTimeout(timer)
          timer = setTimeout(beginRegeneration, REGENERATION_DEBOUNCE_MS)
        }

        function onFileEvent(_event, filename) {
          if (typeof filename !== 'string') return
          const absolute = path.resolve(state.projectRoot, filename)
          if (watchedPaths.has(absolute)) scheduleRegeneration()
        }

        watcher.on('all', onFileEvent)
        await refreshWatchPaths(state.config)
        state.closeWatcher = async () => {
          if (closed) return
          closed = true
          clearTimeout(timer)
          watcher.off('all', onFileEvent)
          await activeGeneration
          if (watchedPaths.size) await watcher.unwatch([...watchedPaths])
          watchedPaths.clear()
        }
      },

      'astro:server:done': async () => {
        await state.closeWatcher?.()
        state.closeWatcher = undefined
      },
    },
  }
}

export { toImageMetadata, toResponsiveImage }
