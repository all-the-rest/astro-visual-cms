import { timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@mdx-js/mdx'
import { hashSource } from '../lib/gallery-patch.mjs'
import { createMdxBlocksAdapter } from '../lib/mdx-blocks.mjs'
import { buildMarkdownPreviewModule } from './markdown-preview.mjs'

const MAX_PREVIEW_BODY_BYTES = 12 * 1024
const MAX_SOURCE_BYTES = 1024 * 1024
// An unacknowledged draft is the window between the bridge returning the
// preview and the editor confirming the page actually rendered. The editor
// waits up to 8 seconds for that reload and then posts the acknowledgement, so
// this grace period must stay comfortably above the client wait plus network
// and scheduling delays; otherwise a slow render is dropped mid-flight even
// though Astro produced a valid draft.
export const PREVIEW_RENDER_TIMEOUT_MS = 30_000
// An acknowledged overlay is still an in-memory preview, not saved source. It is
// bounded so a lost editor session (reload, crash, closed tab) cannot leave a
// draft rendered forever; the editor also reclaims orphaned overlays explicitly.
// Keep this in sync with the server's pending-preview TTL (PREVIEW_TTL_MS):
// a confirmable preview must live at least as long as the overlay it describes.
export const PREVIEW_OVERLAY_LIFETIME_MS = 15 * 60_000
const MAX_OVERLAY_LIFETIME_MS = 24 * 60 * 60_000

function equalToken(actual, expected) {
  const left = Buffer.from(typeof actual === 'string' ? actual : '', 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function splitQuery(id) {
  const index = id.indexOf('?')
  return index === -1 ? [id, ''] : [id.slice(0, index), id.slice(index)]
}

// Astro collects the CSS a route needs through a per-route virtual module
// (`\0virtual:astro:dev-css:<route>`). It is cached until a file changes, so an
// in-memory draft that starts importing a block component would render without
// that component's styles. Invalidate the route's collector alongside the
// module swap so the preview keeps the page's real styling.
export function devCssModuleId(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath).split(path.sep).join('/')
  const extension = path.extname(relative)
  if (!extension) return null
  const masked = `${relative.slice(0, -extension.length)}@_@${extension.slice(1)}`
  return `\0virtual:astro:dev-css:${masked}`
}

function virtualPreviewId(target) {
  const extension = target.format === 'md' ? '.astro' : '.mdx'
  return path.join(path.dirname(target.filePath), `.${path.basename(target.filePath)}.${target.id}.avcms-preview${extension}`)
}

function readTarget(target) {
  const file = target.filePath
  const relative = path.relative(target.projectRoot, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('Target is unavailable.'), { code: 'UNSAFE_PATH' })
  let current = target.projectRoot
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw Object.assign(new Error('Target is unavailable.'), { code: 'UNSAFE_PATH' })
  }
  if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw Object.assign(new Error('Target is unavailable.'), { code: 'UNSAFE_PATH' })
  const bytes = readFileSync(file)
  if (bytes.length > MAX_SOURCE_BYTES) throw Object.assign(new Error('Target exceeds the source limit.'), { code: 'SOURCE_LIMIT' })
  const source = bytes.toString('utf8')
  if (!Buffer.from(source, 'utf8').equals(bytes)) throw Object.assign(new Error('Target encoding is unsupported.'), { code: 'UNSUPPORTED_ENCODING' })
  return { file, source }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_PREVIEW_BODY_BYTES) throw Object.assign(new Error('Request body too large.'), { status: 413 })
  }
  try { return JSON.parse(body) } catch { throw Object.assign(new Error('Expected a JSON request.'), { status: 400 }) }
}

