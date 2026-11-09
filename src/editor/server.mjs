import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createGalleryPatchAdapter, hashSource } from '../lib/gallery-patch.mjs'
import { FIXTURE_IMAGE_SLUGS } from '../lib/demo-image-manifest.mjs'
import { normalizeAstroBasePath } from './base-path.mjs'
import { patchFrontmatterField } from './collection-discovery.mjs'
import { createCollectionRuntime, publicCollectionState } from './collection-runtime.mjs'
import { createSourceExclusively, writeSourceAtomically } from './source-write.mjs'
import { createMdxPropsAdapter } from '../lib/mdx-props-patch.mjs'
import { createMarkdownParagraphAdapter } from '../lib/markdown-paragraph-map.mjs'
import { lstatSync, realpathSync } from 'node:fs'

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'src/pages/fixture.mdx')
const FIXTURE_ADAPTER = createGalleryPatchAdapter({ galleryImportSource: '../components/Gallery.astro' })
const UI_PATH = fileURLToPath(new URL('./index.html', import.meta.url))
const MAX_BODY_BYTES = 8 * 1024
const PREVIEW_SYNC_TIMEOUT_MS = 4_000
const PREVIEW_POLL_INTERVAL_MS = 100
const PREVIEW_TTL_MS = 5 * 60_000
const EDITOR_SESSION_TTL_MS = 8 * 60 * 60_000
const MAX_PENDING_PREVIEWS = 32
const MAX_MDX_COMPONENT_TARGETS = 16
const MAX_MDX_SOURCE_BYTES = 1024 * 1024
const MAX_MDX_COMPONENT_INSTANCES = 500
const DEFAULT_PREVIEW_ROUTES = [
  { id: 'home', label: 'Startseite', path: '/', cacheBustOnRevision: false },
  { id: 'fixture', label: 'Fixture', path: '/fixture/', cacheBustOnRevision: true },
]

function validatePreviewRoutes(routes) {
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > 32) throw new TypeError('previewRoutes must contain 1–32 trusted routes.')
  const ids = new Set()
  return routes.map((route, index) => {
    const keys = ['id', 'label', 'path', 'cacheBustOnRevision']
    if (!route || typeof route !== 'object' || Array.isArray(route) || Object.keys(route).some((key) => !keys.includes(key)) ||
        !['id', 'label', 'path'].every((key) => Object.hasOwn(route, key)) ||
        Object.keys(route).length !== 3 + Number(Object.hasOwn(route, 'cacheBustOnRevision'))) throw new TypeError(`Invalid trusted preview route at index ${index}.`)
    if (typeof route.id !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(route.id) || ids.has(route.id)) throw new TypeError(`Invalid or duplicate preview route id at index ${index}.`)
    if (typeof route.label !== 'string' || !route.label.trim() || route.label.length > 128 || /[\u0000-\u001f\u007f]/.test(route.label)) throw new TypeError(`Invalid preview route label at index ${index}.`)
    let segments
    try { segments = typeof route.path === 'string' ? route.path.split('/').map((part) => decodeURIComponent(part)) : [] } catch {
      throw new TypeError(`Invalid same-origin preview pathname at index ${index}.`)
    }
    if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.startsWith('//') || /[?#\\\u0000-\u001f\u007f]/.test(route.path) || /%25/i.test(route.path) || segments.some((part) => part === '.' || part === '..' || /[\\/\u0000-\u001f\u007f]/.test(part))) throw new TypeError(`Invalid same-origin preview pathname at index ${index}.`)
    if (route.cacheBustOnRevision !== undefined && typeof route.cacheBustOnRevision !== 'boolean') throw new TypeError(`Invalid preview cache-bust setting at index ${index}.`)
    ids.add(route.id)
    return { id: route.id, label: route.label, path: route.path, cacheBustOnRevision: route.cacheBustOnRevision === true }
  })
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

export function validateDemoImageSlugs(galleries) {
  for (const gallery of galleries) {
    for (const slug of gallery.order) {
      if (FIXTURE_IMAGE_SLUGS.includes(slug)) continue
      const error = new Error(`The local demo image manifest does not contain slug ${JSON.stringify(slug)} (${gallery.id}).`)
      error.code = 'UNSUPPORTED_IMAGE_SLUG'
      throw error
    }
  }
  return galleries
}

function inspectDemoFixture(source) {
  const state = FIXTURE_ADAPTER.inspect(source)
  validateDemoImageSlugs(state.galleries)
  return state
}

export function isLoopbackAddress(address = '') {
  if (address === '127.0.0.1' || address === '::1') return true
  const mappedIpv4 = address.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i)
  return Boolean(mappedIpv4 && Number(mappedIpv4[1]) === 127 && mappedIpv4.slice(1).every((octet) => Number(octet) <= 255))
}

function hasEditorToken(candidate, token) {
  const expected = Buffer.from(token, 'utf8')
  const supplied = Buffer.from(typeof candidate === 'string' ? candidate : '', 'utf8')
  const comparable = Buffer.alloc(expected.length)
  supplied.copy(comparable, 0, 0, expected.length)
  return timingSafeEqual(expected, comparable) && supplied.length === expected.length
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error('Request body too large.')
      error.statusCode = 413
      throw error
    }
  }
  try {
    return JSON.parse(body)
  } catch {
    const error = new Error('Expected a JSON request body.')
    error.statusCode = 400
    throw error
  }
}

async function waitForRenderedOrder({ hash, siteOrigin, fixturePath, basePath }) {
  const deadline = Date.now() + PREVIEW_SYNC_TIMEOUT_MS

  while (Date.now() < deadline) {
    const source = readFileSync(fixturePath, 'utf8')
    const state = inspectDemoFixture(source)
    if (state.hash !== hash) {
      return { statusCode: 409, payload: { code: 'STALE_HASH', error: 'Fixture changed while waiting for Astro preview.' } }
    }
    const galleries = state.galleries

    try {
      const remaining = Math.max(1, deadline - Date.now())
      const response = await fetch(`${siteOrigin}${basePath}fixture/?preview=${hash}`, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(Math.min(500, remaining)),
      })
      if (response.ok) {
        const html = await response.text()
        const renderedOrders = [...html.matchAll(/<section\b([^>]*)>/g)].flatMap((match) => {
          const order = match[1].match(/\bdata-gallery-order="([^"]*)"/)?.[1]
          return order === undefined ? [] : [order]
        })
        const expectedOrders = galleries.map((gallery) => gallery.order.join(','))
        const allGalleriesReady = renderedOrders.length === expectedOrders.length &&
          renderedOrders.every((order, index) => order === expectedOrders[index])
        if (allGalleriesReady) {
          return {
            statusCode: 200,
            payload: { hash, galleries, previewUrl: `${siteOrigin}${basePath}fixture/?revision=${hash}` },
          }
        }
      }
    } catch {
      // Dev-server start/reload can briefly fail; keep retrying within the fixed deadline.
    }

    const delay = Math.min(PREVIEW_POLL_INTERVAL_MS, deadline - Date.now())
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }

  return {
    statusCode: 504,
    payload: { code: 'PREVIEW_SYNC_TIMEOUT', error: 'Astro preview did not render the saved order before the timeout.' },
  }
}

