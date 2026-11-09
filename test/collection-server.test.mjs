import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createEditorServer } from '../src/editor/server.mjs'

const configSource = `import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro:content'
export const collections = {
  posts: defineCollection({ loader: glob({ base: './src/content/posts', pattern: '**/*.md' }), schema: z.object({
    title: z.string(), published: z.boolean(), category: z.enum(['note', 'news']), tags: z.array(z.string()),
  }) }),
  unsupported: defineCollection({ loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }), schema: z.object({ title: z.string() }) }),
  drafts: defineCollection({ loader: glob({ base: './src/content/drafts', pattern: '*.md' }), schema: z.object({ title: z.string(), order: z.number(), featured: z.boolean().default(false), summary: z.string().optional() }) }),
}`

const entrySource = `---\ntitle: "Old title" # keep this comment\npublished: false\ncategory: note\ntags: [one, two]\n---\n\nSynthetic body.\n`

async function makeProject(t) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'astro-collection-server-'))
  const configPath = path.join(projectRoot, 'src/content.config.mjs')
  const entryPath = path.join(projectRoot, 'src/content/posts/nested/one.md')
  await mkdir(path.dirname(configPath), { recursive: true })
  await mkdir(path.dirname(entryPath), { recursive: true })
  await mkdir(path.join(projectRoot, 'src/content/drafts'), { recursive: true })
  await writeFile(configPath, configSource)
  await writeFile(entryPath, entrySource)
  t.after(() => rm(projectRoot, { recursive: true, force: true }))
  return { projectRoot, configPath, entryPath }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  server.closeAllConnections?.()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function start(t, options) {
  const server = createEditorServer({ port: 0, ...options })
  const origin = await listen(server)
  t.after(() => close(server))
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  return { server, origin, token, headers: { origin, 'content-type': 'application/json', 'x-editor-token': token } }
}

function hash(source) {
  return createHash('sha256').update(source).digest('hex')
}

function operation(state, value = 'New title') {
  const collection = state.collections.find((item) => item.id === 'posts')
  const entry = collection.entries.find((item) => item.id === 'nested/one.md')
  return { collectionId: 'posts', entryId: entry.id, field: 'title', value, hash: entry.hash }
}

test('discovery endpoint exposes a bounded, path-free catalog and explicit unsupported/config-read-only states', async (t) => {
  const project = await makeProject(t)
  const { origin } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: 'src/content.config.mjs' })
  const response = await fetch(`${origin}/api/collections`)
  const body = await response.text()
  assert.equal(response.status, 200)
  assert.doesNotMatch(body, new RegExp(project.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(body, /content\.config\.mjs|src\/content\/posts/)
  const state = JSON.parse(body)
  assert.equal(state.configured, true)
  assert.equal(state.supported, true)
  assert.equal(state.collections.find((item) => item.id === 'posts').mode, 'editable')
  const posts = state.collections.find((item) => item.id === 'posts')
  assert.deepEqual(posts.entries.map((entry) => entry.id), ['nested/one.md'])
  assert.equal(posts.entries[0].hash, hash(entrySource))
  assert.equal(posts.fields.find((field) => field.name === 'title').editable, true)
  assert.equal(posts.fields.find((field) => field.name === 'tags').editable, false)
  assert.equal(posts.creationSupported, false, 'required array fields must keep entry creation disabled')
  assert.equal(posts.fields.find((field) => field.name === 'published').default, undefined)
  assert.equal(state.collections.find((item) => item.id === 'drafts').fields.find((field) => field.name === 'featured').default, false)
  const unsupported = state.collections.find((item) => item.id === 'unsupported')
  assert.equal(unsupported.mode, 'read-only')
  assert.match(unsupported.reason, /patterns are supported/)
  assert.deepEqual(unsupported.entries, [])
  assert.equal(state.configEditing.mode, 'creation-and-schema-extension')
  assert.equal(state.configEditing.creationSupported, true)
  assert.equal(state.configEditing.supported, true)
  const wrongOrigin = await fetch(`${origin}/api/collections`, { headers: { origin: 'http://localhost:4322' } })
  assert.equal(wrongOrigin.status, 403)
})

