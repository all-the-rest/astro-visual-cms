import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createGalleryPatchAdapter } from '../lib/gallery-patch.mjs'
import { FIXTURE_IMAGE_SLUGS } from '../lib/demo-image-manifest.mjs'
import { writeSourceAtomically } from './source-write.mjs'

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'src/pages/fixture.mdx')
const FIXTURE_ADAPTER = createGalleryPatchAdapter({ galleryImportSource: '../components/Gallery.astro' })
const UI_PATH = fileURLToPath(new URL('./index.html', import.meta.url))
const MAX_BODY_BYTES = 8 * 1024
const PREVIEW_SYNC_TIMEOUT_MS = 4_000
const PREVIEW_POLL_INTERVAL_MS = 100

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

async function waitForRenderedOrder({ hash, siteOrigin, fixturePath }) {
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
      const response = await fetch(`${siteOrigin}/fixture/?preview=${hash}`, {
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
            payload: { hash, galleries, previewUrl: `${siteOrigin}/fixture/?revision=${hash}` },
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

export function createEditorServer({
  port = Number(process.env.EDITOR_PORT || 4322),
  sitePort = Number(process.env.ASTRO_PORT || 4321),
  fixturePath = FIXTURE_PATH,
} = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The fixture write API is development-only and cannot run with NODE_ENV=production.')
  }
  const siteOrigin = `http://127.0.0.1:${sitePort}`
  const editorToken = randomBytes(32).toString('hex')
  const editorOrigin = () => `http://127.0.0.1:${server.address()?.port ?? port}`

  const server = createServer(async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return json(response, 403, { error: 'Loopback clients only.' })
    }

    if (request.method === 'GET' && request.url === '/') {
      const html = readFileSync(UI_PATH, 'utf8').replaceAll('__SITE_ORIGIN__', siteOrigin)
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      return response.end(html)
    }

    if (request.method === 'GET' && request.url === '/api/session') {
      return json(response, 200, { token: editorToken })
    }

    if (request.method === 'GET' && request.url === '/api/state') {
      try {
        const source = readFileSync(fixturePath, 'utf8')
        return json(response, 200, inspectDemoFixture(source))
      } catch (error) {
        return json(response, 422, { error: error.message, code: error.code || 'UNSUPPORTED_FIXTURE' })
      }
    }

    if (request.method === 'GET' && request.url?.startsWith('/api/preview-ready?')) {
      try {
        const url = new URL(request.url, editorOrigin())
        const hash = url.searchParams.get('hash')
        if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
          return json(response, 400, { code: 'INVALID_HASH', error: 'Expected a SHA-256 fixture hash.' })
        }
        const result = await waitForRenderedOrder({ hash, siteOrigin, fixturePath })
        return json(response, result.statusCode, result.payload)
      } catch (error) {
        return json(response, 422, { code: error.code || 'UNSUPPORTED_FIXTURE', error: error.message })
      }
    }

    if (request.method === 'POST' && request.url === '/api/reorder') {
      if (request.headers.host !== `127.0.0.1:${server.address()?.port ?? port}` ||
          request.headers.origin !== editorOrigin() || request.headers['content-type'] !== 'application/json' ||
          !hasEditorToken(request.headers['x-editor-token'], editorToken)) {
        return json(response, 403, { error: 'Request origin or content type is not allowed.' })
      }

      try {
        const payload = await readJson(request)
        const allowedKeys = new Set(['galleryId', 'order', 'hash'])
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).length !== allowedKeys.size ||
            Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
            typeof payload.galleryId !== 'string' || !Array.isArray(payload.order) || typeof payload.hash !== 'string') {
          return json(response, 422, { code: 'INVALID_REQUEST', error: 'Only galleryId, order, and hash are accepted.' })
        }
        const source = readFileSync(fixturePath, 'utf8')
        inspectDemoFixture(source)
        const result = FIXTURE_ADAPTER.patch(source, payload.galleryId, payload.order, payload.hash)
        validateDemoImageSlugs(result.galleries)
        await writeSourceAtomically(fixturePath, payload.hash, result.source)
        return json(response, 200, { galleries: result.galleries, hash: result.hash })
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
  const server = createEditorServer({ port })
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