function validOperation(payload, expectedKeys) {
  const allowedKeys = new Set(expectedKeys)
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === allowedKeys.size &&
    Object.keys(payload).every((key) => allowedKeys.has(key)) &&
    typeof payload.galleryId === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(payload.galleryId) &&
    Array.isArray(payload.order) && payload.order.length > 0 && payload.order.length <= 100 &&
    payload.order.every((slug) => typeof slug === 'string' && slug.length > 0 && slug.length <= 128) &&
    typeof payload.hash === 'string' && /^[a-f0-9]{64}$/.test(payload.hash)
}

function sameOperation(left, right) {
  return left.galleryId === right.galleryId && left.hash === right.hash &&
    JSON.stringify(left.order) === JSON.stringify(right.order)
}

function validCollectionEntryId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) &&
    !value.startsWith('/') && !value.startsWith('\\') && !value.includes('\\') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
}

function validCollectionOperation(payload, includePreviewId = false) {
  const keys = includePreviewId
    ? ['previewId', 'collectionId', 'entryId', 'field', 'value', 'hash']
    : ['collectionId', 'entryId', 'field', 'value', 'hash']
  const allowedKeys = new Set(keys)
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === allowedKeys.size && Object.keys(payload).every((key) => allowedKeys.has(key)) &&
    typeof payload.collectionId === 'string' && /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(payload.collectionId) &&
    validCollectionEntryId(payload.entryId) && typeof payload.field === 'string' &&
    /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(payload.field) &&
    (typeof payload.value === 'string' || typeof payload.value === 'number' && Number.isFinite(payload.value) || typeof payload.value === 'boolean') &&
    typeof payload.hash === 'string' && /^[a-f0-9]{64}$/.test(payload.hash) &&
    (!includePreviewId || typeof payload.previewId === 'string' && /^[a-f0-9]{64}$/.test(payload.previewId))
}

function sameCollectionOperation(left, right) {
  return left.collectionId === right.collectionId && left.entryId === right.entryId &&
    left.field === right.field && left.hash === right.hash && left.value === right.value
}

function validEntryCreationOperation(payload, includePreviewId = false) {
  const keys = includePreviewId
    ? ['previewId', 'collectionId', 'entryId', 'values', 'hash']
    : ['collectionId', 'entryId', 'values', 'hash']
  const allowed = new Set(keys)
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === keys.length && Object.keys(payload).every((key) => allowed.has(key)) &&
    (!includePreviewId || typeof payload.previewId === 'string' && /^[a-f0-9]{64}$/.test(payload.previewId)) &&
    typeof payload.collectionId === 'string' && /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(payload.collectionId) &&
    typeof payload.entryId === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})?\.(?:md|mdx)$/.test(payload.entryId) && payload.entryId.length <= 68 &&
    payload.values !== null && typeof payload.values === 'object' && !Array.isArray(payload.values) && Object.keys(payload.values).length <= 32 &&
    Object.entries(payload.values).every(([name, value]) => /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(name) &&
      (typeof value === 'string' && value.length <= 512 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) &&
    typeof payload.hash === 'string' && /^[a-f0-9]{64}$/.test(payload.hash)
}

function sameEntryCreationOperation(left, right) {
  if (left.collectionId !== right.collectionId || left.entryId !== right.entryId || left.hash !== right.hash) return false
  const leftKeys = Object.keys(left.values).sort()
  const rightKeys = Object.keys(right.values).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left.values[key] === right.values[key])
}

function previewId() {
  return randomBytes(32).toString('hex')
}