test('schema extension config API previews exact patch and writes only after a matching confirmation', async (t) => {
  const project = await makeProject(t)
  let writes = 0
  const { origin, headers } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath, writeSource: async (...args) => { writes += 1; const { writeSourceAtomically } = await import('../src/editor/source-write.mjs'); return writeSourceAtomically(...args) } })
  const before = await readFile(project.configPath, 'utf8')
  const hashValue = hash(before)
  const operation = { collection: 'posts', field: { name: 'summary', type: 'string', required: false }, hash: hashValue }
  const preview = await (await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  assert.equal(writes, 0)
  assert.deepEqual(preview.diff.before, '')
  assert.match(preview.diff.after, /summary/)
  assert.match(preview.diff.after, /z\.string\(\)\.optional\(\)/, 'required=false must generate an optional field')
  assert.equal(Object.hasOwn(preview, 'source'), false)
  assert.equal(JSON.stringify(preview).includes(project.projectRoot), false)
  assert.equal(await readFile(project.configPath, 'utf8'), before)
  const duplicateEnum = await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, field: { name: 'status', type: 'enum', required: true, values: ['draft', 'draft'] } }) })
  assert.equal(duplicateEnum.status, 422)
  const secondToken = (await (await fetch(`${origin}/api/session`)).json()).token
  assert.notEqual(secondToken, headers['x-editor-token'])
  const foreignSessionCommit = await fetch(`${origin}/api/collections/config/commit`, { method: 'POST', headers: { ...headers, 'x-editor-token': secondToken }, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(foreignSessionCommit.status, 409)
  assert.equal((await foreignSessionCommit.json()).code, 'PREVIEW_SESSION_MISMATCH')
  assert.equal(writes, 0)
  const invalid = await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, path: project.configPath }) })
  assert.equal(invalid.status, 422)
  const commit = await fetch(`${origin}/api/collections/config/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(commit.status, 200, JSON.stringify(await commit.json()))
  assert.equal(writes, 1)
  assert.match(await readFile(project.configPath, 'utf8'), /"summary": z\.string\(\)\.optional\(\)/)
})

test('static collection creation previews, validates and writes only the trusted config after same-session confirmation', async (t) => {
  const project = await makeProject(t)
  const collectionBase = path.join(project.projectRoot, 'src/content/notes')
  await mkdir(collectionBase, { recursive: true })
  let writes = 0
  const { origin, headers } = await start(t, {
    projectRoot: project.projectRoot,
    contentConfigPath: project.configPath,
    writeSource: async (...args) => { writes += 1; const { writeSourceAtomically } = await import('../src/editor/source-write.mjs'); return writeSourceAtomically(...args) },
  })
  const original = await readFile(project.configPath, 'utf8')
  const operation = {
    name: 'notes', base: './src/content/notes', pattern: '*.md', hash: hash(original),
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'summary', type: 'string', required: false },
      { name: 'kind', type: 'enum', values: ['note', 'story'], default: 'note' },
    ],
  }
  const previewResponse = await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json()
  assert.equal(writes, 0)
  assert.deepEqual(preview.diff.before, '')
  assert.match(preview.diff.after, /"notes": defineCollection/)
  assert.match(preview.diff.after, /"summary": z\.string\(\)\.optional\(\)/)
  assert.match(preview.diff.after, /z\.enum\(\["note","story"\]\)\.default\("note"\)/)
  assert.equal(Object.hasOwn(preview, 'source'), false)
  assert.equal(JSON.stringify(preview).includes(project.projectRoot), false)
  assert.equal(await readFile(project.configPath, 'utf8'), original)

  const pathInjection = await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, filePath: project.configPath }) })
  assert.equal(pathInjection.status, 422)
  const duplicateEnum = await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, fields: [{ name: 'kind', type: 'enum', values: ['note', 'note'] }] }) })
  assert.equal(duplicateEnum.status, 422)
  const unsupportedFieldOptions = await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, fields: [{ name: 'title', type: 'string', min: 1 }] }) })
  assert.equal(unsupportedFieldOptions.status, 422)
  const secondToken = (await (await fetch(`${origin}/api/session`)).json()).token
  const foreignCommit = await fetch(`${origin}/api/collections/config/create/commit`, { method: 'POST', headers: { ...headers, 'x-editor-token': secondToken }, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(foreignCommit.status, 409)
  assert.equal((await foreignCommit.json()).code, 'PREVIEW_SESSION_MISMATCH')
  assert.equal(writes, 0)

  const commit = await fetch(`${origin}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(commit.status, 200)
  assert.equal(writes, 1)
  const updated = await readFile(project.configPath, 'utf8')
  assert.equal(updated, original.slice(0, preview.diff.start) + preview.diff.after + original.slice(preview.diff.end))
  assert.equal(hash(updated), preview.nextHash)
  assert.match(updated, /"notes": defineCollection/)
  assert.equal(await readFile(project.entryPath, 'utf8'), entrySource)
  assert.deepEqual(await readdir(collectionBase), [], 'creation never adds content files')
  const catalog = await (await fetch(`${origin}/api/collections`)).json()
  assert.ok(catalog.collections.some((collection) => collection.id === 'notes' && collection.supported))
})

