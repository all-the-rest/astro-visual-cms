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
  const server = createEditorServer({ port: 0, safeSourceReplacementMode: false, mdxComponentTargets: [{ id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }], writeSource: async (...args) => { writeCalls += 1; return writeSourceAtomically(...args) } })
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

test('default replacement policy refuses MDX component commit without invoking injected writer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdx-safe-mode-'))
  const file = path.join(root, 'page.mdx')
  const source = `import Card from '../components/Card.astro'\n\n<Card id="hero" title="Old" />\n`
  await writeFile(file, source)
  let writes = 0
  const server = createEditorServer({ port: 0, mdxComponentTargets: [{ id: 'page', projectRoot: root, filePath: file, importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] }], writeSource: async () => { writes++ } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': (await (await fetch(`${origin}/api/session`)).json()).token }
  const state = await (await fetch(`${origin}/api/mdx-components`)).json()
  const op = { targetId: 'page', instanceId: 'hero', prop: 'title', value: 'New', hash: state.targets[0].hash }
  const preview = await (await fetch(`${origin}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify(op) })).json()
  const commit = await fetch(`${origin}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...op, previewId: preview.previewId }) })
  const refusal = await commit.json()
  assert.equal(commit.status, 409, JSON.stringify(refusal))
  assert.equal(refusal.code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(writes, 0)
  assert.equal(await readFile(file, 'utf8'), source)
})

test('Astro internal gallery endpoint enforces preview session, exact replay, stale hash, and writes only on confirmation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-gallery-target-'))
  const file = path.join(root, 'src/Galerie.astro')
  const source = `---\ntype Image = { name: string; alt: string };\nconst imageNames: Image[] = [\n  { name: "a", alt: "A" },\n  { name: "b", alt: "B" },\n]\n---\n`
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source)
  t.after(() => rm(root, { recursive: true, force: true }))
  let writes = 0
  const server = createEditorServer({ port: 0, safeSourceReplacementMode: false, astroGalleryTargets: [{ id: 'gal', projectRoot: root, filePath: file, variableName: 'imageNames', identityProperty: 'name', labelProperty: 'alt' }], writeSource: async (...args) => { writes++; return writeSourceAtomically(...args) } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = async () => (await (await fetch(`${origin}/api/session`)).json()).token
  const headers = (value) => ({ origin, 'content-type': 'application/json', 'x-editor-token': value })
  const state = await (await fetch(`${origin}/api/astro-galleries`)).json()
  assert.deepEqual(state.targets[0].order, ['a', 'b'])
  const op = { targetId: 'gal', order: ['b', 'a'], hash: state.targets[0].hash }
  const preview = await (await fetch(`${origin}/api/astro-galleries/preview`, { method: 'POST', headers: headers(await token()), body: JSON.stringify(op) })).json()
  const foreign = await fetch(`${origin}/api/astro-galleries/commit`, { method: 'POST', headers: headers(await token()), body: JSON.stringify({ ...op, previewId: preview.previewId }) })
  assert.equal(foreign.status, 409); assert.equal((await foreign.json()).code, 'PREVIEW_SESSION_MISMATCH')
  const session = (await (await fetch(`${origin}/api/session`)).json()).token
  const own = await (await fetch(`${origin}/api/astro-galleries/preview`, { method: 'POST', headers: headers(session), body: JSON.stringify(op) })).json()
  const mismatch = await fetch(`${origin}/api/astro-galleries/commit`, { method: 'POST', headers: headers(session), body: JSON.stringify({ ...op, order: ['a', 'b'], previewId: own.previewId }) })
  assert.equal(mismatch.status, 409); assert.equal((await readFile(file, 'utf8')), source)
  const stalePreview = await (await fetch(`${origin}/api/astro-galleries/preview`, { method: 'POST', headers: headers(session), body: JSON.stringify(op) })).json()
  await writeFile(file, source.replace('alt: "A"', 'alt: "External"'))
  const stale = await fetch(`${origin}/api/astro-galleries/commit`, { method: 'POST', headers: headers(session), body: JSON.stringify({ ...op, previewId: stalePreview.previewId }) })
  assert.equal(stale.status, 409); assert.equal(writes, 0)
  const latest = await (await fetch(`${origin}/api/astro-galleries`)).json()
  const freshOp = { ...op, hash: latest.targets[0].hash }
  const fresh = await (await fetch(`${origin}/api/astro-galleries/preview`, { method: 'POST', headers: headers(session), body: JSON.stringify(freshOp) })).json()
  const commit = await fetch(`${origin}/api/astro-galleries/commit`, { method: 'POST', headers: headers(session), body: JSON.stringify({ ...freshOp, previewId: fresh.previewId }) })
  assert.equal(commit.status, 200); assert.equal(writes, 1)
  const committedBytes = await readFile(file, 'utf8')
  const replay = await fetch(`${origin}/api/astro-galleries/commit`, { method: 'POST', headers: headers(session), body: JSON.stringify({ ...freshOp, previewId: fresh.previewId }) })
  assert.equal(replay.status, 409); assert.equal(await readFile(file, 'utf8'), committedBytes); assert.equal(writes, 1)
})

