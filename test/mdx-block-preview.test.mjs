import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createMdxBlockPreviewPlugin } from '../src/editor/mdx-block-preview.mjs'
import { hashSource } from '../src/lib/gallery-patch.mjs'

const blockTypes = [{
  type: 'card', label: 'Card', componentName: 'Card', importSource: '../components/Card.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}]

async function withTarget(run, { siteOrigin = 'http://127.0.0.1:4321', addressPort = 4321, autoAcknowledge = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'avcms-mdx-preview-')))
  try {
    await mkdir(path.join(root, 'src', 'pages'), { recursive: true })
    const file = path.join(root, 'src', 'pages', 'blocks.mdx')
    const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
    await writeFile(file, source)
    const plugin = createMdxBlockPreviewPlugin({
      targets: [{ id: 'blocks', projectRoot: root, filePath: file, previewPath: '/blocks/', blockTypes }],
      token: 't'.repeat(64),
      siteOrigin,
    })
    let middleware
    const invalidated = []
    const messages = []
    const devServer = {
      httpServer: { address: () => ({ port: addressPort }) },
      middlewares: { use(pathname, handler) { assert.equal(pathname, '/__avcms/mdx-block-preview'); middleware = handler } },
      moduleGraph: {
        getModulesByFile() { return new Set([{ id: file }]) },
        invalidateModule(module) { invalidated.push(module.id) },
      },
      ws: { send(message) { messages.push(message) } },
    }
    plugin.configureServer(devServer)
    const expectedOrigin = typeof siteOrigin === 'function' ? siteOrigin(devServer) : siteOrigin
    const invoke = async (payload, headers = {}) => {
      const req = Readable.from([JSON.stringify(payload)])
      req.method = 'POST'
      req.headers = {
        host: new URL(expectedOrigin).host, origin: expectedOrigin, referer: `${expectedOrigin}/blocks/`,
        'content-type': 'application/json', 'x-avcms-token': 't'.repeat(64), ...headers,
      }
      let status, body
      const res = { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } }
      await middleware(req, res, () => assert.fail('Preview middleware unexpectedly delegated the request.'))
      return { status, body }
    }
    const request = async (payload, headers = {}) => {
      const isControl = Object.hasOwn(payload, 'reset') || Object.hasOwn(payload, 'rendered')
      const normalized = isControl || payload.requestId ? payload : { ...payload, requestId: 'unit-preview' }
      const result = await invoke(normalized, headers)
      if (autoAcknowledge && result.status === 200 && Array.isArray(normalized.operations)) {
        const acknowledged = await invoke({ targetId: normalized.targetId, requestId: normalized.requestId, rendered: true }, headers)
        assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body))
      }
      return result
    }
    await run({ root, file, source, plugin, request, invalidated, messages })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('dev overlay recompiles a validated component block without changing the MDX file', async () => {
  await withTarget(async ({ file, source, plugin, request, invalidated, messages }) => {
    const result = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-added', blockType: 'card', values: { title: 'Draft title' } }],
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.blockCount, 2)
    assert.deepEqual(await readFile(file, 'utf8'), source)
    assert.ok(invalidated.includes(file))
    assert.deepEqual(messages, [], 'the bridge reloads only after it receives the successful preview result')
    const transformed = plugin.transform.handler(source, file)
    assert.match(transformed.code, /<Card id="block-added" title="Draft title" \/>/)
    assert.equal(transformed.code.includes('title="Before"'), true)
  })
})

test('dev overlay applies a sequential multi-operation draft exactly once against the base revision', async () => {
  await withTarget(async ({ file, source, plugin, request }) => {
    const result = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [
        { action: 'add', blockId: 'block-sequential', blockType: 'card', values: { title: 'Temporary' } },
        { action: 'set', blockId: 'block-sequential', prop: 'title', value: 'Final' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.blockCount, 2)
    const transformed = plugin.transform.handler(source, file)
    assert.match(transformed.code, /id="block-sequential" title="Final"/)
    assert.doesNotMatch(transformed.code, /title="Temporary"/)
    assert.equal(await readFile(file, 'utf8'), source)
  })
})

test('dev overlay accepts the actual Astro CLI listener port instead of the configured default', async () => {
  await withTarget(async ({ source, request, plugin, file }) => {
    const operation = { action: 'set', blockId: 'one', prop: 'title', value: 'CLI port override' }
    const result = await request({ targetId: 'blocks', hash: hashSource(source), operations: [operation] })
    assert.equal(result.status, 200)
    assert.match(plugin.transform.handler(source, file).code, /title="CLI port override"/)
  }, {
    addressPort: 15433,
    siteOrigin: (server) => `http://127.0.0.1:${server.httpServer.address().port}`,
  })
})

test('dev overlay rejects the default port when Astro is serving on an overridden port', async () => {
  await withTarget(async ({ source, request }) => {
    const result = await request({ targetId: 'blocks', hash: hashSource(source), operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Wrong origin' }] }, {
      host: '127.0.0.1:4321',
      origin: 'http://127.0.0.1:4321',
      referer: 'http://127.0.0.1:4321/blocks/',
    })
    assert.equal(result.status, 403)
  }, {
    addressPort: 15433,
    siteOrigin: (server) => `http://127.0.0.1:${server.httpServer.address().port}`,
  })
})

test('dev overlay compiles special MDX string values before activating the overlay', async () => {
  await withTarget(async ({ source, request, plugin, file }) => {
    const value = 'Quote: "welcome" \\docs\\cms\nsecond line'
    const result = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value }],
    })
    assert.equal(result.status, 200)
    assert.ok(plugin.transform.handler(source, file).code.includes(`title={${JSON.stringify(value)}}`))
    assert.equal(await readFile(file, 'utf8'), source)
  })
})

test('dev overlay rejects wrong origin/token, route, stale source, and unsafe operation', async () => {
  await withTarget(async ({ source, request }) => {
    const operation = { action: 'set', blockId: 'one', prop: 'title', value: 'After' }
    const base = { targetId: 'blocks', hash: hashSource(source), operations: [operation] }
    assert.equal((await request(base, { origin: 'http://evil.test' })).status, 403)
    assert.equal((await request(base, { 'x-avcms-token': 'x'.repeat(64) })).status, 403)
    assert.equal((await request(base, { referer: 'http://127.0.0.1:4321/other/' })).status, 404)
    assert.equal((await request({ ...base, hash: '0'.repeat(64) })).status, 409)
    assert.equal((await request({ ...base, operations: [{ ...operation, prop: 'unknown' }] })).status, 422)
  })
})

test('reset removes the in-memory overlay and reloads the trusted preview module', async () => {
  await withTarget(async ({ file, source, plugin, request }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Draft' }],
    })
    assert.equal(preview.status, 200)
    assert.match(plugin.transform.handler(source, file).code, /title="Draft"/)
    const reset = await request({ targetId: 'blocks', requestId: 'reset-one', reset: true })
    assert.equal(reset.status, 200)
    assert.equal(plugin.transform.handler(source, file), null)
  })
})