test('collection creation cancel, stale config and unsafe bases never write', async (t) => {
  const project = await makeProject(t)
  const collectionBase = path.join(project.projectRoot, 'src/content/notes')
  await mkdir(collectionBase, { recursive: true })
  let writes = 0
  const { origin, headers } = await start(t, {
    projectRoot: project.projectRoot,
    contentConfigPath: project.configPath,
    writeSource: async () => { writes += 1 },
  })
  const original = await readFile(project.configPath, 'utf8')
  const operation = { name: 'notes', base: './src/content/notes', pattern: '*.md', fields: [{ name: 'title', type: 'string' }], hash: hash(original) }
  const missingBase = await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, name: 'missingNotes', base: './src/content/missing-notes' }) })
  assert.equal(missingBase.status, 422)
  const outsideBase = path.join(project.projectRoot, 'outside-content')
  const linkedBase = path.join(project.projectRoot, 'src/content/linked-notes')
  await mkdir(outsideBase)
  await symlink(outsideBase, linkedBase)
  const symlinkBase = await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, name: 'linkedNotes', base: './src/content/linked-notes' }) })
  assert.equal(symlinkBase.status, 422)
  assert.equal(writes, 0)
  const cancelled = await (await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  await fetch(`${origin}/api/collections/config/create/cancel`, { method: 'POST', headers, body: JSON.stringify({ previewId: cancelled.previewId }) })
  const cancelledCommit = await fetch(`${origin}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: cancelled.previewId }) })
  assert.equal(cancelledCommit.status, 409)
  assert.equal(writes, 0)

  const stalePreview = await (await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  await writeFile(project.configPath, `${original}\n// external change\n`)
  const staleCommit = await fetch(`${origin}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: stalePreview.previewId }) })
  assert.equal(staleCommit.status, 409)
  assert.equal((await staleCommit.json()).code, 'STALE_CONFIG')
  assert.equal(writes, 0)
  assert.match(await readFile(project.configPath, 'utf8'), /external change/)
})

test('collection creation revalidates its base and reports a stale atomic write as 409', async (t) => {
  const project = await makeProject(t)
  const collectionBase = path.join(project.projectRoot, 'src/content/notes')
  const outsideBase = path.join(project.projectRoot, 'outside-notes')
  await mkdir(collectionBase, { recursive: true })
  await mkdir(outsideBase)
  let writes = 0
  const { origin, headers } = await start(t, {
    projectRoot: project.projectRoot,
    contentConfigPath: project.configPath,
    writeSource: async () => { writes += 1; const error = new Error('private config path'); error.code = 'STALE_HASH'; throw error },
  })
  const original = await readFile(project.configPath, 'utf8')
  const operation = { name: 'notes', base: './src/content/notes', pattern: '*.md', fields: [{ name: 'title', type: 'string' }], hash: hash(original) }
  const preview = await (await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  await rm(collectionBase, { recursive: true })
  await symlink(outsideBase, collectionBase)
  const unsafeCommit = await fetch(`${origin}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(unsafeCommit.status, 422)
  assert.equal(writes, 0, 'the revalidated symlink base must prevent reaching the writer')
  assert.equal(await readFile(project.configPath, 'utf8'), original)

  await rm(collectionBase)
  await mkdir(collectionBase)
  const writerPreview = await (await fetch(`${origin}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  const staleWrite = await fetch(`${origin}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: writerPreview.previewId }) })
  assert.equal(staleWrite.status, 409)
  const result = await staleWrite.json()
  assert.equal(result.code, 'STALE_CONFIG')
  assert.doesNotMatch(result.error, /private config path/)
  assert.equal(writes, 1)
  assert.equal(await readFile(project.configPath, 'utf8'), original)
})

