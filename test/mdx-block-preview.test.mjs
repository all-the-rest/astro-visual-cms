import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createMdxBlockPreviewPlugin, PREVIEW_RENDER_TIMEOUT_MS } from '../src/editor/mdx-block-preview.mjs'
import { hashSource } from '../src/lib/gallery-patch.mjs'

const blockTypes = [{
  type: 'card', label: 'Card', componentName: 'Card', importSource: '../components/Card.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}]

// A tiny Markdown renderer stand-in for the unit tests. The real integration
// test exercises the project's actual Markdown processor; these tests only
// cover the preview plumbing, so the stub keeps headings/paragraphs visible.
const markdown = {
  processor: {
    async createRenderer() {
      return {
        async render(content, options) {
          const headings = []
          let html = ''
          for (const line of content.split(/\r?\n/)) {
            const heading = /^(#{1,6})\s+(.*)$/.exec(line)
            if (heading) {
              const depth = heading[1].length
              const slug = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
              headings.push({ depth, slug, text: heading[2] })
              html += `<h${depth} id="${slug}">${heading[2]}</h${depth}>`
            } else if (line.trim()) {
              html += `<p>${line}</p>`
            }
          }
          return { code: html, metadata: { headings, frontmatter: options?.frontmatter ?? {} } }
        },
      }
    },
  },
}

async function withTarget(run, { siteOrigin = 'http://127.0.0.1:4321', addressPort = 4321, autoAcknowledge = true, extension = '.mdx', source: sourceOverride, renderTimeoutMs, overlayLifetimeMs, markdownConfig = markdown } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'avcms-mdx-preview-')))
  try {
    await mkdir(path.join(root, 'src', 'pages'), { recursive: true })
    const file = path.join(root, 'src', 'pages', `blocks${extension}`)
    const source = sourceOverride ?? `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
    await writeFile(file, source)
    const plugin = createMdxBlockPreviewPlugin({
      targets: [{ id: 'blocks', projectRoot: root, filePath: file, previewPath: '/blocks/', blockTypes }],
      token: 't'.repeat(64),
      siteOrigin,
      renderTimeoutMs,
      overlayLifetimeMs,
      markdown: markdownConfig,
    })
    let middleware
    let renderMiddleware
    const invalidated = []
    const messages = []
    const devServer = {
      httpServer: { address: () => ({ port: addressPort }) },
      middlewares: {
        use(pathname, handler) {
          if (typeof pathname === 'function') {
            renderMiddleware = pathname
            return
          }
          assert.equal(pathname, '/__avcms/mdx-block-preview')
          middleware = handler
        },
      },
      moduleGraph: {
        getModulesByFile(requested) { return requested === file ? new Set([{ id: file }]) : new Set() },
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
        // The real bridge acknowledges from the reloaded page after Astro has
        // requested and transformed the armed draft module.
        plugin.transform.handler(source, file)
        const acknowledged = await invoke({ targetId: normalized.targetId, requestId: normalized.requestId, rendered: true }, headers)
        assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body))
      }
      return result
    }
    const render = async (pathname, statusCode) => {
      assert.ok(renderMiddleware, 'the plugin must observe rendered routes')
      const finishListeners = []
      const req = { url: pathname, method: 'GET' }
      const res = { statusCode, on(event, listener) { if (event === 'finish') finishListeners.push(listener) } }
      let delegated = false
      await renderMiddleware(req, res, () => { delegated = true })
      assert.equal(delegated, true, 'the render observer must delegate to the next middleware')
      for (const listener of finishListeners) listener()
    }
    await run({ root, file, source, plugin, request, invoke, render, invalidated, messages })
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

test('a .md target renders through a virtual Astro module without changing the Markdown file', async () => {
  const markdownSource = '# Markdown target\n\nA paragraph that stays plain Markdown.\n'
  await withTarget(async ({ file, source, plugin, request }) => {
    const virtualId = path.join(path.dirname(file), `.${path.basename(file)}.blocks.avcms-preview.astro`)
    assert.equal(existsSync(virtualId), false)
    const result = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-virtual', blockType: 'card', values: { title: 'Virtual title' } }],
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(await readFile(file, 'utf8'), markdownSource)
    assert.equal(existsSync(virtualId), false)
    const transformed = plugin.transform.handler('# compiled markdown module is discarded', file)
    assert.equal(transformed.code, `export { default } from "./${path.basename(virtualId)}";`)
    assert.deepEqual(plugin.resolveId.handler(`./${path.basename(virtualId)}`, file), { id: virtualId })
    const loaded = plugin.load.handler(virtualId)
    // Only catalog-generated imports and component calls are executable; the
    // saved Markdown is embedded as the Markdown renderer's HTML.
    assert.match(loaded, /import Card from "\.\.\/components\/Card\.astro"/)
    assert.match(loaded, /<Card id="block-virtual" title="Virtual title" \/>/)
    const html = JSON.parse(/const __avcmsHtml = ("(?:[^"\\]|\\.)*")/.exec(loaded)[1])
    assert.match(html, /<h1 id="markdown-target">Markdown target<\/h1>/)
    assert.match(loaded, /<Fragment set:html=\{__avcmsHtml\} \/>/)
    assert.equal(loaded.includes('{process.exit'), false)
    assert.equal(await readFile(file, 'utf8'), markdownSource)
  }, { extension: '.md', source: markdownSource })
})

test('an externally changed .md source discards the virtual draft instead of rendering stale content', async () => {
  const markdown = '# Markdown target\n\nOriginal paragraph.\n'
  const changed = '# Markdown target\n\nExternally changed paragraph.\n'
  await withTarget(async ({ file, source, plugin, request }) => {
    const virtualId = path.join(path.dirname(file), `.${path.basename(file)}.blocks.avcms-preview.astro`)
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-virtual', blockType: 'card', values: { title: 'Virtual title' } }],
    })
    assert.equal(preview.status, 200)
    await writeFile(file, changed)
    assert.throws(() => plugin.load.handler(virtualId), /changed|no longer active/i)
    assert.equal(plugin.transform.handler('# compiled markdown module', file), null)
    assert.equal(await readFile(file, 'utf8'), changed)
    assert.equal(existsSync(virtualId), false)
  }, { extension: '.md', source: markdown })
})

test('an externally changed .md source drops the draft during the page transform', async () => {
  const markdown = '# Markdown target\n\nOriginal paragraph.\n'
  const changed = '# Markdown target\n\nExternally changed paragraph.\n'
  await withTarget(async ({ file, source, plugin, request }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-virtual', blockType: 'card', values: { title: 'Virtual title' } }],
    })
    assert.equal(preview.status, 200)
    await writeFile(file, changed)
    assert.equal(plugin.transform.handler('# compiled markdown module', file), null)
    const virtualId = path.join(path.dirname(file), `.${path.basename(file)}.blocks.avcms-preview.astro`)
    assert.throws(() => plugin.load.handler(virtualId), /no longer active/i)
    assert.equal(await readFile(file, 'utf8'), changed)
  }, { extension: '.md', source: markdown })
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
    assert.equal(reset.body.changed, true)
    assert.equal(plugin.transform.handler(source, file), null)
  })
})

test('reset without an active overlay reports no change and does not reload', async () => {
  await withTarget(async ({ request, invalidated, messages }) => {
    const reset = await request({ targetId: 'blocks', requestId: 'reset-none', reset: true })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.changed, false)
    assert.deepEqual(invalidated, [])
    assert.deepEqual(messages, [])
  })
})

test('an acknowledged overlay expires after its bounded lifetime instead of rendering forever', async () => {
  await withTarget(async ({ file, source, plugin, invoke, request, invalidated, messages }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Bounded draft' }],
    })
    assert.equal(preview.status, 200)
    assert.match(plugin.transform.handler(source, file).code, /title="Bounded draft"/)
    const acknowledged = await invoke({ targetId: 'blocks', requestId: 'unit-preview', rendered: true })
    assert.equal(acknowledged.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(plugin.transform.handler(source, file), null, 'the acknowledged overlay must not stay active forever')
    assert.ok(invalidated.includes(file))
    assert.deepEqual(messages, [{ type: 'full-reload' }])
  }, { overlayLifetimeMs: 40, autoAcknowledge: false })
})

test('reset clears the bounded overlay timer so no late expiry reload happens', async () => {
  await withTarget(async ({ source, request, invalidated, messages }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Reset draft' }],
    })
    assert.equal(preview.status, 200)
    const reset = await request({ targetId: 'blocks', requestId: 'reset-bounded', reset: true })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.changed, true)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.deepEqual(messages, [], 'a reset overlay must not send a late expiry reload')
    assert.equal(invalidated.length, 2, 'only preview and reset invalidate the module')
  }, { overlayLifetimeMs: 40 })
})

test('a slow render is acknowledged while it finishes inside the server render grace', async () => {
  await withTarget(async ({ file, source, plugin, invoke, request }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Slow render' }],
    }, {})
    assert.equal(preview.status, 200)
    // Simulate the editor still waiting for the Astro bridge to reload.
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.match(plugin.transform.handler(source, file).code, /title="Slow render"/, 'the draft must stay active while the render is still in flight')
    const acknowledged = await invoke({ targetId: 'blocks', requestId: 'unit-preview', rendered: true })
    assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body))
    assert.match(plugin.transform.handler(source, file).code, /title="Slow render"/, 'a timely acknowledgement keeps the rendered draft alive')
  }, { renderTimeoutMs: 400, autoAcknowledge: false })
})

test('an unacknowledged render expires after its grace and rejects a late acknowledgement', async () => {
  await withTarget(async ({ file, source, plugin, invoke, request, invalidated, messages }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Missed render' }],
    }, {})
    assert.equal(preview.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(plugin.transform.handler(source, file), null, 'the unacknowledged draft must not render forever')
    assert.ok(invalidated.includes(file))
    assert.deepEqual(messages, [{ type: 'full-reload' }])
    const late = await invoke({ targetId: 'blocks', requestId: 'unit-preview', rendered: true })
    assert.equal(late.status, 409)
    assert.equal(late.body.code, 'PREVIEW_RENDER_EXPIRED')
  }, { renderTimeoutMs: 40, autoAcknowledge: false })
})

test('a failed page render drops the active draft immediately so the saved source can recover', async () => {
  await withTarget(async ({ file, source, plugin, request, render, invalidated, messages }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Runtime failure' }],
    })
    assert.equal(preview.status, 200)
    assert.match(plugin.transform.handler(source, file).code, /title="Runtime failure"/)
    // The draft compiles but throws while Astro renders the route. The page
    // cannot host the reset bridge, so the draft must be dropped right away.
    await render('/blocks/', 500)
    assert.equal(plugin.transform.handler(source, file), null, 'a failing draft must not survive and block recovery')
    assert.ok(invalidated.includes(file))
    assert.deepEqual(messages, [{ type: 'full-reload' }])
  })
})

test('a successful page render keeps the active draft', async () => {
  await withTarget(async ({ file, source, plugin, request, render, messages }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value: 'Rendered fine' }],
    })
    assert.equal(preview.status, 200)
    await render('/blocks/', 200)
    assert.match(plugin.transform.handler(source, file).code, /title="Rendered fine"/, 'a 2xx render must not discard the draft')
    assert.deepEqual(messages, [])
  })
})

test('the server render grace exceeds the editor render wait so slow renders can still be acknowledged', async () => {
  const html = await readFile(new URL('../src/editor/index.html', import.meta.url), 'utf8')
  const renderWait = Number(html.match(/const MDX_BLOCK_RENDER_WAIT_MS = (\d+);/)?.[1])
  const ackTimeout = Number(html.match(/const MDX_BLOCK_RENDER_ACK_TIMEOUT_MS = (\d+);/)?.[1])
  assert.ok(Number.isInteger(renderWait) && renderWait > 0, 'the editor must declare its render wait')
  assert.ok(Number.isInteger(ackTimeout) && ackTimeout > 0, 'the editor must declare its acknowledgement timeout')
  assert.ok(
    PREVIEW_RENDER_TIMEOUT_MS > renderWait + ackTimeout,
    `the ${PREVIEW_RENDER_TIMEOUT_MS}ms server render grace must cover the ${renderWait}ms render wait plus ack/network margin`,
  )
})

test('an overlay lifetime must be finite and positive', () => {
  const base = { token: 't'.repeat(64), siteOrigin: 'http://127.0.0.1:4321' }
  assert.throws(() => createMdxBlockPreviewPlugin({ ...base, overlayLifetimeMs: 0 }), /bounded lifetime/)
  assert.throws(() => createMdxBlockPreviewPlugin({ ...base, overlayLifetimeMs: Infinity }), /bounded lifetime/)
  assert.throws(() => createMdxBlockPreviewPlugin({ ...base, renderTimeoutMs: -1 }), /render timeout/)
})

test('a preview route that never evaluates the source cannot confirm a render', async () => {
  await withTarget(async ({ file, source, request, invoke }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-unoverlaid', blockType: 'card', values: { title: 'Never rendered' } }],
    })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    const acknowledged = await invoke({ targetId: 'blocks', requestId: preview.body.requestId, rendered: true })
    assert.equal(acknowledged.status, 409)
    assert.equal(acknowledged.body.code, 'PREVIEW_NOT_OVERLAID')
    assert.match(acknowledged.body.error, /did not request this source module/)
    assert.equal(await readFile(file, 'utf8'), source)
    const reset = await request({ targetId: 'blocks', requestId: 'unoverlaid-reset', reset: true })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.changed, false)
    assert.equal(await readFile(file, 'utf8'), source)
  }, { autoAcknowledge: false })
})

test('a Content Layer import is rejected instead of claiming the overlay applied', async () => {
  await withTarget(async ({ file, source, plugin, request, invoke }) => {
    const preview = await request({
      targetId: 'blocks', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-content-layer', blockType: 'card', values: { title: 'Cached route' } }],
    })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    // Astro imports Content Layer entries under this dedicated query.
    plugin.transform.handler(source, `${file}?astroMarkdownContentEntry`)
    const acknowledged = await invoke({ targetId: 'blocks', requestId: preview.body.requestId, rendered: true })
    assert.equal(acknowledged.status, 409)
    assert.equal(acknowledged.body.code, 'CONTENT_LAYER_UNSUPPORTED')
    assert.match(acknowledged.body.error, /Content Layer/)
    assert.equal(await readFile(file, 'utf8'), source)
  }, { autoAcknowledge: false })
})
