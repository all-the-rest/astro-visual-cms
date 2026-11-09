import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEditorServer } from '../src/editor/server.mjs'
import { writeSourceAtomically } from '../src/editor/source-write.mjs'

test('editor entrypoint accepts only a configured toolbar route ID and health probes require the preview origin', async (t) => {
  const server = createEditorServer({ port: 0, sitePort: 4321, previewRoutes: [{ id: 'references', label: 'Referenzen', path: '/referenzen/' }] })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const configured = await (await fetch(`${origin}/?route=references`)).text()
  assert.match(configured, /const requestedPreviewRouteId = "references"/)
  assert.equal(configured.includes('/referenzen/'), true)
  const unmapped = await (await fetch(`${origin}/?route=not-configured`)).text()
  assert.match(unmapped, /const requestedPreviewRouteId = null/)
  assert.equal(unmapped.includes('not-configured'), false)
  assert.equal((await fetch(`${origin}/?route=references&path=%2Fetc%2Fpasswd`)).status, 404)
  const allowedHealth = await fetch(`${origin}/api/health`, { headers: { origin: 'http://127.0.0.1:4321' } })
  assert.equal(allowedHealth.status, 204)
  assert.equal(allowedHealth.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4321')
  assert.equal((await fetch(`${origin}/api/health`)).status, 403)
  assert.equal((await fetch(`${origin}/api/health`, { headers: { origin: 'http://localhost:4321' } })).status, 403)
})

test('configured MDX target exposes path-free state and requires a matching explicit commit', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdx-target-'))
  const file = path.join(root, 'src/page.mdx')
  await mkdir(path.dirname(file), { recursive: true })
  const source = `import Card from '../components/Card.astro'\n\n<Card id="hero" title="Old" />\n`
  await writeFile(file, source)
  t.after(() => rm(root, { recursive: true, force: true }))
  let writeCalls = 0
  const server = createEditorServer({ port: 0, mdxComponentTargets: [{ id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }], writeSource: async (...args) => { writeCalls += 1; return writeSourceAtomically(...args) } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': (await (await fetch(`${origin}/api/session`)).json()).token }
  const state = await (await fetch(`${origin}/api/mdx-components`)).json()
  assert.equal(JSON.stringify(state).includes(root), false)
  assert.equal(state.targets[0].instances[0].props.title, 'Old')
  const op = { targetId: 'page', instanceId: 'hero', prop: 'title', value: 'literal </script>', hash: state.targets[0].hash }
  const previewResponse = await fetch(`${origin}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify(op) })
  const preview = await previewResponse.json()
  assert.equal(preview.diff.before, '"Old"')
  assert.equal(await readFile(file, 'utf8'), source)
  assert.equal(writeCalls, 0)
  const unauthenticated = await fetch(`${origin}/api/mdx-components/preview`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(op) })
  assert.equal(unauthenticated.status, 403)
  const pathInjection = await fetch(`${origin}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify({ ...op, filePath: file }) })
  assert.equal(pathInjection.status, 422)
  const canceled = await fetch(`${origin}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...op, previewId: '0'.repeat(64) }) })
  assert.equal(canceled.status, 409)
  assert.equal(writeCalls, 0)
  const committed = await fetch(`${origin}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...op, previewId: preview.previewId }) })
  assert.equal(committed.status, 200)
  assert.equal(await readFile(file, 'utf8'), source.replace('title="Old"', 'title="literal </script>"'))
  assert.equal(writeCalls, 1)
})

test('stale MDX source and unsupported syntax never reach the writer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdx-stale-'))
  const file = path.join(root, 'page.mdx')
  const source = `import Card from '../components/Card.astro'\n\n<Card id="hero" title="Old" />\n`
  await writeFile(file, source)
  t.after(() => rm(root, { recursive: true, force: true }))
  let writeCalls = 0
  const server = createEditorServer({ port: 0, mdxComponentTargets: [{ id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }], writeSource: async () => { writeCalls += 1 } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': (await (await fetch(`${origin}/api/session`)).json()).token }
  const catalog = await (await fetch(`${origin}/api/mdx-components`)).json()
  const operation = { targetId: 'page', instanceId: 'hero', prop: 'title', value: 'new', hash: catalog.targets[0].hash }
  const preview = await (await fetch(`${origin}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  await writeFile(file, source.replace('title="Old"', 'title={dynamic}'))
  const commit = await fetch(`${origin}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(commit.status, 409)
  assert.equal((await commit.json()).code, 'STALE_HASH')
  assert.equal(writeCalls, 0)
  assert.equal((await readFile(file, 'utf8')), source.replace('title="Old"', 'title={dynamic}'))
})

test('unsupported configured MDX remains read-only and does not disclose its path', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdx-unsupported-'))
  const file = path.join(root, 'page.mdx')
  await writeFile(file, `import Card from '../components/Card.astro'\n\n<Card id="hero" title={dynamic} />\n`)
  t.after(() => rm(root, { recursive: true, force: true }))
  let writeCalls = 0
  const server = createEditorServer({ port: 0, mdxComponentTargets: [{ id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }], writeSource: async () => { writeCalls += 1 } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': (await (await fetch(`${origin}/api/session`)).json()).token }
  const stateResponse = await fetch(`${origin}/api/mdx-components`)
  const state = await stateResponse.json()
  assert.equal(state.targets[0].supported, false)
  assert.equal(JSON.stringify(state).includes(root), false)
  const source = await readFile(file, 'utf8')
  const hash = createHash('sha256').update(source, 'utf8').digest('hex')
  const preview = await fetch(`${origin}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify({ targetId: 'page', instanceId: 'hero', prop: 'title', value: 'new', hash }) })
  assert.equal(preview.status, 422)
  assert.equal(writeCalls, 0)
})

test('invalid UTF-8 source is rejected without normalization or writes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdx-invalid-utf8-'))
  const file = path.join(root, 'page.mdx')
  const bytes = Buffer.from([0x69, 0x6d, 0x70, 0xff, 0x72, 0x74])
  await writeFile(file, bytes)
  t.after(() => rm(root, { recursive: true, force: true }))
  let writeCalls = 0
  const server = createEditorServer({ port: 0, mdxComponentTargets: [{ id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }], writeSource: async () => { writeCalls += 1 } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const state = await (await fetch(`${origin}/api/mdx-components`)).json()
  assert.equal(state.targets[0].supported, false)
  assert.equal(state.targets[0].error, 'Configured MDX target is not valid UTF-8 source.')
  assert.deepEqual(await readFile(file), bytes)
  assert.equal(writeCalls, 0)
})

test('MDX target config refuses symlinks and duplicate target ids', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdx-path-'))
  const file = path.join(root, 'page.mdx')
  const link = path.join(root, 'link.mdx')
  await writeFile(file, `import Card from '../components/Card.astro'\n\n<Card id="hero" title="Old" />\n`)
  await symlink(file, link)
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = { id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }
  assert.throws(() => createEditorServer({ mdxComponentTargets: [target, { ...target, filePath: link }] }), /Symbolic links/)
  assert.throws(() => createEditorServer({ mdxComponentTargets: [target, target] }), /ids must be unique/)
})