test('schema config preview cancellation and stale config never invoke the writer', async (t) => {
  const project = await makeProject(t)
  let writes = 0
  const { origin, headers } = await start(t, {
    projectRoot: project.projectRoot,
    contentConfigPath: project.configPath,
    writeSource: async (...args) => { writes += 1; const { writeSourceAtomically } = await import('../src/editor/source-write.mjs'); return writeSourceAtomically(...args) },
  })
  const original = await readFile(project.configPath, 'utf8')
  const operation = { collection: 'posts', field: { name: 'summary', type: 'string', required: true }, hash: hash(original) }
  const cancelled = await (await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  const otherToken = (await (await fetch(`${origin}/api/session`)).json()).token
  const foreignCancel = await fetch(`${origin}/api/collections/config/cancel`, { method: 'POST', headers: { ...headers, 'x-editor-token': otherToken }, body: JSON.stringify({ previewId: cancelled.previewId }) })
  assert.equal(foreignCancel.status, 409)
  await fetch(`${origin}/api/collections/config/cancel`, { method: 'POST', headers, body: JSON.stringify({ previewId: cancelled.previewId }) })
  const cancelledCommit = await fetch(`${origin}/api/collections/config/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: cancelled.previewId }) })
  assert.equal(cancelledCommit.status, 409)
  assert.equal(writes, 0)

  const stalePreview = await (await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  await writeFile(project.configPath, original.replace('collections = {', 'collections = {\n  // external change'))
  const staleCommit = await fetch(`${origin}/api/collections/config/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: stalePreview.previewId }) })
  assert.equal(staleCommit.status, 409)
  assert.equal((await staleCommit.json()).code, 'STALE_CONFIG')
  assert.equal(writes, 0)
  assert.match(await readFile(project.configPath, 'utf8'), /external change/)
})

