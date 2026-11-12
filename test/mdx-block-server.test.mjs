import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEditorServer, PREVIEW_TTL_MS } from '../src/editor/server.mjs'
import { PREVIEW_OVERLAY_LIFETIME_MS, PREVIEW_RENDER_TIMEOUT_MS } from '../src/editor/mdx-block-preview.mjs'

const blockTypes = [{
  type: 'card', label: 'Card', componentName: 'Card', importSource: '../components/Card.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}]

async function makeRoot() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'avcms-block-server-')))
}

async function startServer(t, root, filePath, options = {}) {
  const server = createEditorServer({
    port: 0,
    previewRoutes: [{ id: 'blocks', label: 'Blocks', path: '/blocks/' }],
    mdxBlockTargets: [{ id: 'blocks', projectRoot: root, filePath, previewRouteId: 'blocks', blockTypes }],
    writeSource: async () => assert.fail('Existing MDX source must remain write-blocked.'),
    ...options,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': token }
  return { server, origin, headers }
}

test('inverse block edits do not produce a confirmable preview', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const response = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', hash: state.targets[0].hash, operations: [
      { action: 'set', blockId: 'one', prop: 'title', value: 'Temporary' },
      { action: 'set', blockId: 'one', prop: 'title', value: 'Before' },
    ] }),
  })
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.previewId, null)
  assert.equal(result.nextHash, state.targets[0].hash)
  assert.deepEqual(result.diffs, [])
  assert.equal(await readFile(file, 'utf8'), source)
})

test('block API returns path-free catalog, previews source blocks, and refuses existing-file writes', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  assert.equal(JSON.stringify(state).includes(root), false)
  assert.equal(state.targets[0].supported, true)
  assert.deepEqual(state.targets[0].blocks.map(({ id }) => id), ['one'])

  const operation = { action: 'add', blockType: 'card', values: { title: 'Added' } }
  const previewResponse = await fetch(`${origin}/api/mdx-blocks/preview`, { method: 'POST', headers, body: JSON.stringify({ targetId: 'blocks', operations: [operation], hash: state.targets[0].hash }) })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200, JSON.stringify(preview))
  assert.match(preview.diffs[0].diff.after, /<Card id="block-[a-f0-9]+" title="Added" \/>/)
  assert.equal(preview.sourceFormat, 'mdx')
  assert.equal(preview.operations[0].blockId.startsWith('block-'), true)
  assert.equal(await readFile(file, 'utf8'), source)

  const commit = await fetch(`${origin}/api/mdx-blocks/commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: preview.operations, hash: state.targets[0].hash, previewId: preview.previewId }),
  })
  assert.equal(commit.status, 409)
  assert.equal((await commit.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(await readFile(file, 'utf8'), source)

  const injected = await fetch(`${origin}/api/mdx-blocks/preview`, { method: 'POST', headers, body: JSON.stringify({ targetId: 'blocks', operations: [operation], hash: state.targets[0].hash, filePath: file }) })
  assert.equal(injected.status, 422)
})

test('block preview applies an ordered operation list against each intermediate source revision', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const operations = [
    { action: 'add', blockId: 'block-sequential', blockType: 'card', values: { title: 'Temporary' } },
    { action: 'set', blockId: 'block-sequential', prop: 'title', value: 'Final' },
  ]
  const response = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations, hash: state.targets[0].hash }),
  })
  const preview = await response.json()
  assert.equal(response.status, 200, JSON.stringify(preview))
  assert.equal(preview.diffs.length, 2)
  assert.equal(preview.blocks.find((block) => block.id === 'block-sequential').props.title, 'Final')
  assert.equal(preview.diffs[0].nextHash, preview.diffs[1].hash)
  assert.equal(await readFile(file, 'utf8'), source)
})

test('preview parses escaped quote, backslash, and newline values without writing source', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const value = 'Quote: "welcome" \\docs\\cms\nsecond line'
  const response = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({
      targetId: 'blocks',
      operations: [{ action: 'set', blockId: 'one', prop: 'title', value }],
      hash: state.targets[0].hash,
    }),
  })
  const preview = await response.json()
  assert.equal(response.status, 200, JSON.stringify(preview))
  assert.equal(preview.diffs[0].diff.after, `{${JSON.stringify(value)}}`)
  assert.equal(preview.blocks[0].props.title, value)
  assert.equal(await readFile(file, 'utf8'), source)
})

test('nested or inline configured calls make the complete target unsupported', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `import Card from '../components/Card.astro'\n\n<Other><Card id="nested" title="Unsupported" /></Other>\n`)
  const { origin } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  assert.equal(state.targets[0].supported, false)
  assert.equal(state.targets[0].code, 'UNSUPPORTED_BLOCK_PLACEMENT')
  assert.match(state.targets[0].error, /entire target is unsupported and remains read-only/)
  assert.equal(Object.hasOwn(state.targets[0], 'blocks'), false)
})

test('first block add previews a Markdown target virtually without renaming or writing', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = `# Existing Markdown\n\nA paragraph with Unicode — 東京.\n`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  assert.equal(state.targets[0].sourceFormat, 'md')
  const response = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Virtual conversion' } }], hash: state.targets[0].hash }),
  })
  const preview = await response.json()
  assert.equal(response.status, 200, JSON.stringify(preview))
  assert.equal(preview.virtualPreview, true)
  assert.equal(preview.sourceFormat, 'md')
  assert.equal(Object.hasOwn(preview, 'convertedToMdx'), false)
  assert.match(preview.diff.after, /<Card id="block-[a-f0-9]+" title="Virtual conversion" \/>/)
  assert.equal(await readFile(file, 'utf8'), source)
  await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['blocks.md'])
  const latest = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  assert.equal(latest.targets[0].sourceFormat, 'md')
  assert.equal(latest.targets[0].hash, state.targets[0].hash)

  const cancelled = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    // The obsolete pre-virtual-preview rollbackConversion field is optional.
    body: JSON.stringify({ targetId: 'blocks', previewId: preview.previewId, hash: state.targets[0].hash }),
  })
  const result = await cancelled.json()
  assert.equal(cancelled.status, 200, JSON.stringify(result))
  assert.equal(result.restoredMarkdown, false)
  assert.equal(result.virtualPreview, true)
  assert.equal(await readFile(file, 'utf8'), source)
  await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
})