function applyOperations(target, source, operations, hash) {
  if (!Array.isArray(operations) || operations.length > 32) throw Object.assign(new Error('Invalid block operation list.'), { code: 'INVALID_OPERATION' })
  let revision = hash
  let currentSource = source
  let result
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw Object.assign(new Error('Invalid block operation.'), { code: 'INVALID_OPERATION' })
    let generatedId
    let cleanOperation = operation
    if (operation.action === 'add') {
      if (Object.keys(operation).sort().join(',') !== 'action,blockId,blockType,values' || typeof operation.blockId !== 'string') {
        throw Object.assign(new Error('Invalid add operation.'), { code: 'INVALID_OPERATION' })
      }
      generatedId = operation.blockId
      const { blockId, ...rest } = operation
      cleanOperation = rest
    }
    result = target.adapter.patch(currentSource, cleanOperation, revision, generatedId)
    currentSource = result.source
    revision = result.nextHash
  }
  if (!result) throw Object.assign(new Error('A block preview requires at least one operation.'), { code: 'INVALID_OPERATION' })
  return result
}

/** Dev-only Vite overlay: recompile validated MDX drafts without writing source. */
export function createMdxBlockPreviewPlugin({
  targets = [],
  token,
  siteOrigin,
  renderTimeoutMs = PREVIEW_RENDER_TIMEOUT_MS,
  overlayLifetimeMs = PREVIEW_OVERLAY_LIFETIME_MS,
  markdown,
  image,
  astroRoot,
}) {
  if (typeof token !== 'string' || token.length < 32 || !(typeof siteOrigin === 'string' || typeof siteOrigin === 'function')) throw new TypeError('Invalid MDX block preview bridge configuration.')
  if (!Number.isInteger(renderTimeoutMs) || renderTimeoutMs < 1 || renderTimeoutMs > MAX_OVERLAY_LIFETIME_MS) throw new TypeError('Invalid MDX block preview render timeout.')
  if (!Number.isInteger(overlayLifetimeMs) || overlayLifetimeMs < 1 || overlayLifetimeMs > MAX_OVERLAY_LIFETIME_MS) throw new TypeError('An acknowledged MDX block overlay must have a bounded lifetime.')
  const configured = targets.map((target) => {
    const projectRoot = path.resolve(target.projectRoot)
    const filePath = path.resolve(target.filePath)
    if (typeof target.id !== 'string' || !/^[A-Za-z_$][\w$-]{0,63}$/.test(target.id) ||
        !filePath.startsWith(`${projectRoot}${path.sep}`) || realpathSync(projectRoot) !== projectRoot || !lstatSync(projectRoot).isDirectory() ||
        !['.md', '.mdx'].includes(path.extname(filePath)) || realpathSync(filePath) !== filePath || !lstatSync(filePath).isFile()) {
      throw new TypeError('MDX block preview target must be a canonical file inside a canonical project root.')
    }
    const format = path.extname(filePath) === '.md' ? 'md' : 'mdx'
    const draftPath = format === 'md' ? virtualPreviewId({ id: target.id, filePath, format }) : null
    if (draftPath && existsSync(draftPath)) throw new TypeError('MDX block preview virtual module collides with an existing file.')
    return { ...target, projectRoot, filePath, format, draftPath, requestPath: target.requestPath ?? target.previewPath, adapter: createMdxBlocksAdapter({ blockTypes: target.blockTypes, format }) }
  })
  if (new Set(configured.map((target) => target.id)).size !== configured.length) throw new TypeError('MDX block preview target IDs must be unique.')
  const cssRoot = typeof astroRoot === 'string' ? path.resolve(astroRoot) : null
  const drafts = new Map()
  let devServer
  let rendererPromise
  let rendererFailure

  function markdownRenderer() {
    if (rendererFailure) return Promise.reject(rendererFailure)
    if (!rendererPromise) {
      rendererPromise = (async () => {
        const processor = markdown?.processor
        if (typeof processor?.createRenderer !== 'function') {
          throw Object.assign(new Error('The configured Astro Markdown processor cannot render block previews.'), { code: 'UNSUPPORTED_MARKDOWN_PROCESSOR' })
        }
        return await processor.createRenderer({
          image,
          syntaxHighlight: markdown.syntaxHighlight,
          shikiConfig: markdown.shikiConfig,
          gfm: markdown.gfm,
          smartypants: markdown.smartypants,
        })
      })().catch((error) => {
        rendererFailure = error
        throw error
      })
    }
    return rendererPromise
  }

  function dropDraft(targetId) {
    const draft = drafts.get(targetId)
    if (!draft) return null
    if (draft.expiryTimer) clearTimeout(draft.expiryTimer)
    draft.expiryTimer = null
    drafts.delete(targetId)
    return draft
  }

  return {
    name: 'astro-visual-cms-mdx-block-preview',
    enforce: 'pre',
    configureServer(server) {
      devServer = server
      // A draft that makes the real route fail must not linger until its grace
      // expires: the broken page cannot host the bridge that would reset it, so
      // the editor would be unable to recover. Treat any 5xx response for the
      // target's preview route as a failed render, drop the in-memory draft, and
      // reload the route with the saved source. Source bytes are never touched.
      server.middlewares.use((request, response, next) => {
        let pathname
        try { pathname = new URL(request.url || '', 'http://127.0.0.1').pathname } catch { return next() }
        const target = configured.find((item) => item.previewPath === pathname || item.requestPath === pathname)
        if (!target || !drafts.has(target.id)) return next()
        response.on('finish', () => {
          if (response.statusCode < 500 || !drafts.has(target.id)) return
          dropDraft(target.id)
          invalidate(target).catch(() => {})
          try {
            devServer.ws?.send?.({ type: 'full-reload' })
          } catch {
            // A closed dev server cannot be reloaded; the overlay is already gone.
          }
        })
        next()
      })
      server.middlewares.use('/__avcms/mdx-block-preview', async (request, response, next) => {
        if (request.method !== 'POST') return next()
        let expectedOrigin
        try {
          expectedOrigin = typeof siteOrigin === 'function' ? siteOrigin(devServer) : siteOrigin
          const parsedOrigin = new URL(expectedOrigin)
          if (parsedOrigin.origin !== expectedOrigin || parsedOrigin.username || parsedOrigin.password) expectedOrigin = null
        } catch { expectedOrigin = null }
        if (!expectedOrigin || request.headers.host !== new URL(expectedOrigin).host || request.headers.origin !== expectedOrigin ||
            !equalToken(request.headers['x-avcms-token'], token) || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          return sendJson(response, 403, { code: 'FORBIDDEN', error: 'Preview request is not authorized.' })
        }
        let referer
        try { referer = new URL(request.headers.referer || '') } catch {}
        if (!referer || referer.origin !== expectedOrigin) return sendJson(response, 403, { code: 'FORBIDDEN', error: 'Preview request is not same-origin.' })
        try {
          const payload = await readJson(request)
          const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? Object.keys(payload).sort().join(',')
            : ''
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
              !['hash,operations,requestId,targetId', 'rendered,requestId,targetId', 'requestId,reset,targetId'].includes(keys) ||
              typeof payload.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.targetId) ||
              typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId)) {
            return sendJson(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid preview operation.' })
          }
          const target = configured.find((item) => item.id === payload.targetId)
          if (!target || referer.pathname !== target.previewPath) return sendJson(response, 404, { code: 'UNKNOWN_TARGET', error: 'Preview target is unavailable on this route.' })
          if (Object.hasOwn(payload, 'rendered')) {
            if (payload.rendered !== true) return sendJson(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid rendered-preview acknowledgement.' })
            const draft = drafts.get(target.id)
            if (!draft || draft.requestId !== payload.requestId) return sendJson(response, 409, { code: 'PREVIEW_RENDER_EXPIRED', error: 'The rendered preview is no longer active.' })
            // A reloaded page proves only that the route answered. It does not
            // prove Astro evaluated this source: Content Layer routes can render
            // stored HTML, and any other non-overlaid route would keep showing
            // the saved source while the editor claimed success. Require
            // evidence that the route actually requested/transformed the draft.
            if (draft.contentLayer) {
              dropDraft(target.id)
              await invalidate(target)
              return sendJson(response, 409, {
                code: 'CONTENT_LAYER_UNSUPPORTED',
                error: 'This route imports the source as an Astro Content Layer entry. Content Layer entries render from collection data and, in eager mode, cached HTML, so the in-memory block overlay cannot faithfully replace the saved content. The draft was discarded; source bytes are unchanged. Use a directly imported page or keep this collection entry read-only.',
              })
            }
            if (!draft.loads) {
              dropDraft(target.id)
              await invalidate(target)
              return sendJson(response, 409, {
                code: 'PREVIEW_NOT_OVERLAID',
                error: 'The preview route did not request this source module after the draft was armed, so the reloaded page still shows the saved source. The draft was discarded; source bytes are unchanged. Configure a route that imports this exact file instead of one that renders cached content.',
              })
            }
            draft.requestId = null
            armDraftExpiry(target, draft, overlayLifetimeMs)
            return sendJson(response, 200, { targetId: target.id, requestId: payload.requestId, rendered: true })
          }
          if (Object.hasOwn(payload, 'reset')) {
            if (payload.reset !== true) return sendJson(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid reset operation.' })
            const draft = dropDraft(target.id)
            if (draft) await invalidate(target)
            return sendJson(response, 200, { targetId: target.id, requestId: payload.requestId, reset: true, changed: Boolean(draft) })
          }
          if (!/^[a-f0-9]{64}$/.test(payload.hash)) return sendJson(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid source revision.' })
          const { source } = readTarget(target)
          if (hashSource(source) !== payload.hash) return sendJson(response, 409, { code: 'STALE_HASH', error: 'Source changed since the editor preview.' })
          const result = applyOperations(target, source, payload.operations, payload.hash)
          let moduleCode = null
          if (target.format === 'md') {
            // A `.md` draft is rendered by Astro's Markdown pipeline and a
            // generated Astro component; the draft source never goes through
            // MDX, so plain Markdown keeps its normal semantics.
            const renderer = await markdownRenderer()
            moduleCode = await buildMarkdownPreviewModule({
              source: result.source,
              adapter: target.adapter,
              filePath: target.filePath,
              url: target.previewPath,
              renderMarkdown: (content, options) => renderer.render(content, options),
            })
          } else {
            await compile(result.source)
          }
          dropDraft(target.id)
          const draft = { file: target.filePath, baseHash: payload.hash, source: result.source, module: moduleCode, nextHash: result.nextHash, requestId: payload.requestId, expiryTimer: null, loads: 0, contentLayer: false }
          drafts.set(target.id, draft)
          armDraftExpiry(target, draft, renderTimeoutMs)
          await invalidate(target)
          return sendJson(response, 200, { targetId: target.id, requestId: payload.requestId, hash: result.nextHash, blockCount: result.blocks.length })
        } catch (error) {
          const status = error.status === 413 ? 413 : error.code === 'STALE_HASH' ? 409 : error.code === 'UNSUPPORTED_SYNTAX' ? 422 : 422
          return sendJson(response, status, { code: error.code || 'PREVIEW_FAILED', error: error.message || 'MDX draft could not be rendered safely.' })
        }
      })

      async function invalidate(target) {
        if (!target) return
        const files = [target.filePath, target.draftPath].filter(Boolean)
        for (const file of files) {
          try {
            const modules = devServer.moduleGraph.getModulesByFile(file)
            if (modules) for (const module of modules) devServer.moduleGraph.invalidateModule(module)
          } catch {
            // A module that was never requested is not in the graph.
          }
        }
        const devCssId = devCssModuleId(cssRoot ?? target.projectRoot, target.filePath)
        if (devCssId) {
          for (const environment of Object.values(devServer.environments ?? {})) {
            try {
              const module = environment.moduleGraph?.getModuleById?.(devCssId)
              if (module) environment.moduleGraph.invalidateModule(module)
            } catch {
              // An environment without a module graph cannot hold the collector.
            }
          }
          try {
            const module = devServer.moduleGraph.getModuleById?.(devCssId)
            if (module) devServer.moduleGraph.invalidateModule(module)
          } catch {
            // The collector was not requested for this route yet.
          }
        }
      }

      function armDraftExpiry(target, draft, timeoutMs) {
        if (draft.expiryTimer) clearTimeout(draft.expiryTimer)
        draft.expiryTimer = setTimeout(() => {
          if (drafts.get(target.id) !== draft) return
          dropDraft(target.id)
          invalidate(target).catch(() => {})
          try {
            devServer.ws?.send?.({ type: 'full-reload' })
          } catch {
            // A closed dev server cannot be reloaded; the overlay is already gone.
          }
        }, timeoutMs)
        draft.expiryTimer.unref?.()
      }
    },
    resolveId: {
      order: 'pre',
      handler(source, importer) {
        if (!importer) return null
        const [importerFile] = splitQuery(importer)
        for (const target of configured) {
          if (!target.draftPath || !drafts.has(target.id) || path.resolve(importerFile) !== target.filePath) continue
          const [sourceFile, query] = splitQuery(source)
          const relativeSpecifier = `./${path.basename(target.draftPath)}`
          const absoluteSpecifier = path.resolve(path.dirname(target.filePath), sourceFile)
          if (sourceFile === relativeSpecifier || absoluteSpecifier === target.draftPath) {
            return { id: `${target.draftPath}${query}` }
          }
        }
        return null
      },
    },
    load: {
      order: 'pre',
      handler(id) {
        const [file] = splitQuery(id)
        for (const target of configured) {
          if (!target.draftPath || path.resolve(file) !== target.draftPath) continue
          const draft = drafts.get(target.id)
          if (!draft) throw Object.assign(new Error('The virtual Markdown preview is no longer active.'), { code: 'PREVIEW_EXPIRED' })
          const { source } = readTarget(target)
          if (hashSource(source) !== draft.baseHash) {
            dropDraft(target.id)
            throw Object.assign(new Error('The Markdown source changed; the virtual preview was discarded.'), { code: 'STALE_HASH' })
          }
          draft.loads += 1
          return draft.module
        }
        return null
      },
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        const [rawFile, query] = splitQuery(id)
        const file = path.resolve(rawFile)
        for (const target of configured) {
          const draft = drafts.get(target.id)
          if (!draft || draft.file !== file) continue
          // Content Layer imports its entries under a dedicated query and, in
          // its default eager mode, renders the stored HTML instead of this
          // module. Refuse the overlay in that case instead of letting the
          // editor confirm a preview that never changed.
          if (/(?:[?&])astroMarkdownContentEntry(?:[=&]|$)/.test(query)) {
            draft.contentLayer = true
            return null
          }
          if (target.draftPath) {
            // Replace Astro's compiled Markdown module with the generated Astro
            // component. The real .md file is never renamed, replaced, or
            // written, and its body is never compiled as MDX.
            let source
            try {
              source = readTarget(target).source
            } catch {
              dropDraft(target.id)
              return null
            }
            if (hashSource(source) !== draft.baseHash) {
              dropDraft(target.id)
              return null
            }
            draft.loads += 1
            return { code: `export { default } from ${JSON.stringify(`./${path.basename(target.draftPath)}`)};`, map: null }
          }
          if (hashSource(code) !== draft.baseHash) {
            dropDraft(target.id)
            return null
          }
          draft.loads += 1
          return { code: draft.source, map: null }
        }
        return null
      },
    },
  }
}
