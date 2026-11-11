import { timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@mdx-js/mdx'
import { hashSource } from '../lib/gallery-patch.mjs'
import { createMdxBlocksAdapter } from '../lib/mdx-blocks.mjs'

const MAX_PREVIEW_BODY_BYTES = 12 * 1024
const MAX_SOURCE_BYTES = 1024 * 1024
const PREVIEW_RENDER_TIMEOUT_MS = 6_000

function equalToken(actual, expected) {
  const left = Buffer.from(typeof actual === 'string' ? actual : '', 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function activeFile(target) {
  if (existsSync(target.filePath)) return target.filePath
  if (path.extname(target.filePath) === '.md' && existsSync(`${target.filePath}x`)) return `${target.filePath}x`
  return target.filePath
}

function readTarget(target) {
  const file = activeFile(target)
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
export function createMdxBlockPreviewPlugin({ targets = [], token, siteOrigin }) {
  if (typeof token !== 'string' || token.length < 32 || !(typeof siteOrigin === 'string' || typeof siteOrigin === 'function')) throw new TypeError('Invalid MDX block preview bridge configuration.')
  const configured = targets.map((target) => {
    const projectRoot = path.resolve(target.projectRoot)
    const filePath = path.resolve(target.filePath)
    if (!filePath.startsWith(`${projectRoot}${path.sep}`) || realpathSync(projectRoot) !== projectRoot || !lstatSync(projectRoot).isDirectory()) {
      throw new TypeError('MDX block preview target must be in a canonical project root.')
    }
    return { ...target, projectRoot, filePath, adapter: createMdxBlocksAdapter({ blockTypes: target.blockTypes }) }
  })
  if (new Set(configured.map((target) => target.id)).size !== configured.length) throw new TypeError('MDX block preview target IDs must be unique.')
  const drafts = new Map()
  let devServer

  return {
    name: 'astro-visual-cms-mdx-block-preview',
    enforce: 'pre',
    configureServer(server) {
      devServer = server
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
            clearTimeout(draft.renderTimeout)
            draft.renderTimeout = null
            draft.requestId = null
            return sendJson(response, 200, { targetId: target.id, requestId: payload.requestId, rendered: true })
          }
          if (Object.hasOwn(payload, 'reset')) {
            if (payload.reset !== true) return sendJson(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid reset operation.' })
            const draft = drafts.get(target.id)
            drafts.delete(target.id)
            if (draft?.renderTimeout) clearTimeout(draft.renderTimeout)
            await invalidate(draft?.file || activeFile(target))
            return sendJson(response, 200, { targetId: target.id, requestId: payload.requestId, reset: true })
          }
          if (!/^[a-f0-9]{64}$/.test(payload.hash)) return sendJson(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid source revision.' })
          const { file, source } = readTarget(target)
          if (hashSource(source) !== payload.hash) return sendJson(response, 409, { code: 'STALE_HASH', error: 'Source changed since the editor preview.' })
          const result = applyOperations(target, source, payload.operations, payload.hash)
          await compile(result.source)
          const previousDraft = drafts.get(target.id)
          if (previousDraft?.renderTimeout) clearTimeout(previousDraft.renderTimeout)
          const draft = { file, baseHash: payload.hash, source: result.source, nextHash: result.nextHash, requestId: payload.requestId, renderTimeout: null }
          draft.renderTimeout = setTimeout(async () => {
            if (drafts.get(target.id) !== draft) return
            drafts.delete(target.id)
            await invalidate(file)
            devServer.ws?.send?.({ type: 'full-reload' })
          }, PREVIEW_RENDER_TIMEOUT_MS)
          draft.renderTimeout.unref?.()
          drafts.set(target.id, draft)
          await invalidate(file)
          return sendJson(response, 200, { targetId: target.id, requestId: payload.requestId, hash: result.nextHash, blockCount: result.blocks.length })
        } catch (error) {
          const status = error.status === 413 ? 413 : error.code === 'STALE_HASH' ? 409 : error.code === 'UNSUPPORTED_SYNTAX' ? 422 : 422
          return sendJson(response, status, { code: error.code || 'PREVIEW_FAILED', error: error.message || 'MDX draft could not be rendered safely.' })
        }
      })

      async function invalidate(file) {
        if (!file) return
        const modules = devServer.moduleGraph.getModulesByFile(file)
        if (modules) for (const module of modules) devServer.moduleGraph.invalidateModule(module)
      }
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        const file = path.resolve(id.split('?')[0])
        for (const target of configured) {
          const draft = drafts.get(target.id)
          if (!draft || path.resolve(activeFile(target)) !== file || draft.file !== file) continue
          if (hashSource(code) !== draft.baseHash) {
            drafts.delete(target.id)
            return null
          }
          return { code: draft.source, map: null }
        }
        return null
      },
    },
  }
}