test('block preview cancellation rejects a malformed legacy rollbackConversion field', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Cancellation source\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const preview = await (await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Malformed cancel' } }], hash: state.targets[0].hash }),
  })).json()
  const malformed = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', previewId: preview.previewId, hash: state.targets[0].hash, rollbackConversion: 'yes' }),
  })
  assert.equal(malformed.status, 422)
  assert.equal((await malformed.json()).code, 'INVALID_REQUEST')
  const cancelled = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', previewId: preview.previewId, hash: state.targets[0].hash }),
  })
  assert.equal(cancelled.status, 200)
  assert.equal(await readFile(file, 'utf8'), source)
})

test('a virtual Markdown preview can only produce a manual proposal and never commits source', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Proposal source\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const preview = await (await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Proposal only' } }], hash: state.targets[0].hash }),
  })).json()
  const commit = await fetch(`${origin}/api/mdx-blocks/commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: preview.operations, hash: state.targets[0].hash, previewId: preview.previewId }),
  })
  assert.equal(commit.status, 409)
  assert.equal((await commit.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(await readFile(file, 'utf8'), source)
  await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['blocks.md'])
})

test('cancelling and stale previews never write a Markdown target even after an external edit', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Stable source\n'
  const changed = '# Externally changed\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const preview = await (await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Pending' } }], hash: state.targets[0].hash }),
  })).json()
  await writeFile(file, changed)
  const cancelled = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', previewId: preview.previewId, hash: state.targets[0].hash, rollbackConversion: true }),
  })
  assert.equal(cancelled.status, 200)
  assert.equal(await readFile(file, 'utf8'), changed)
  const stale = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Stale' } }], hash: state.targets[0].hash }),
  })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'STALE_HASH')
  assert.equal(await readFile(file, 'utf8'), changed)
  await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
})

test('concurrent preview and cancellation requests leave the Markdown directory untouched', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Concurrent Markdown\n\nNo preview may create or remove a path.\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const previews = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: `Concurrent ${index}` } }], hash: state.targets[0].hash }),
  }).then((response) => response.json())))
  assert.equal(previews.every((preview) => preview.previewId), true)
  const cancellations = await Promise.all(previews.map((preview) => fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', previewId: preview.previewId, hash: state.targets[0].hash, rollbackConversion: true }),
  })))
  assert.equal(cancellations.every((response) => response.status === 200), true)
  assert.equal(await readFile(file, 'utf8'), source)
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['blocks.md'])
})

test('a virtual Markdown preview neither overwrites nor removes an existing .mdx sibling', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Original\n'
  const sibling = '# Existing MDX\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  await writeFile(`${file}x`, sibling)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const response = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'New' } }], hash: state.targets[0].hash }),
  })
  const preview = await response.json()
  assert.equal(response.status, 200, JSON.stringify(preview))
  assert.equal(preview.virtualPreview, true)
  assert.equal(await readFile(file, 'utf8'), source)
  assert.equal(await readFile(`${file}x`, 'utf8'), sibling)
})

test('an expired pending preview can be re-previewed and confirmed from the retained draft', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Before" />\n`
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file, { previewTtlMs: 40 })
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const operations = [{ action: 'set', blockId: 'one', prop: 'title', value: 'Retained draft' }]
  const preview = await (await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations, hash: state.targets[0].hash }),
  })).json()
  assert.ok(preview.previewId, 'the first preview must be confirmable')

  await new Promise((resolve) => setTimeout(resolve, 80))
  const expired = await fetch(`${origin}/api/mdx-blocks/commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: preview.operations, hash: state.targets[0].hash, previewId: preview.previewId }),
  })
  assert.equal(expired.status, 409)
  assert.equal((await expired.json()).code, 'PREVIEW_EXPIRED')
  assert.equal(await readFile(file, 'utf8'), source, 'an expired confirmation must never write source')

  // The editor recovers by re-previewing exactly the retained base revision and
  // operation list; the fresh preview then reaches the write policy instead of
  // expiring again, which is what makes the retained draft confirmable.
  const renewedResponse = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations, hash: state.targets[0].hash }),
  })
  const renewed = await renewedResponse.json()
  assert.equal(renewedResponse.status, 200, JSON.stringify(renewed))
  assert.ok(renewed.previewId && renewed.previewId !== preview.previewId)
  assert.deepEqual(renewed.operations, preview.operations)

  const commit = await fetch(`${origin}/api/mdx-blocks/commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: renewed.operations, hash: state.targets[0].hash, previewId: renewed.previewId }),
  })
  assert.equal(commit.status, 409)
  assert.equal((await commit.json()).code, 'SOURCE_REPLACEMENT_DISABLED', 'the renewed preview must pass expiry and reach the write policy')
  assert.equal(await readFile(file, 'utf8'), source)
})