test('a stale atomic-writer result becomes a safe config conflict', async (t) => {
  const project = await makeProject(t)
  const { origin, headers } = await start(t, {
    projectRoot: project.projectRoot,
    contentConfigPath: project.configPath,
    writeSource: async () => { const error = new Error('private path detail'); error.code = 'STALE_HASH'; throw error },
  })
  const source = await readFile(project.configPath, 'utf8')
  const operation = { collection: 'posts', field: { name: 'summary', type: 'string', required: true }, hash: hash(source) }
  const preview = await (await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  const response = await fetch(`${origin}/api/collections/config/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(response.status, 409)
  const result = await response.json()
  assert.equal(result.code, 'STALE_CONFIG')
  assert.doesNotMatch(result.error, /private path detail/)
  assert.equal(await readFile(project.configPath, 'utf8'), source)
})

test('static glob entry creation previews YAML, validates values and exclusively creates only after confirmation', async (t) => {
  const project = await makeProject(t)
  let creations = 0
  const { origin, headers } = await start(t, {
    projectRoot: project.projectRoot,
    contentConfigPath: project.configPath,
    createSource: async (...args) => { creations += 1; const { createSourceExclusively } = await import('../src/editor/source-write.mjs'); return createSourceExclusively(...args) },
  })
  const catalog = await (await fetch(`${origin}/api/collections`)).json()
  const drafts = catalog.collections.find((item) => item.id === 'drafts')
  assert.equal(drafts.creationSupported, true)
  const operation = { collectionId: 'drafts', entryId: 'hello-world.md', values: { title: 'Hello — 東京', order: 4, summary: 'Optional text' }, hash: catalog.configHash }
  const previewResponse = await fetch(`${origin}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json()
  assert.deepEqual(preview.diff, { start: 0, end: 0, before: '', after: '---\ntitle: Hello — 東京\norder: 4\nfeatured: false\nsummary: Optional text\n---\n' })
  assert.equal(creations, 0)
  assert.deepEqual(await readdir(path.join(project.projectRoot, 'src/content/drafts')), [])

  const invalidValue = await fetch(`${origin}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, entryId: 'bad-name.md', values: { ...operation.values, order: 'four' } }) })
  assert.equal(invalidValue.status, 422)
  assert.equal((await invalidValue.json()).code, 'INVALID_FIELD_VALUE')
  const traversal = await fetch(`${origin}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify({ ...operation, entryId: '../escape.md' }) })
  assert.equal(traversal.status, 422)
  assert.equal(creations, 0)

  const foreignToken = (await (await fetch(`${origin}/api/session`)).json()).token
  const foreignCommit = await fetch(`${origin}/api/collections/create-entry/commit`, { method: 'POST', headers: { ...headers, 'x-editor-token': foreignToken }, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(foreignCommit.status, 409)
  assert.equal((await foreignCommit.json()).code, 'PREVIEW_SESSION_MISMATCH')
  assert.equal(creations, 0)

  const commit = await fetch(`${origin}/api/collections/create-entry/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(commit.status, 201)
  const createdPath = path.join(project.projectRoot, 'src/content/drafts/hello-world.md')
  const created = await readFile(createdPath, 'utf8')
  assert.equal(created, preview.diff.after)
  assert.equal(hash(created), preview.hash)
  assert.equal(creations, 1)

  const racedOperation = { ...operation, entryId: 'external-race.md' }
  const collisionPreview = await (await fetch(`${origin}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify(racedOperation) })).json()
  const racedPath = path.join(project.projectRoot, 'src/content/drafts/external-race.md')
  await writeFile(racedPath, 'external bytes')
  const collisionCommit = await fetch(`${origin}/api/collections/create-entry/commit`, { method: 'POST', headers, body: JSON.stringify({ ...racedOperation, previewId: collisionPreview.previewId }) })
  assert.equal(collisionCommit.status, 409)
  assert.equal((await collisionCommit.json()).code, 'ENTRY_EXISTS')
  assert.equal(await readFile(createdPath, 'utf8'), created, 'the first created entry must remain intact')
  assert.equal(await readFile(racedPath, 'utf8'), 'external bytes', 'a file created after preview must never be overwritten')
  assert.equal(creations, 1)
})

test('collection field preview is exact and path-free; cancel/no-confirm never writes, confirmation writes one scalar', async (t) => {
  const project = await makeProject(t)
  const { origin, headers } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath })
  const state = await (await fetch(`${origin}/api/collections`)).json()
  const edit = operation(state)
  const untouched = await readFile(project.entryPath, 'utf8')

  const wrongOrigin = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers: { ...headers, origin: 'http://localhost:4322' }, body: JSON.stringify(edit),
  })
  assert.equal(wrongOrigin.status, 403)
  const wrongToken = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers: { ...headers, 'x-editor-token': '0'.repeat(64) }, body: JSON.stringify(edit),
  })
  assert.equal(wrongToken.status, 403)

  const invalidPath = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify({ ...edit, entryId: '../../outside.md' }),
  })
  assert.equal(invalidPath.status, 422)
  const absolutePath = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify({ ...edit, entryId: 'C:/outside.md' }),
  })
  assert.equal(absolutePath.status, 422)
  const unsupportedField = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify({ ...edit, field: 'tags', value: 'not-an-array-edit' }),
  })
  assert.equal(unsupportedField.status, 422)
  assert.equal((await unsupportedField.json()).code, 'UNSUPPORTED_FIELD')
  assert.equal(await readFile(project.entryPath, 'utf8'), untouched, 'unsupported input must not write')

  const previewResponse = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify(edit),
  })
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json()
  assert.match(preview.previewId, /^[a-f0-9]{64}$/)
  assert.deepEqual(preview.diff, {
    start: untouched.indexOf('"Old title"'),
    end: untouched.indexOf('"Old title"') + '"Old title"'.length,
    before: '"Old title"',
    after: '"New title"',
  })
  assert.doesNotMatch(JSON.stringify(preview), /content\.config|src\/content|astro-collection-server/)
  assert.equal(await readFile(project.entryPath, 'utf8'), untouched, 'preview must not write')

  // Cancel means the client deliberately sends no commit request.
  assert.equal(await readFile(project.entryPath, 'utf8'), untouched, 'cancel must not write')

  const secondPreviewResponse = await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify(edit),
  })
  const secondPreview = await secondPreviewResponse.json()
  const commitResponse = await fetch(`${origin}/api/collections/commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...edit, previewId: secondPreview.previewId }),
  })
  assert.equal(commitResponse.status, 200)
  assert.deepEqual(await commitResponse.json(), {
    collectionId: 'posts', entryId: 'nested/one.md', field: 'title', hash: hash(untouched.replace('"Old title"', '"New title"')),
  })
  assert.equal(await readFile(project.entryPath, 'utf8'), untouched.replace('"Old title"', '"New title"'))
})

test('safe replacement mode blocks collection-field and schema commits with actionable 409 and no writer call', async (t) => {
  const project = await makeProject(t)
  let writes = 0
  const { origin, headers } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath, safeSourceReplacementMode: true, writeSource: async () => { writes++ } })
  const originalEntry = await readFile(project.entryPath, 'utf8')
  const originalConfig = await readFile(project.configPath, 'utf8')
  const state = await (await fetch(`${origin}/api/collections`)).json()
  const edit = operation(state)
  const fieldPreview = await (await fetch(`${origin}/api/collections/preview`, { method: 'POST', headers, body: JSON.stringify(edit) })).json()
  const fieldCommit = await fetch(`${origin}/api/collections/commit`, { method: 'POST', headers, body: JSON.stringify({ ...edit, previewId: fieldPreview.previewId }) })
  assert.equal(fieldCommit.status, 409)
  assert.equal((await fieldCommit.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(await readFile(project.entryPath, 'utf8'), originalEntry)

  const configHash = hash(originalConfig)
  const configOp = { collection: 'posts', field: { name: 'summary', type: 'string', required: false }, hash: configHash }
  const configPreview = await (await fetch(`${origin}/api/collections/config/preview`, { method: 'POST', headers, body: JSON.stringify(configOp) })).json()
  const configCommit = await fetch(`${origin}/api/collections/config/commit`, { method: 'POST', headers, body: JSON.stringify({ ...configOp, previewId: configPreview.previewId }) })
  assert.equal(configCommit.status, 409)
  const refusal = await configCommit.json()
  assert.equal(refusal.code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.match(refusal.error, /no changes were written/i)
  assert.equal(writes, 0)
  assert.equal(await readFile(project.configPath, 'utf8'), originalConfig)
})

test('safe replacement mode permits only exclusive new entry creation and preserves a colliding path', async (t) => {
  const project = await makeProject(t)
  let replacements = 0
  const { origin, headers } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath, safeSourceReplacementMode: true, writeSource: async () => { replacements++ } })
  const catalog = await (await fetch(`${origin}/api/collections`)).json()
  const operation = { collectionId: 'drafts', entryId: 'safe-new.md', values: { title: 'New', order: 1 }, hash: catalog.configHash }
  const preview = await (await fetch(`${origin}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })).json()
  const commit = await fetch(`${origin}/api/collections/create-entry/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(commit.status, 201)
  const created = path.join(project.projectRoot, 'src/content/drafts/safe-new.md')
  assert.equal(await readFile(created, 'utf8'), preview.diff.after)
  const collision = { ...operation, entryId: 'occupied.md' }
  const collisionPreview = await (await fetch(`${origin}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify(collision) })).json()
  const occupied = path.join(project.projectRoot, 'src/content/drafts/occupied.md')
  await writeFile(occupied, 'external bytes')
  const result = await fetch(`${origin}/api/collections/create-entry/commit`, { method: 'POST', headers, body: JSON.stringify({ ...collision, previewId: collisionPreview.previewId }) })
  assert.equal(result.status, 409)
  assert.equal(await readFile(occupied, 'utf8'), 'external bytes')
  assert.equal(replacements, 0)
})