test('default replacement policy refuses Astro gallery commit and preserves source bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-gallery-safe-mode-'))
  const file = path.join(root, 'Galerie.astro')
  const source = `---\nconst imageNames = [{ name: "a", alt: "A" }, { name: "b", alt: "B" }]\n---\n`
  await writeFile(file, source)
  let writes = 0
  const server = createEditorServer({ port: 0, astroGalleryTargets: [{ id: 'gal', projectRoot: root, filePath: file, variableName: 'imageNames', identityProperty: 'name', labelProperty: 'alt' }], writeSource: async () => { writes++ } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': (await (await fetch(`${origin}/api/session`)).json()).token }
  const state = await (await fetch(`${origin}/api/astro-galleries`)).json()
  const op = { targetId: 'gal', order: ['b', 'a'], hash: state.targets[0].hash }
  const preview = await (await fetch(`${origin}/api/astro-galleries/preview`, { method: 'POST', headers, body: JSON.stringify(op) })).json()
  const commit = await fetch(`${origin}/api/astro-galleries/commit`, { method: 'POST', headers, body: JSON.stringify({ ...op, previewId: preview.previewId }) })
  assert.equal(commit.status, 409)
  assert.equal((await commit.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(writes, 0)
  assert.equal(await readFile(file, 'utf8'), source)
})

test('Astro target configuration and source safety fail closed', async (t) => {
  assert.throws(() => createEditorServer({ astroGalleryTargets: Array.from({ length: 17 }, (_, i) => ({ id: `g${i}`, projectRoot: '/tmp', filePath: '/tmp/a.astro', variableName: 'images' })) }), /at most 16/)
  const root = await mkdtemp(path.join(tmpdir(), 'astro-gallery-safe-')); t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.astro'), target = { id: 'gal', projectRoot: root, filePath: file, variableName: 'images' }
  assert.throws(() => createEditorServer({ astroGalleryTargets: [{ ...target, untrusted: true }] }), /Invalid trusted Astro/)
  await writeFile(file, '---\nconst images = [{ name: "a", alt: "A" }]\n---\n')
  const link = path.join(root, 'link.astro'); await symlink(file, link)
  const linkedServer = createEditorServer({ port: 0, astroGalleryTargets: [{ ...target, filePath: link }] })
  await new Promise((resolve) => linkedServer.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => linkedServer.close(resolve)))
  const linkedOrigin = `http://127.0.0.1:${linkedServer.address().port}`
  const linked = await (await fetch(`${linkedOrigin}/api/astro-galleries`)).json()
  assert.equal(linked.targets[0].supported, false)
  const linkedToken = (await (await fetch(`${linkedOrigin}/api/session`)).json()).token
  const unsafePreview = await fetch(`${linkedOrigin}/api/astro-galleries/preview`, {
    method: 'POST',
    headers: { origin: linkedOrigin, 'content-type': 'application/json', 'x-editor-token': linkedToken },
    body: JSON.stringify({ targetId: 'gal', order: ['a'], hash: '0'.repeat(64) }),
  })
  assert.equal(unsafePreview.status, 422)
  const unsafeBody = await unsafePreview.json()
  assert.equal(unsafeBody.code, 'UNSAFE_MDX_PATH')
  assert.equal(JSON.stringify(unsafeBody).includes(root), false)
  await rm(link)
  await writeFile(file, Buffer.from([0xff, 0xfe]))
  const badEncoding = await (await fetch(`http://127.0.0.1:${linkedServer.address().port}/api/astro-galleries`)).json()
  assert.equal(badEncoding.targets[0].supported, false)
  await writeFile(file, 'x'.repeat(1024 * 1024 + 1))
  const oversized = await (await fetch(`http://127.0.0.1:${linkedServer.address().port}/api/astro-galleries`)).json()
  assert.equal(oversized.targets[0].supported, false)
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
