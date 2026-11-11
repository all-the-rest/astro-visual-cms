import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEditorServer } from '../src/editor/server.mjs'

const blockTypes = [{
  type: 'card', label: 'Card', componentName: 'Card', importSource: '../components/Card.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}]

async function makeRoot() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'avcms-block-server-')))
}

async function startServer(t, root, filePath) {
  const server = createEditorServer({
    port: 0,
    previewRoutes: [{ id: 'blocks', label: 'Blocks', path: '/blocks/' }],
    mdxBlockTargets: [{ id: 'blocks', projectRoot: root, filePath, previewRouteId: 'blocks', blockTypes }],
    writeSource: async () => assert.fail('Existing MDX source must remain write-blocked.'),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': token }
  return { server, origin, headers }
}

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

test('first block add transparently renames one Markdown target without changing bytes', async (t) => {
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
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Background conversion' } }], hash: state.targets[0].hash }),
  })
  const preview = await response.json()
  assert.equal(response.status, 200, JSON.stringify(preview))
  assert.equal(preview.convertedToMdx, true)
  assert.equal(preview.diff.before, '')
  assert.equal(await readFile(`${file}x`, 'utf8'), source)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  const latest = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  assert.equal(latest.targets[0].sourceFormat, 'mdx')
  assert.equal(latest.targets[0].hash, state.targets[0].hash)
})

test('cancelling an unrenderable first-block preview restores the original Markdown path and bytes', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Existing Markdown\n\nUnchanged bytes — 東京.\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const previewResponse = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'Preview fails in Astro' } }], hash: state.targets[0].hash }),
  })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200, JSON.stringify(preview))
  assert.equal(preview.convertedToMdx, true)
  assert.equal(await readFile(`${file}x`, 'utf8'), source)

  const cancelled = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', previewId: preview.previewId, hash: state.targets[0].hash, rollbackConversion: true }),
  })
  const result = await cancelled.json()
  assert.equal(cancelled.status, 200, JSON.stringify(result))
  assert.equal(result.restoredMarkdown, true)
  assert.equal(await readFile(file, 'utf8'), source)
  await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
  assert.equal((await (await fetch(`${origin}/api/mdx-blocks`)).json()).targets[0].sourceFormat, 'md')
})

test('a block preview token cannot cancel or roll back a different configured target', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = path.join(root, 'src/pages/first.md')
  const second = path.join(root, 'src/pages/second.md')
  const source = '# Identical source\n'
  await mkdir(path.dirname(first), { recursive: true })
  await writeFile(first, source)
  await writeFile(second, source)
  const server = createEditorServer({
    port: 0,
    previewRoutes: [{ id: 'first', label: 'First', path: '/first/' }, { id: 'second', label: 'Second', path: '/second/' }],
    mdxBlockTargets: [
      { id: 'first', projectRoot: root, filePath: first, previewRouteId: 'first', blockTypes },
      { id: 'second', projectRoot: root, filePath: second, previewRouteId: 'second', blockTypes },
    ],
    writeSource: async () => assert.fail('Existing MDX source must remain write-blocked.'),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': token }
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const previewResponse = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'first', operations: [{ action: 'add', blockType: 'card', values: { title: 'First target' } }], hash: state.targets[0].hash }),
  })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status, 200, JSON.stringify(preview))
  const wrongTargetCancel = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'second', previewId: preview.previewId, hash: state.targets[0].hash, rollbackConversion: true }),
  })
  assert.equal(wrongTargetCancel.status, 409)
  assert.equal(await readFile(`${first}x`, 'utf8'), source)
  assert.equal(await readFile(second, 'utf8'), source)
  const correctTargetCancel = await fetch(`${origin}/api/mdx-blocks/cancel`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'first', previewId: preview.previewId, hash: state.targets[0].hash, rollbackConversion: true }),
  })
  assert.equal(correctTargetCancel.status, 200, 'a mismatched cancellation must not consume the original token')
  assert.equal(await readFile(first, 'utf8'), source)
  await assert.rejects(readFile(`${first}x`), { code: 'ENOENT' })
})

test('Markdown background conversion refuses MDX collisions and keeps the original file', async (t) => {
  const root = await makeRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src/pages/blocks.md')
  const source = '# Original\n'
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  await writeFile(`${file}x`, '# Existing MDX\n')
  const { origin, headers } = await startServer(t, root, file)
  const state = await (await fetch(`${origin}/api/mdx-blocks`)).json()
  const response = await fetch(`${origin}/api/mdx-blocks/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ targetId: 'blocks', operations: [{ action: 'add', blockType: 'card', values: { title: 'New' } }], hash: state.targets[0].hash }),
  })
  assert.equal(response.status, 422)
  assert.equal((await response.json()).code, 'MDX_RENAME_COLLISION')
  assert.equal(await readFile(file, 'utf8'), source)
  assert.equal(await readFile(`${file}x`, 'utf8'), '# Existing MDX\n')
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
})