test('stale external collection edit returns 409 and preserves external bytes', async (t) => {
  const project = await makeProject(t)
  const { origin, headers } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath })
  const state = await (await fetch(`${origin}/api/collections`)).json()
  const edit = operation(state)
  const preview = await (await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify(edit),
  })).json()
  const external = entrySource.replace('Old title', 'External title')
  await writeFile(project.entryPath, external)
  const response = await fetch(`${origin}/api/collections/commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...edit, previewId: preview.previewId }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'STALE_HASH')
  assert.equal(await readFile(project.entryPath, 'utf8'), external)
})

test('config changes after preview are rejected before writing the entry', async (t) => {
  const project = await makeProject(t)
  const { origin, headers } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath })
  const state = await (await fetch(`${origin}/api/collections`)).json()
  const edit = operation(state)
  const preview = await (await fetch(`${origin}/api/collections/preview`, {
    method: 'POST', headers, body: JSON.stringify(edit),
  })).json()
  const original = await readFile(project.entryPath, 'utf8')
  await writeFile(project.configPath, `${configSource}\n// synthetic config revision`)

  const response = await fetch(`${origin}/api/collections/commit`, {
    method: 'POST', headers, body: JSON.stringify({ ...edit, previewId: preview.previewId }),
  })

  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'STALE_CONFIG')
  assert.equal(await readFile(project.entryPath, 'utf8'), original)
})

