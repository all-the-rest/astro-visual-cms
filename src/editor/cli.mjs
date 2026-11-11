#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEditorServer } from './server.mjs'

export async function startEditorServer({ configPath = process.env.AVCMS_CONFIG } = {}) {
  if (!configPath) throw new TypeError('Pass a trusted JSON config path as --config <path> or AVCMS_CONFIG.')
  const absoluteConfigPath = path.resolve(configPath)
  const options = JSON.parse(await readFile(absoluteConfigPath, 'utf8'))
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Editor config must be a JSON object.')
  if (typeof options.fixturePath !== 'string' || !options.fixturePath) throw new TypeError('The trusted editor config must provide fixturePath.')
  const configDirectory = path.dirname(absoluteConfigPath)
  const projectRoot = options.projectRoot && path.resolve(configDirectory, options.projectRoot)
  const contentConfigPath = options.contentConfigPath && path.resolve(configDirectory, options.contentConfigPath)
  const fixturePath = path.resolve(configDirectory, options.fixturePath)
  const resolveTargets = (targets) => Array.isArray(targets) ? targets.map((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return target
    const root = path.resolve(configDirectory, target.projectRoot ?? projectRoot ?? '.')
    return { ...target, projectRoot: root, ...(typeof target.filePath === 'string' ? { filePath: path.resolve(root, target.filePath) } : {}) }
  }) : targets
  const astroGalleryTargets = Array.isArray(options.astroGalleryTargets) ? options.astroGalleryTargets.map((target) => {
    if (!target || typeof target !== 'object') return target
    const root = path.resolve(configDirectory, target.projectRoot ?? projectRoot ?? '.')
    return { ...target, projectRoot: root, filePath: path.resolve(root, target.filePath) }
  }) : options.astroGalleryTargets
  const server = createEditorServer({
    ...options,
    ...(projectRoot ? { projectRoot } : {}),
    ...(contentConfigPath ? { contentConfigPath } : {}),
    fixturePath,
    ...(options.mdxComponentTargets !== undefined ? { mdxComponentTargets: resolveTargets(options.mdxComponentTargets) } : {}),
    ...(options.mdxBlockTargets !== undefined ? { mdxBlockTargets: resolveTargets(options.mdxBlockTargets) } : {}),
    ...(options.mdxParagraphTargets !== undefined ? { mdxParagraphTargets: resolveTargets(options.mdxParagraphTargets) } : {}),
    ...(astroGalleryTargets !== undefined ? { astroGalleryTargets } : {}),
  })
  const port = Number(options.port ?? process.env.EDITOR_PORT ?? 4322)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

if (process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()) {
  const configIndex = process.argv.indexOf('--config')
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined
  startEditorServer({ configPath }).then((server) => {
    console.log(`Astro Visual CMS editor: http://127.0.0.1:${server.address().port}`)
    const close = () => server.close(() => process.exit())
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