test('the pending-preview TTL never expires before the acknowledged Astro overlay it authorizes', () => {
  assert.ok(PREVIEW_OVERLAY_LIFETIME_MS > 0)
  assert.ok(
    PREVIEW_TTL_MS >= PREVIEW_OVERLAY_LIFETIME_MS + PREVIEW_RENDER_TIMEOUT_MS,
    `pending previews (${PREVIEW_TTL_MS}ms) must cover an acknowledged overlay (${PREVIEW_OVERLAY_LIFETIME_MS}ms) plus the render grace (${PREVIEW_RENDER_TIMEOUT_MS}ms)`,
  )
})

test('block target configuration rejects unsupported extensions, path escape, and duplicate ids', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'page.mdx')
  await writeFile(file, '# Page\n')
  const target = { id: 'blocks', projectRoot: root, filePath: file, previewRouteId: 'blocks', blockTypes }
  const options = { previewRoutes: [{ id: 'blocks', label: 'Blocks', path: '/blocks/' }] }
  assert.throws(() => createEditorServer({ ...options, mdxBlockTargets: [{ ...target, filePath: path.join(root, 'page.astro') }] }), /Invalid trusted MDX block target/)
  assert.throws(() => createEditorServer({ ...options, mdxBlockTargets: [{ ...target, filePath: path.join(root, '..', 'outside.mdx') }] }), /inside a canonical project root/)
  assert.throws(() => createEditorServer({ ...options, mdxBlockTargets: [target, target] }), /Configured target ids must be unique/)
  assert.throws(() => createEditorServer({ ...options, previewTtlMs: 0 }), /previewTtlMs must be a bounded positive integer/)
  assert.throws(() => createEditorServer({ ...options, previewTtlMs: Infinity }), /previewTtlMs must be a bounded positive integer/)
})