test('symlinked collection bases and symlinked config files are read-only and never expose targets', async (t) => {
  const project = await makeProject(t)
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-collection-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(path.join(project.projectRoot, 'src/content'), { recursive: true })
  await rm(path.join(project.projectRoot, 'src/content/posts'), { recursive: true, force: true })
  await symlink(outside, path.join(project.projectRoot, 'src/content/posts'))
  await writeFile(path.join(outside, 'secret.md'), '---\ntitle: secret\n---\n')

  const { origin } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath })
  const state = await (await fetch(`${origin}/api/collections`)).json()
  const posts = state.collections.find((item) => item.id === 'posts')
  assert.equal(posts.mode, 'read-only')
  assert.match(posts.reason, /Symbolic links/)
  assert.deepEqual(posts.entries, [])
  assert.doesNotMatch(JSON.stringify(state), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  await rm(path.join(project.projectRoot, 'src/content/posts'), { recursive: true, force: true })
  await mkdir(path.join(project.projectRoot, 'src/content/posts/nested'), { recursive: true })
  await symlink(path.join(outside, 'secret.md'), path.join(project.projectRoot, 'src/content/posts/nested/linked.md'))
  const linkedEntryState = await (await fetch(`${origin}/api/collections`)).json()
  const linkedEntryPosts = linkedEntryState.collections.find((item) => item.id === 'posts')
  assert.equal(linkedEntryPosts.mode, 'read-only')
  assert.match(linkedEntryPosts.reason, /Symbolic links/)
  assert.deepEqual(linkedEntryPosts.entries, [])

  const linkedConfig = path.join(project.projectRoot, 'linked.config.mjs')
  await symlink(project.configPath, linkedConfig)
  const linkedServer = await start(t, { projectRoot: project.projectRoot, contentConfigPath: linkedConfig })
  const linkedStateText = await (await fetch(`${linkedServer.origin}/api/collections`)).text()
  const linkedState = JSON.parse(linkedStateText)
  assert.equal(linkedState.supported, false)
  assert.match(linkedState.reason, /Symbolic links/)
  assert.doesNotMatch(linkedStateText, /linked\.config|content\.config|astro-collection-server/)
})

