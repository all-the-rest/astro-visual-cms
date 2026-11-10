import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEditorServer } from '../src/editor/server.mjs'

const TARGET = 'One configured fictional sentence.'

test('read-only Markdown draft catalog and preview expose only exact text ranges and never write', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'markdown-visual-draft-'))
  const file = path.join(root, 'src', 'showcase.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `---\ntitle: "Synthetic"\n---\nimport Card from './Card.astro'\n\n<Card prop={opaqueValue} />\n\nOther prose stays untouched.\n\n${TARGET}\n\n<Card slot="named">Nested text</Card>\n`
  await writeFile(file, source)
  t.after(() => rm(root, { recursive: true, force: true }))
  let writes = 0
  const server = createEditorServer({
    port: 0,
    markdownDraftTargets: [{ id: 'showcase', projectRoot: root, filePath: file, instanceId: 'paragraph-one', text: TARGET }],
    writeSource: async () => { writes += 1 },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': token }

  const catalogResponse = await fetch(`${origin}/api/markdown-drafts`)
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json()
  assert.deepEqual(catalog, {
    configured: true,
    targets: [{
      id: 'showcase', kind: 'markdown-text-range', supported: true,
      hash: createHash('sha256').update(source).digest('hex'),
      instances: [{ id: 'paragraph-one', text: TARGET }],
    }],
  })
  assert.equal(JSON.stringify(catalog).includes(root), false)
  assert.equal(JSON.stringify(catalog).includes(source), false)
  assert.equal(await readFile(file, 'utf8'), source)

  const noAuth = await fetch(`${origin}/api/markdown-drafts/preview`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ targetId: 'showcase', instanceId: 'paragraph-one', value: TARGET, hash: catalog.targets[0].hash }),
  })
  assert.equal(noAuth.status, 403)

  const noOpResponse = await fetch(`${origin}/api/markdown-drafts/preview`, {
    method: 'POST', headers, body: JSON.stringify({ targetId: 'showcase', instanceId: 'paragraph-one', value: TARGET, hash: catalog.targets[0].hash }),
  })
  assert.equal(noOpResponse.status, 200)
  const noOp = await noOpResponse.json()
  assert.deepEqual(noOp.diff, null)
  assert.equal(noOp.hash, catalog.targets[0].hash)
  assert.equal(noOp.nextHash, noOp.hash)

  const value = 'Revised fictional sentence.'
  const changedResponse = await fetch(`${origin}/api/markdown-drafts/preview`, {
    method: 'POST', headers, body: JSON.stringify({ targetId: 'showcase', instanceId: 'paragraph-one', value, hash: catalog.targets[0].hash }),
  })
  assert.equal(changedResponse.status, 200)
  const changed = await changedResponse.json()
  assert.deepEqual(changed.diff, {
    start: source.indexOf(TARGET), end: source.indexOf(TARGET) + TARGET.length, before: TARGET, after: value,
  })
  assert.equal(JSON.stringify(changed).includes(root), false)
  assert.equal(JSON.stringify(changed).includes(source), false)
  assert.equal(await readFile(file, 'utf8'), source)
  assert.equal(writes, 0)
  assert.equal((await fetch(`${origin}/api/markdown-drafts/commit`, { method: 'POST', headers, body: '{}' })).status, 404)

  const external = source.replace('Other prose stays untouched.', 'Externally changed prose stays untouched.')
  await writeFile(file, external)
  const stale = await fetch(`${origin}/api/markdown-drafts/preview`, {
    method: 'POST', headers, body: JSON.stringify({ targetId: 'showcase', instanceId: 'paragraph-one', value, hash: catalog.targets[0].hash }),
  })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'STALE_HASH')
  assert.equal(await readFile(file, 'utf8'), external)

  const duplicated = `${external}\n${TARGET}\n`
  await writeFile(file, duplicated)
  const unsupported = await (await fetch(`${origin}/api/markdown-drafts`)).json()
  assert.equal(unsupported.targets[0].supported, false)
  assert.equal(unsupported.targets[0].code, 'UNSUPPORTED_MARKDOWN_MAPPING')
  assert.equal(unsupported.targets[0].hash, createHash('sha256').update(duplicated).digest('hex'))
  const duplicatePreview = await fetch(`${origin}/api/markdown-drafts/preview`, {
    method: 'POST', headers, body: JSON.stringify({ targetId: 'showcase', instanceId: 'paragraph-one', value, hash: unsupported.targets[0].hash }),
  })
  assert.equal(duplicatePreview.status, 422)
  assert.equal((await duplicatePreview.json()).code, 'UNSUPPORTED_MARKDOWN_MAPPING')
  assert.equal(await readFile(file, 'utf8'), duplicated)
  assert.equal(writes, 0)
})

test('Markdown draft target rejects symlinked paths at startup', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'markdown-visual-draft-link-'))
  const real = path.join(root, 'real.mdx')
  const link = path.join(root, 'linked.mdx')
  await writeFile(real, `${TARGET}\n`)
  await symlink(real, link)
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.throws(() => createEditorServer({
    port: 0,
    markdownDraftTargets: [{ id: 'linked', projectRoot: root, filePath: link, instanceId: 'paragraph', text: TARGET }],
  }), /Symbolic links in configured Markdown draft paths/)
})