export function createEditorServer({
  port = Number(process.env.EDITOR_PORT || 4322),
  sitePort = Number(process.env.ASTRO_PORT || 4321),
  fixturePath = FIXTURE_PATH,
  basePath = normalizeAstroBasePath(process.env.ASTRO_BASE_PATH || '/'),
  writeSource = writeSourceAtomically,
  createSource = createSourceExclusively,
  projectRoot,
  contentConfigPath,
  mdxComponentTargets,
  mdxParagraphTargets,
  previewRoutes = DEFAULT_PREVIEW_ROUTES,
} = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The fixture write API is development-only and cannot run with NODE_ENV=production.')
  }
  const siteOrigin = `http://127.0.0.1:${sitePort}`
  const safeBasePath = normalizeAstroBasePath(basePath)
  const trustedPreviewRoutes = validatePreviewRoutes(previewRoutes)
  const embeddedPreviewRoutes = JSON.stringify(trustedPreviewRoutes).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  const editorSessions = new Map()
  const editorOrigin = () => `http://127.0.0.1:${server.address()?.port ?? port}`
  const pendingPreviews = new Map()
  const pendingConfigPreviews = new Map()
  if ((projectRoot === undefined) !== (contentConfigPath === undefined)) {
    throw new TypeError('Collection discovery requires both trusted projectRoot and contentConfigPath options.')
  }
  const collectionRuntime = projectRoot === undefined
    ? null
    : createCollectionRuntime({ projectRoot, contentConfigPath })

  const componentTargets = mdxComponentTargets === undefined ? [] : (() => {
    if (!Array.isArray(mdxComponentTargets) || mdxComponentTargets.length > MAX_MDX_COMPONENT_TARGETS) {
      throw new TypeError(`mdxComponentTargets must contain at most ${MAX_MDX_COMPONENT_TARGETS} trusted targets.`)
    }
    const targets = mdxComponentTargets.map((target, index) => {
      const keys = ['id', 'projectRoot', 'filePath', 'importSource', 'idProp', 'editableProps', 'fields']
      if (!target || typeof target !== 'object' || Object.keys(target).some((key) => !keys.includes(key)) ||
          ['id', 'projectRoot', 'filePath', 'importSource'].some((key) => !Object.hasOwn(target, key)) ||
          (Object.hasOwn(target, 'editableProps') === Object.hasOwn(target, 'fields'))) throw new TypeError(`Invalid MDX target configuration at index ${index}.`)
      if (typeof target.id !== 'string' || !/^[A-Za-z_$][\w$-]{0,63}$/.test(target.id) ||
          typeof target.projectRoot !== 'string' || !path.isAbsolute(target.projectRoot) ||
          typeof target.filePath !== 'string' || !path.isAbsolute(target.filePath)) throw new TypeError(`Invalid MDX target paths or id at index ${index}.`)
      const root = path.resolve(target.projectRoot), file = path.resolve(target.filePath)
      const realRoot = realpathSync(root)
      if (realRoot !== root || !lstatSync(root).isDirectory() || !file.startsWith(`${root}${path.sep}`)) throw new TypeError('MDX target must be inside a canonical project root.')
      const adapter = createMdxPropsAdapter(target)
      assertMdxTargetSafe(root, file)
      return { id: target.id, root, file, adapter }
    })
    if (new Set(targets.map((target) => target.id)).size !== targets.length) throw new TypeError('MDX target ids must be unique.')
    return targets
  })()
  const paragraphTargets = mdxParagraphTargets === undefined ? [] : (() => {
    if (!Array.isArray(mdxParagraphTargets) || mdxParagraphTargets.length > MAX_MDX_COMPONENT_TARGETS) {
      throw new TypeError(`mdxParagraphTargets must contain at most ${MAX_MDX_COMPONENT_TARGETS} trusted targets.`)
    }
    return mdxParagraphTargets.map((target, index) => {
      const keys = ['id', 'projectRoot', 'filePath', 'instanceId']
      if (!target || typeof target !== 'object' || Object.keys(target).some((key) => !keys.includes(key)) ||
          keys.some((key) => !Object.hasOwn(target, key)) ||
          typeof target.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(target.id) ||
          typeof target.projectRoot !== 'string' || !path.isAbsolute(target.projectRoot) ||
          typeof target.filePath !== 'string' || !path.isAbsolute(target.filePath) ||
          typeof target.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target.instanceId)) {
        throw new TypeError(`Invalid trusted Markdown paragraph target at index ${index}.`)
      }
      const root = path.resolve(target.projectRoot), file = path.resolve(target.filePath)
      if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || !file.startsWith(`${root}${path.sep}`)) {
        throw new TypeError('Markdown paragraph target must be inside a canonical project root.')
      }
      const adapter = createMarkdownParagraphAdapter({ instanceId: target.instanceId })
      assertMdxTargetSafe(root, file)
      return { id: target.id, root, file, adapter, kind: 'markdown-paragraph' }
    })
  })()
  const mdxTargets = [...componentTargets, ...paragraphTargets]
  if (new Set(mdxTargets.map((target) => target.id)).size !== mdxTargets.length) throw new TypeError('MDX target ids must be unique.')
  const pendingMdxPreviews = new Map()

  function assertMdxTargetSafe(root, file) {
    const relative = path.relative(root, file)
    let current = root
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) { const error = new Error('Symbolic links in configured MDX paths are not editable.'); error.code = 'UNSAFE_MDX_PATH'; throw error }
    }
    const stat = lstatSync(file)
    if (!stat.isFile() || realpathSync(file) !== file) { const error = new Error('Configured MDX target is not a regular in-root file.'); error.code = 'UNSAFE_MDX_PATH'; throw error }
    if (stat.size > MAX_MDX_SOURCE_BYTES) { const error = new Error('Configured MDX target exceeds the safe source size limit.'); error.code = 'MDX_SOURCE_LIMIT'; throw error }
  }

  function readMdxTargetSource(target) {
    assertMdxTargetSafe(target.root, target.file)
    const bytes = readFileSync(target.file)
    if (bytes.length > MAX_MDX_SOURCE_BYTES) {
      const error = new Error('Configured MDX target exceeds the safe source size limit.')
      error.code = 'MDX_SOURCE_LIMIT'
      throw error
    }
    const source = bytes.toString('utf8')
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      const error = new Error('Configured MDX target is not valid UTF-8 source.')
      error.code = 'UNSUPPORTED_ENCODING'
      throw error
    }
    return source
  }

  function safeMdxFailure(error) {
    const code = typeof error?.code === 'string' && /^(STALE_HASH|UNSUPPORTED_[A-Z_]+|INVALID_[A-Z_]+|UNSAFE_MDX_PATH|MDX_(SOURCE|INSTANCE)_LIMIT)$/.test(error.code)
      ? error.code
      : 'MDX_EDIT_FAILED'
    const message = code === 'UNSAFE_MDX_PATH'
      ? 'Configured MDX target is not available as a safe in-root file.'
      : code === 'MDX_SOURCE_LIMIT'
        ? 'Configured MDX target exceeds the safe source size limit.'
        : code === 'MDX_INSTANCE_LIMIT'
          ? 'Configured MDX target exceeds the safe component instance limit.'
          : code === 'STALE_HASH'
            ? 'The MDX source changed; reload and prepare the edit again.'
            : code === 'MDX_EDIT_FAILED'
              ? 'MDX edit could not be completed safely.'
              : error.message
    return { code, error: message }
  }

  function prepareCollectionPatch(operation) {
    const target = collectionRuntime.getEntryForEdit(operation.collectionId, operation.entryId, operation.field)
    if (target.entry.hash !== operation.hash) {
      const error = new Error('The entry changed since it was loaded; reload before preparing a preview.')
      error.code = 'STALE_HASH'
      throw error
    }
    const result = patchFrontmatterField(target.source, target.field, operation.value, operation.hash)
    const latest = collectionRuntime.inspect()
    const latestCollection = latest.collections.find((item) => item.id === operation.collectionId)
    const latestField = latestCollection?.fields.find((item) => item.name === operation.field)
    if (!latest.supported || latest._configHash !== target.configHash || latestCollection?.mode !== 'editable' || !latestField?.editable) {
      const error = new Error('The content schema changed or is no longer supported; reload before editing.')
      error.code = 'STALE_CONFIG'
      throw error
    }
    return { target, result }
  }

  async function writeCollectionConfigSource(expectedHash, source) {
    try {
      await writeSource(collectionRuntime.configPath, expectedHash, source)
    } catch (error) {
      if (error.code !== 'STALE_HASH') throw error
      const conflict = new Error('Content config changed during the write; reload and prepare the edit again.')
      conflict.code = 'STALE_CONFIG'
      throw conflict
    }
  }

  function prunePreviews() {
    const now = Date.now()
    for (const pendingMap of [pendingPreviews, pendingMdxPreviews, pendingConfigPreviews]) {
      for (const [id, pending] of pendingMap) {
        if (pending.expiresAt <= now) pendingMap.delete(id)
      }
      while (pendingMap.size >= MAX_PENDING_PREVIEWS) {
        pendingMap.delete(pendingMap.keys().next().value)
      }
    }
  }

  function validEditorPost(request) {
    const token = typeof request.headers['x-editor-token'] === 'string' ? request.headers['x-editor-token'] : ''
    let activeSession = false
    const now = Date.now()
    for (const [sessionToken, expiresAt] of editorSessions) {
      if (expiresAt <= now) editorSessions.delete(sessionToken)
      else if (hasEditorToken(token, sessionToken)) activeSession = true
    }
    return request.headers.host === `127.0.0.1:${server.address()?.port ?? port}` &&
      request.headers.origin === editorOrigin() && request.headers['content-type'] === 'application/json' && activeSession
  }

  const server = createServer(async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return json(response, 403, { error: 'Loopback clients only.' })
    }
    if (request.headers.host !== `127.0.0.1:${server.address()?.port ?? port}`) {
      return json(response, 403, { error: 'Only the configured loopback Host is allowed.' })
    }

    if (request.method === 'GET' && request.url === '/api/health') {
      const origin = request.headers.origin
      if (origin !== siteOrigin) return json(response, 403, { error: 'Only the configured local preview origin is allowed.' })
      response.writeHead(204, {
        'access-control-allow-origin': siteOrigin,
        vary: 'Origin',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      return response.end()
    }

    let editorRequestUrl
    try { editorRequestUrl = new URL(request.url, editorOrigin()) } catch {}
    const routeQueryKeys = editorRequestUrl ? [...editorRequestUrl.searchParams.keys()] : []
    const rootRequest = editorRequestUrl?.pathname === '/' && routeQueryKeys.every((key) => key === 'route') && editorRequestUrl.searchParams.getAll('route').length <= 1
    if (request.method === 'GET' && rootRequest) {
      const nonce = randomBytes(18).toString('base64url')
      const requestedRouteId = editorRequestUrl.searchParams.get('route')
      const initialRouteId = trustedPreviewRoutes.find((route) => route.id === requestedRouteId)?.id || null
      const html = readFileSync(UI_PATH, 'utf8')
        .replaceAll('__SITE_ORIGIN__', siteOrigin)
        .replaceAll('__SITE_BASE_PATH__', safeBasePath)
        .replaceAll('__PREVIEW_ROUTES__', embeddedPreviewRoutes)
        .replaceAll('__INITIAL_PREVIEW_ROUTE_ID__', JSON.stringify(initialRouteId))
        .replaceAll('__CSP_NONCE__', nonce)
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src ${siteOrigin}`,
          `img-src ${siteOrigin} data:`,
          `font-src ${siteOrigin} data:`,
          `frame-src ${siteOrigin}`,
          "connect-src 'self'",
          "base-uri 'none'",
          "object-src 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
        'cross-origin-resource-policy': 'same-origin',
      })
      return response.end(html)
    }

    if (request.method === 'GET' && request.url === '/api/session') {
      const now = Date.now()
      for (const [token, expiresAt] of editorSessions) if (expiresAt <= now) editorSessions.delete(token)
      while (editorSessions.size >= 64) editorSessions.delete(editorSessions.keys().next().value)
      const token = randomBytes(32).toString('hex')
      editorSessions.set(token, now + EDITOR_SESSION_TTL_MS)
      return json(response, 200, { token })
    }

    if (request.method === 'GET' && request.url === '/api/state') {
      try {
        const source = readFileSync(fixturePath, 'utf8')
        return json(response, 200, inspectDemoFixture(source))
      } catch (error) {
        return json(response, 422, { error: error.message, code: error.code || 'UNSUPPORTED_FIXTURE' })
      }
    }

    if (request.method === 'GET' && request.url === '/api/collections') {
      if (request.headers.origin && request.headers.origin !== editorOrigin()) {
        return json(response, 403, { error: 'Only the editor origin is allowed.' })
      }
      if (!collectionRuntime) return json(response, 200, { configured: false })
      return json(response, 200, publicCollectionState(collectionRuntime.inspect()))
    }

    if (request.method === 'POST' && (request.url === '/api/collections/config/preview' || request.url === '/api/collections/config/commit' || request.url === '/api/collections/config/cancel' || request.url === '/api/collections/config/create/preview' || request.url === '/api/collections/config/create/commit' || request.url === '/api/collections/config/create/cancel')) {
      if (!validEditorPost(request)) return json(response, 403, { error: 'Request origin or content type is not allowed.' })
      if (!collectionRuntime) return json(response, 404, { error: 'Collection editing is not configured.' })
      try {
        const payload = await readJson(request)
        const createRoute = request.url.includes('/create/')
        const route = request.url.split('/').at(-1)
        const sessionToken = request.headers['x-editor-token']
        if (route === 'cancel') {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !/^[a-f0-9]{64}$/.test(payload.previewId || '')) return json(response, 422, { code: 'INVALID_REQUEST', error: 'A previewId is required.' })
          const pending = pendingConfigPreviews.get(payload.previewId)
          if (pending && pending.sessionToken !== sessionToken) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
          pendingConfigPreviews.delete(payload.previewId)
          return json(response, 200, { cancelled: true })
        }
        if (createRoute) {
          const createKeys = route === 'preview' ? ['name', 'base', 'pattern', 'fields', 'hash'] : ['previewId', 'name', 'base', 'pattern', 'fields', 'hash']
          const validField = (field) => field && typeof field === 'object' && !Array.isArray(field) &&
            Object.keys(field).every((key) => ['name', 'type', 'required', 'values', 'default'].includes(key)) &&
            typeof field.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(field.name) && ['string', 'number', 'boolean', 'enum'].includes(field.type) &&
            (field.required === undefined || typeof field.required === 'boolean') &&
            (field.type !== 'enum' || Array.isArray(field.values) && field.values.length > 0 && field.values.length <= 32 && field.values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 128) && new Set(field.values).size === field.values.length) &&
            (field.type === 'enum' || field.values === undefined) &&
            (field.default === undefined || typeof field.default === 'string' && field.default.length <= 512 || typeof field.default === 'number' && Number.isFinite(field.default) || typeof field.default === 'boolean') &&
            Object.keys(field).length <= 5
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== createKeys.length || Object.keys(payload).some((key) => !createKeys.includes(key)) ||
              typeof payload.name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(payload.name) || typeof payload.base !== 'string' || payload.base.length > 256 ||
              typeof payload.pattern !== 'string' || !['*.md', '*.mdx', '**/*.md', '**/*.mdx'].includes(payload.pattern) || !Array.isArray(payload.fields) || payload.fields.length < 1 || payload.fields.length > 32 || !payload.fields.every(validField) ||
              new Set(payload.fields.map((field) => field.name)).size !== payload.fields.length || !/^[a-f0-9]{64}$/.test(payload.hash) || (route === 'commit' && !/^[a-f0-9]{64}$/.test(payload.previewId || ''))) return json(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid static collection creation operation.' })
          const operation = {
            name: payload.name,
            base: payload.base,
            pattern: payload.pattern,
            fields: payload.fields.map(({ required, ...field }) => ({ ...field, optional: required === false })),
            hash: payload.hash,
          }
          const prepare = () => collectionRuntime.planCreation(operation)
          if (route === 'preview') {
            const result = prepare(); prunePreviews(); const id = previewId()
            pendingConfigPreviews.set(id, { operation, diff: result.diff, hash: result.hash, sessionToken, expiresAt: Date.now() + PREVIEW_TTL_MS })
            return json(response, 200, { previewId: id, hash: operation.hash, nextHash: result.hash, diff: result.diff })
          }
          prunePreviews()
          const pending = pendingConfigPreviews.get(payload.previewId)
          if (!pending || pending.expiresAt <= Date.now()) return json(response, 409, { code: 'PREVIEW_EXPIRED', error: 'Preview expired.' })
          if (pending.sessionToken !== sessionToken) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
          pendingConfigPreviews.delete(payload.previewId)
          if (JSON.stringify(pending.operation) !== JSON.stringify(operation)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Commit differs from preview.' })
          const result = prepare()
          if (!result.diff || result.hash !== pending.hash || JSON.stringify(result.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Config no longer matches preview.' })
          const confirmed = prepare()
          if (confirmed.hash !== pending.hash || JSON.stringify(confirmed.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Config changed immediately before write.' })
          await writeCollectionConfigSource(operation.hash, result.source)
          return json(response, 200, { hash: result.hash })
        }
        const expected = route === 'preview' ? ['collection', 'field', 'hash'] : ['previewId', 'collection', 'field', 'hash']
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== expected.length || Object.keys(payload).some((key) => !expected.includes(key)) ||
            typeof payload.collection !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(payload.collection) ||
            !payload.field || typeof payload.field !== 'object' || Array.isArray(payload.field) || Object.keys(payload.field).some((key) => !['name', 'type', 'required', 'values'].includes(key)) ||
            typeof payload.field.name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(payload.field.name) || !['string', 'number', 'boolean', 'enum'].includes(payload.field.type) ||
            (payload.field.required !== undefined && typeof payload.field.required !== 'boolean') || (payload.field.type === 'enum' && (!Array.isArray(payload.field.values) || payload.field.values.length < 1 || payload.field.values.length > 32 || !payload.field.values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 128) || new Set(payload.field.values).size !== payload.field.values.length)) ||
            (payload.field.type !== 'enum' && payload.field.values !== undefined) || !/^[a-f0-9]{64}$/.test(payload.hash) || (route === 'commit' && !/^[a-f0-9]{64}$/.test(payload.previewId || ''))) return json(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid schema field extension operation.' })
        const operation = { collection: payload.collection, field: payload.field, hash: payload.hash }
        const normalizedOperation = {
          ...operation,
          field: { ...operation.field, optional: operation.field.required === false },
        }
        delete normalizedOperation.field.required
        const prepare = () => collectionRuntime.planFieldExtension(normalizedOperation)
        if (route === 'preview') {
          const result = prepare()
          prunePreviews()
          const id = previewId()
          pendingConfigPreviews.set(id, { operation, diff: result.diff, hash: result.hash, sessionToken, expiresAt: Date.now() + PREVIEW_TTL_MS })
          return json(response, 200, { previewId: id, hash: operation.hash, nextHash: result.hash, diff: result.diff })
        }
        prunePreviews()
        const pending = pendingConfigPreviews.get(payload.previewId)
        if (!pending || pending.expiresAt <= Date.now()) return json(response, 409, { code: 'PREVIEW_EXPIRED', error: 'Preview expired.' })
        if (pending.sessionToken !== sessionToken) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
        pendingConfigPreviews.delete(payload.previewId)
        if (JSON.stringify(pending.operation) !== JSON.stringify(operation)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Commit differs from preview.' })
        const result = prepare()
        if (!result.diff || result.hash !== pending.hash || JSON.stringify(result.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Config no longer matches preview.' })
        const confirmed = collectionRuntime.planFieldExtension(normalizedOperation)
        if (confirmed.hash !== pending.hash || JSON.stringify(confirmed.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Config changed immediately before write.' })
        await writeCollectionConfigSource(operation.hash, result.source)
        return json(response, 200, { hash: result.hash })
      } catch (error) {
        const code = ['STALE_CONFIG', 'UNSUPPORTED_CONFIG', 'UNSUPPORTED_COLLECTION_EDIT', 'UNSAFE_COLLECTION_PATH'].includes(error.code) ? error.code : 'CONFIG_EDIT_FAILED'
        const message = code === 'CONFIG_EDIT_FAILED'
          ? 'Schema config edit could not be completed safely.'
          : code === 'STALE_CONFIG'
            ? 'Content config changed during the write; reload and prepare the edit again.'
            : error.message
        const statusCode = code === 'STALE_CONFIG' ? 409 : code === 'CONFIG_EDIT_FAILED' ? 500 : 422
        return json(response, statusCode, { code, error: message })
      }
    }

    if (request.method === 'GET' && request.url === '/api/mdx-components') {
      if (request.headers.origin && request.headers.origin !== editorOrigin()) return json(response, 403, { error: 'Only the editor origin is allowed.' })
      const targets = []
      for (const target of mdxTargets) {
        try {
          const state = target.adapter.inspect(readMdxTargetSource(target))
          if (state.instances.length > MAX_MDX_COMPONENT_INSTANCES) {
            const error = new Error('Configured MDX target exceeds the safe component instance limit.')
            error.code = 'MDX_INSTANCE_LIMIT'
            throw error
          }
           targets.push({ id: target.id, kind: target.kind || 'component-prop', fields: state.fields, instances: state.instances, hash: state.hash, supported: true })
        } catch (error) {
          const failure = safeMdxFailure(error)
          targets.push({ id: target.id, kind: target.kind || 'component-prop', supported: false, error: failure.error })
        }
      }
      return json(response, 200, { configured: mdxTargets.length > 0, targets })
    }

    if (request.method === 'POST' && (request.url === '/api/mdx-components/preview' || request.url === '/api/mdx-components/commit')) {
      if (!validEditorPost(request)) return json(response, 403, { error: 'Request origin or content type is not allowed.' })
      if (!mdxTargets.length) return json(response, 404, { error: 'MDX component editing is not configured.' })
      try {
        const payload = await readJson(request)
        const previewing = request.url.endsWith('/preview')
        const expected = previewing ? ['targetId', 'instanceId', 'prop', 'value', 'hash'] : ['previewId', 'targetId', 'instanceId', 'prop', 'value', 'hash']
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== expected.length || Object.keys(payload).some((key) => !expected.includes(key)) ||
            typeof payload.targetId !== 'string' || payload.targetId.length > 64 ||
            typeof payload.instanceId !== 'string' || payload.instanceId.length > 512 ||
            typeof payload.prop !== 'string' || payload.prop.length > 64 ||
             !(typeof payload.value === 'string' && payload.value.length <= 512 || typeof payload.value === 'number' && Number.isFinite(payload.value) || typeof payload.value === 'boolean') ||
            !/^[a-f0-9]{64}$/.test(payload.hash) || (!previewing && !/^[a-f0-9]{64}$/.test(payload.previewId))) {
          return json(response, 422, { code: 'INVALID_REQUEST', error: 'Invalid MDX edit operation.' })
        }
        const target = mdxTargets.find((item) => item.id === payload.targetId)
        if (!target) return json(response, 422, { code: 'INVALID_REQUEST', error: 'Unknown configured target.' })
        const prepare = () => {
          const source = readMdxTargetSource(target)
          const result = target.adapter.patch(source, payload.instanceId, payload.prop, payload.value, payload.hash)
          const checked = target.adapter.inspect(result.source)
          if (checked.instances.length > MAX_MDX_COMPONENT_INSTANCES) {
            const error = new Error('Configured MDX target exceeds the safe component instance limit.')
            error.code = 'MDX_INSTANCE_LIMIT'
            throw error
          }
          if (checked.hash !== result.hash) throw Object.assign(new Error('Patched MDX failed parser revalidation.'), { code: 'UNSUPPORTED_OUTPUT' })
          return { result, source }
        }
        if (previewing) {
          const { result } = prepare()
          if (!result.diff) return json(response, 200, { previewId: null, diff: null, hash: result.hash })
          prunePreviews(); const id = previewId()
          const operation = { targetId: payload.targetId, instanceId: payload.instanceId, prop: payload.prop, value: payload.value, hash: payload.hash }
          pendingMdxPreviews.set(id, { operation, diff: result.diff, nextHash: result.hash, sessionToken: request.headers['x-editor-token'], expiresAt: Date.now() + PREVIEW_TTL_MS })
          return json(response, 200, { previewId: id, hash: payload.hash, nextHash: result.hash, diff: result.diff })
        }
        prunePreviews()
        const pending = pendingMdxPreviews.get(payload.previewId)
        if (!pending || pending.expiresAt <= Date.now()) return json(response, 409, { code: 'PREVIEW_EXPIRED', error: 'Preview expired.' })
        if (pending.sessionToken !== request.headers['x-editor-token']) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
        pendingMdxPreviews.delete(payload.previewId)
        const operation = { targetId: payload.targetId, instanceId: payload.instanceId, prop: payload.prop, value: payload.value, hash: payload.hash }
        if (JSON.stringify(operation) !== JSON.stringify(pending.operation)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Commit differs from preview.' })
        const { result } = prepare()
        if (!result.diff || result.hash !== pending.nextHash || JSON.stringify(result.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Source no longer matches preview.' })
        assertMdxTargetSafe(target.root, target.file)
        await writeSource(target.file, payload.hash, result.source)
        return json(response, 200, { targetId: target.id, hash: result.hash })
      } catch (error) {
        const failure = safeMdxFailure(error)
        return json(response, failure.code === 'STALE_HASH' ? 409 : 422, failure)
      }
    }

    if (request.method === 'GET' && request.url?.startsWith('/api/preview-ready?')) {
      try {
        const url = new URL(request.url, editorOrigin())
        const hash = url.searchParams.get('hash')
        if (url.pathname !== '/api/preview-ready' || url.searchParams.size !== 1 ||
            [...url.searchParams.keys()].some((key) => key !== 'hash') || !hash || !/^[a-f0-9]{64}$/.test(hash)) {
          return json(response, 400, { code: 'INVALID_HASH', error: 'Expected a SHA-256 fixture hash.' })
        }
        const result = await waitForRenderedOrder({ hash, siteOrigin, fixturePath, basePath: safeBasePath })
        return json(response, result.statusCode, result.payload)
      } catch (error) {
        return json(response, 422, { code: error.code || 'UNSUPPORTED_FIXTURE', error: error.message })
      }
    }

    if (request.method === 'POST' && (request.url === '/api/collections/create-entry/preview' || request.url === '/api/collections/create-entry/commit' || request.url === '/api/collections/create-entry/cancel')) {
      if (!validEditorPost(request)) return json(response, 403, { error: 'Request origin or content type is not allowed.' })
      if (!collectionRuntime) return json(response, 404, { error: 'Collection editing is not configured.' })
      try {
        const payload = await readJson(request)
        const route = request.url.split('/').at(-1)
        const sessionToken = request.headers['x-editor-token']
        if (route === 'cancel') {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !/^[a-f0-9]{64}$/.test(payload.previewId || '')) return json(response, 422, { code: 'INVALID_REQUEST', error: 'A previewId is required.' })
          const pending = pendingPreviews.get(payload.previewId)
          if (pending && pending.sessionToken !== sessionToken) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
          if (pending?.kind === 'collection-create-entry') pendingPreviews.delete(payload.previewId)
          return json(response, 200, { cancelled: true })
        }
        const previewing = route === 'preview'
        if (!validEntryCreationOperation(payload, !previewing)) return json(response, 422, { code: 'INVALID_REQUEST', error: 'Only a supported collection ID, new relative Markdown filename, scalar schema values, and config hash are accepted.' })
        const operation = { collectionId: payload.collectionId, entryId: payload.entryId, values: payload.values, hash: payload.hash }
        const prepare = () => collectionRuntime.planEntryCreation(operation)
        if (previewing) {
          const result = prepare()
          prunePreviews()
          const id = previewId()
          pendingPreviews.set(id, { kind: 'collection-create-entry', operation, diff: result.diff, hash: result.hash, configHash: result.configHash, sessionToken, expiresAt: Date.now() + PREVIEW_TTL_MS })
          return json(response, 200, { previewId: id, hash: result.hash, diff: result.diff, entryId: result.entryId })
        }
        prunePreviews()
        const pending = pendingPreviews.get(payload.previewId)
        if (!pending || pending.expiresAt <= Date.now() || pending.kind !== 'collection-create-entry') {
          pendingPreviews.delete(payload.previewId)
          return json(response, 409, { code: 'PREVIEW_EXPIRED', error: 'Entry preview expired; prepare it again.' })
        }
        if (pending.sessionToken !== sessionToken) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
        pendingPreviews.delete(payload.previewId)
        if (!sameEntryCreationOperation(pending.operation, operation)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Entry commit differs from preview.' })
        const result = prepare()
        if (result.hash !== pending.hash || result.configHash !== pending.configHash || JSON.stringify(result.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Entry no longer matches the confirmed preview.' })
        const finalPlan = prepare()
        if (finalPlan.hash !== pending.hash || finalPlan.configHash !== pending.configHash || JSON.stringify(finalPlan.diff) !== JSON.stringify(pending.diff)) return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Collection changed immediately before entry creation.' })
        await createSource(finalPlan.path, finalPlan.source)
        return json(response, 201, { collectionId: operation.collectionId, entryId: operation.entryId, hash: finalPlan.hash })
      } catch (error) {
        const safeCodes = new Set(['STALE_CONFIG', 'UNSUPPORTED_COLLECTION', 'UNSUPPORTED_ENTRY', 'UNSAFE_COLLECTION_PATH', 'INVALID_ENTRY_ID', 'ENTRY_EXISTS', 'INVALID_FIELD_VALUE', 'UNSUPPORTED_FIELD', 'ENTRY_LIMIT'])
        const code = safeCodes.has(error.code) ? error.code : error.code === 'EEXIST' ? 'ENTRY_EXISTS' : 'COLLECTION_CREATE_FAILED'
        const message = code === 'COLLECTION_CREATE_FAILED'
          ? 'Collection entry could not be created safely.'
          : code === 'ENTRY_EXISTS'
            ? 'An entry already exists at this filename.'
            : error.message
        return json(response, code === 'STALE_CONFIG' || code === 'ENTRY_EXISTS' ? 409 : code === 'COLLECTION_CREATE_FAILED' ? 500 : 422, { code, error: message })
      }
    }

    if (request.method === 'POST' && (request.url === '/api/collections/preview' || request.url === '/api/collections/commit')) {
      if (!validEditorPost(request)) {
        return json(response, 403, { error: 'Request origin or content type is not allowed.' })
      }
      if (!collectionRuntime) return json(response, 404, { error: 'Collection editing is not configured.' })

      try {
        const payload = await readJson(request)
        const isPreview = request.url === '/api/collections/preview'
        if (isPreview) {
          if (!validCollectionOperation(payload)) {
            return json(response, 422, { code: 'INVALID_REQUEST', error: 'Only a collectionId, relative entryId, field, JSON scalar value, and content hash are accepted.' })
          }
          const { target, result } = prepareCollectionPatch(payload)
          if (!result.diff) {
            return json(response, 200, { diff: null, hash: result.hash, nextHash: result.hash, previewId: null })
          }
          // Confirm config and entry membership again before issuing the preview binding.
          collectionRuntime.assertEntrySafe(target.path)
          const latest = collectionRuntime.inspect()
          if (latest._configHash !== target.configHash) {
            const error = new Error('The content schema changed during preview preparation.')
            error.code = 'STALE_CONFIG'
            throw error
          }
          prunePreviews()
          const id = previewId()
          const operation = {
            collectionId: payload.collectionId,
            entryId: payload.entryId,
            field: payload.field,
            value: payload.value,
            hash: payload.hash,
          }
          pendingPreviews.set(id, {
            kind: 'collection-field',
            operation,
            diff: result.diff,
            nextHash: result.hash,
            configHash: target.configHash,
            sessionToken: request.headers['x-editor-token'],
            expiresAt: Date.now() + PREVIEW_TTL_MS,
          })
          return json(response, 200, { previewId: id, hash: payload.hash, nextHash: result.hash, diff: result.diff })
        }

        if (!validCollectionOperation(payload, true)) {
          return json(response, 422, { code: 'INVALID_REQUEST', error: 'A previewId and the unchanged collection edit operation are required.' })
        }
        prunePreviews()
        const pending = pendingPreviews.get(payload.previewId)
        if (!pending || pending.expiresAt <= Date.now() || pending.kind !== 'collection-field') {
          pendingPreviews.delete(payload.previewId)
          return json(response, 409, { code: 'PREVIEW_EXPIRED', error: 'Preview expired; prepare the change again.' })
        }
        if (pending.sessionToken !== request.headers['x-editor-token']) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
        pendingPreviews.delete(payload.previewId)
        if (!sameCollectionOperation(pending.operation, payload)) {
          return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Commit does not match the confirmed preview.' })
        }
        const { target, result } = prepareCollectionPatch(payload)
        if (target.configHash !== pending.configHash) {
          return json(response, 409, { code: 'STALE_CONFIG', error: 'Content schema changed after preview; prepare the edit again.' })
        }
        if (!result.diff || result.hash !== pending.nextHash || JSON.stringify(result.diff) !== JSON.stringify(pending.diff)) {
          return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'The entry edit no longer matches the confirmed preview.' })
        }
        collectionRuntime.assertEntrySafe(target.path)
        const beforeWriteState = collectionRuntime.inspect()
        const beforeWriteCollection = beforeWriteState.collections.find((item) => item.id === payload.collectionId)
        if (beforeWriteState._configHash !== pending.configHash || beforeWriteCollection?.mode !== 'editable' ||
            !beforeWriteCollection.fields.some((field) => field.name === payload.field && field.editable) ||
            !beforeWriteCollection.entries.some((entry) => entry.id === payload.entryId && entry.hash === payload.hash)) {
          return json(response, 409, { code: 'STALE_CONFIG', error: 'Content config or entry membership changed immediately before write; prepare the edit again.' })
        }
        await writeSource(target.path, payload.hash, result.source)
        return json(response, 200, {
          collectionId: payload.collectionId,
          entryId: payload.entryId,
          field: payload.field,
          hash: result.hash,
        })
      } catch (error) {
        const safeCodes = new Set([
          'STALE_HASH', 'STALE_CONFIG', 'UNSUPPORTED_COLLECTION', 'UNSUPPORTED_FIELD', 'UNSUPPORTED_ENTRY',
          'UNSAFE_COLLECTION_PATH', 'ENTRY_LIMIT', 'UNSUPPORTED_FIELD_TYPE', 'INVALID_FIELD_VALUE',
          'UNSUPPORTED_FRONTMATTER', 'PREVIEW_EXPIRED', 'PREVIEW_MISMATCH', 'INVALID_REQUEST',
        ])
        const code = safeCodes.has(error.code) ? error.code : 'COLLECTION_EDIT_FAILED'
        const message = code === 'COLLECTION_EDIT_FAILED'
          ? 'Collection edit could not be completed safely.'
          : error.message
        const statusCode = error.statusCode || (['STALE_HASH', 'STALE_CONFIG'].includes(code) ? 409 : code === 'COLLECTION_EDIT_FAILED' ? 500 : 422)
        return json(response, statusCode, { error: message, code })
      }
    }

    if (request.method === 'POST' && (request.url === '/api/preview' || request.url === '/api/commit')) {
      if (!validEditorPost(request)) {
        return json(response, 403, { error: 'Request origin or content type is not allowed.' })
      }

      try {
        const payload = await readJson(request)
        const isPreview = request.url === '/api/preview'
        if (isPreview) {
          if (!validOperation(payload, ['galleryId', 'order', 'hash'])) {
            return json(response, 422, { code: 'INVALID_REQUEST', error: 'Only a valid galleryId, order, and hash are accepted.' })
          }
          const source = readFileSync(fixturePath, 'utf8')
          if (hashSource(source) !== payload.hash) {
            const error = new Error('The source changed since it was loaded; reload before preparing a preview.')
            error.code = 'STALE_HASH'
            throw error
          }
          inspectDemoFixture(source)
          const result = FIXTURE_ADAPTER.patch(source, payload.galleryId, payload.order, payload.hash)
          validateDemoImageSlugs(result.galleries)
          const validated = inspectDemoFixture(result.source)
          if (validated.hash !== result.hash) {
            const error = new Error('The patched source failed parser revalidation.')
            error.code = 'UNSUPPORTED_OUTPUT'
            throw error
          }
          if (!result.diff) {
            return json(response, 200, { diff: null, hash: result.hash, nextHash: result.hash, previewId: null })
          }

          prunePreviews()
          const id = previewId()
          const operation = { galleryId: payload.galleryId, order: payload.order, hash: payload.hash }
          pendingPreviews.set(id, {
            operation,
            diff: result.diff,
            nextHash: result.hash,
            sessionToken: request.headers['x-editor-token'],
            expiresAt: Date.now() + PREVIEW_TTL_MS,
          })
          return json(response, 200, {
            previewId: id,
            hash: payload.hash,
            nextHash: result.hash,
            diff: result.diff,
          })
        }

        if (!validOperation(payload, ['previewId', 'galleryId', 'order', 'hash']) ||
            !/^[a-f0-9]{64}$/.test(payload.previewId)) {
          return json(response, 422, { code: 'INVALID_REQUEST', error: 'A previewId and the unchanged galleryId, order, and hash are required.' })
        }
        prunePreviews()
        const pending = pendingPreviews.get(payload.previewId)
        if (!pending || pending.expiresAt <= Date.now()) {
          pendingPreviews.delete(payload.previewId)
          return json(response, 409, { code: 'PREVIEW_EXPIRED', error: 'Preview expired; prepare the change again.' })
        }
        if (pending.sessionToken !== request.headers['x-editor-token']) return json(response, 409, { code: 'PREVIEW_SESSION_MISMATCH', error: 'Preview belongs to a different editor session.' })
        pendingPreviews.delete(payload.previewId)
        if (!sameOperation(pending.operation, payload)) {
          return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'Commit does not match the confirmed preview.' })
        }

        const source = readFileSync(fixturePath, 'utf8')
        if (hashSource(source) !== payload.hash) {
          const error = new Error('The source changed since the preview was confirmed.')
          error.code = 'STALE_HASH'
          throw error
        }
        inspectDemoFixture(source)
        const result = FIXTURE_ADAPTER.patch(source, payload.galleryId, payload.order, payload.hash)
        validateDemoImageSlugs(result.galleries)
        const validated = inspectDemoFixture(result.source)
        if (!result.diff || result.hash !== pending.nextHash ||
            JSON.stringify(result.diff) !== JSON.stringify(pending.diff) || validated.hash !== result.hash) {
          return json(response, 409, { code: 'PREVIEW_MISMATCH', error: 'The source operation no longer matches the confirmed preview.' })
        }
        await writeSource(fixturePath, payload.hash, result.source)
        return json(response, 200, { galleries: validated.galleries, hash: validated.hash })
      } catch (error) {
        const statusCode = error.statusCode || (error.code === 'STALE_HASH' ? 409 : 422)
        return json(response, statusCode, { error: error.message, code: error.code || 'INVALID_REQUEST' })
      }
    }

    return json(response, 404, { error: 'Not found.' })
  })

  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.EDITOR_PORT || 4322)
  const syntheticTargets = process.env.AVCMS_BROWSER_SYNTHETIC === '1' ? [{
    id: 'fixture', projectRoot: PROJECT_ROOT, filePath: path.join(PROJECT_ROOT, 'src/pages/fixture.mdx'),
    importSource: '../components/EditorUnknownChip.astro', idProp: 'id', editableProps: ['label'],
  }] : undefined
  const server = createEditorServer({ port, ...(syntheticTargets ? { mdxComponentTargets: syntheticTargets } : {}) })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Fixture editor could not start: port ${port} is already in use.`)
    } else {
      console.error(`Fixture editor failed to start: ${error.message}`)
    }
    process.exitCode = 1
  })
  const stop = () => {
    server.close((error) => {
      if (error) {
        console.error(`Fixture editor failed to close cleanly: ${error.message}`)
        process.exitCode = 1
      }
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  server.listen(port, '127.0.0.1', () => {
    console.log(`Fixture editor: http://127.0.0.1:${port}`)
  })
}