test('unconfigured editor keeps collection discovery disabled and rejects partial trusted config', async (t) => {
  const { origin } = await start(t, {})
  assert.deepEqual(await (await fetch(`${origin}/api/collections`)).json(), { configured: false })
  assert.throws(() => createEditorServer({ projectRoot: '/tmp' }), /both trusted projectRoot and contentConfigPath/)
  assert.throws(() => createEditorServer({ projectRoot: '/tmp', contentConfigPath: '../outside.mjs' }), /trusted project-relative|in-root/)
})

test('collection discovery rejects configs above the aggregate collection limit', async (t) => {
  const project = await makeProject(t)
  const declarations = Array.from({ length: 65 }, (_, index) =>
    `collection${index}: defineCollection({ loader: glob({ base: './src/content/posts', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) })`).join(',\n')
  await writeFile(project.configPath, `import { defineCollection } from 'astro:content'\nimport { glob } from 'astro/loaders'\nimport { z } from 'astro:content'\nexport const collections = {\n${declarations}\n}`)
  const { origin } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath })
  const state = await (await fetch(`${origin}/api/collections`)).json()
  assert.equal(state.supported, false)
  assert.match(state.reason, /64-collection discovery limit/)
  assert.deepEqual(state.collections, [])
})

test('collection discovery enforces aggregate entry budgets across repeated collection roots', async (t) => {
  const project = await makeProject(t)
  const base = path.join(project.projectRoot, 'src/content/posts')
  await mkdir(base, { recursive: true })
  for (let index = 0; index < 249; index += 1) {
    await writeFile(path.join(base, `entry-${String(index).padStart(3, '0')}.md`), entrySource)
  }
  const declarations = ['first', 'second', 'third'].map((name) =>
    `${name}: defineCollection({ loader: glob({ base: './src/content/posts', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) })`).join(',\n')
  await writeFile(project.configPath, `import { defineCollection } from 'astro:content'\nimport { glob } from 'astro/loaders'\nimport { z } from 'astro:content'\nexport const collections = {\n${declarations}\n}`)
  const { origin } = await start(t, { projectRoot: project.projectRoot, contentConfigPath: project.configPath })
  const state = await (await fetch(`${origin}/api/collections`)).json()
  assert.equal(state.collections[0].entries.length, 250)
  assert.equal(state.collections[1].entries.length, 250)
  assert.equal(state.collections[2].mode, 'read-only')
  assert.match(state.collections[2].reason, /Aggregate collection discovery limits/)
})
