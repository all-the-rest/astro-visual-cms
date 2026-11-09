import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const repo = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(path.join(os.tmpdir(), 'avcms-package-smoke-'))
let child
let astro
const stop = async (processHandle) => {
  if (!processHandle) return
  if (process.platform !== 'win32') {
    try { process.kill(-processHandle.pid, 'SIGTERM') } catch {}
    if (processHandle.exitCode === null) await Promise.race([
      new Promise((resolve) => processHandle.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ])
    try { process.kill(-processHandle.pid, 'SIGKILL') } catch {}
  } else if (processHandle.exitCode === null) {
    processHandle.kill('SIGTERM')
    await new Promise((resolve) => processHandle.once('exit', resolve))
  }
}
const stopTempProcesses = async () => {
  if (process.platform !== 'linux') return
  const find = async () => {
    const processes = []
    for (const pid of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))) {
      try {
        const command = (await readFile(`/proc/${pid}/cmdline`)).toString().replaceAll('\0', ' ')
        if (Number(pid) !== process.pid && command.includes(temp)) processes.push(Number(pid))
      } catch {}
    }
    return processes
  }
  let processes = await find()
  for (const pid of processes) { try { process.kill(pid, 'SIGTERM') } catch {} }
  if (processes.length) await new Promise((resolve) => setTimeout(resolve, 250))
  processes = await find()
  for (const pid of processes) { try { process.kill(pid, 'SIGKILL') } catch {} }
}
try {
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: repo, encoding: 'utf8' })
  assert.equal(pack.status, 0, pack.stderr)
  const packResult = JSON.parse(pack.stdout)
  const packed = Array.isArray(packResult) ? packResult[0] : packResult['@astro-visual-cms/editor']
  const names = packed.files.map((file) => file.path)
  for (const required of ['LICENSE', 'src/editor/astro-integration.mjs', 'src/editor/toolbar-app.mjs', 'src/editor/server.mjs', 'src/editor/cli.mjs', 'src/lib/astro-gallery-patch.mjs', 'docs/editor-package.md']) assert(names.includes(required), `tarball missing ${required}`)
  assert(!names.some((name) => name.startsWith('test/') || name.startsWith('src/pages/')), 'demo app/test files leaked into tarball')
  const consumer = path.join(temp, 'consumer')
  await mkdir(path.join(consumer, 'src/pages'), { recursive: true })
  await mkdir(path.join(consumer, 'src/content/notes'), { recursive: true })
  await mkdir(path.join(consumer, 'src/content/smoke-notes'), { recursive: true })
  await mkdir(path.join(consumer, 'src/components'), { recursive: true })
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'astro build' } }))
  const port = 19000 + Math.floor(Math.random() * 1000)
  const sitePort = port + 1000
  await writeFile(path.join(consumer, 'astro.config.mjs'), `import { defineConfig } from 'astro/config'; import mdx from '@astrojs/mdx'; import { createLoopbackDevIntegration } from '@astro-visual-cms/editor/integration'; export default defineConfig({ integrations: [mdx(), createLoopbackDevIntegration({ editorPort: '${port}', previewRoutes: [{ id: 'references', label: 'Referenzen', path: '/referenzen/' }] })] })`)
  await writeFile(path.join(consumer, 'src/pages/referenzen.astro'), '<html><body>Referenzen-Beweis</body></html>')
  const astroGalleryFile = path.join(consumer, 'src/components/InternalGallery.astro')
  const astroGallerySource = `---\ntype GalleryImage = { name: string; alt: string; note: string };\nconst imageNames: GalleryImage[] = [\n  { name: "alpha", alt: "Alpha", note: "keep-alpha" },\n  { name: "beta", alt: "Beta", note: "keep-beta" },\n]\n---\n{imageNames.map((image) => <span data-image={image.name}>{image.alt}:{image.note}</span>)}`
  await writeFile(astroGalleryFile, astroGallerySource)
  await writeFile(path.join(consumer, 'src/pages/internal-gallery.astro'), `---\nimport InternalGallery from '../components/InternalGallery.astro'\n---\n<InternalGallery />`)
  await writeFile(path.join(consumer, 'src/components/Gallery.astro'), '---\nconst { sorted = [] } = Astro.props\n---\n<section>{sorted.join(",")}</section>')
  const fixtureFile = path.join(consumer, 'src/pages/fixture.mdx')
  await writeFile(fixtureFile, 'import Gallery from "../components/Gallery.astro";\n\nexport const ITEMS = ["noise-fixture-01", "noise-fixture-02", "noise-fixture-03"];\n\n<Gallery sorted={ITEMS} />')
  const mdxFile = path.join(consumer, 'src/pages/mdx-proof.mdx')
  const mdxSource = 'import Card from "../components/Card.astro";\n\n<Card id="fixture-gallery" label="Original MDX label" rank={2} enabled={true} tone="quiet" />'
  await writeFile(path.join(consumer, 'src/components/Card.astro'), '---\nconst { id, label = "", rank = 0, enabled = false, tone = "" } = Astro.props\n---\n<section data-card-id={id} data-rank={rank} data-enabled={enabled} data-tone={tone}>{label}</section>')
  await writeFile(mdxFile, mdxSource)
  await writeFile(path.join(consumer, 'src/pages/notes.astro'), `---
import { getCollection } from 'astro:content'
const notes = (await getCollection('notes')).sort((a, b) => a.data.order - b.data.order)
---
<ol>{notes.map((note) => <li data-note-id={note.id}>{note.data.title}</li>)}</ol>`)
  await writeFile(path.join(consumer, 'src/content.config.ts'), `import { defineCollection, z } from 'astro:content'; import { glob } from 'astro/loaders'; export const collections = { notes: defineCollection({ loader: glob({ base: './src/content/notes', pattern: '**/*.md' }), schema: z.object({ title: z.string(), order: z.number() }) }) }`)
  const noteFile = path.join(consumer, 'src/content/notes/one.md')
  const noteSource = '---\ntitle: One\norder: 1\n---\nText'
  await writeFile(noteFile, noteSource)
  await writeFile(path.join(consumer, 'src/content/notes/two.md'), '---\ntitle: Two\norder: 2\n---\nOther text')
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-save', path.join(temp, packed.filename), 'astro@7.4.7', '@astrojs/mdx@8.1.3'], { cwd: consumer, encoding: 'utf8', timeout: 180000 })
  assert.equal(install.status, 0, install.stderr)
  const config = { port, sitePort, projectRoot: '.', contentConfigPath: 'src/content.config.ts', fixturePath: 'src/pages/mdx-proof.mdx', previewRoutes: [{ id: 'references', label: 'Referenzen', path: '/referenzen/' }], astroGalleryTargets: [{ id: 'internal-gallery', projectRoot: '.', filePath: 'src/components/InternalGallery.astro', variableName: 'imageNames', identityProperty: 'name', labelProperty: 'alt' }], mdxComponentTargets: [{ id: 'fixture-gallery', projectRoot: '.', filePath: 'src/pages/mdx-proof.mdx', importSource: '../components/Card.astro', idProp: 'id', fields: [{ name: 'label', type: 'string' }, { name: 'rank', type: 'number', min: 1, max: 5, step: 1 }, { name: 'enabled', type: 'boolean' }, { name: 'tone', type: 'enum', values: ['quiet', 'bold'] }] }] }
  await writeFile(path.join(consumer, 'editor.json'), JSON.stringify(config))
  child = spawn(path.join(consumer, 'node_modules/.bin/astro-visual-cms-editor'), ['--config', 'editor.json'], { cwd: consumer, stdio: 'ignore', detached: process.platform !== 'win32' })
  let response
  for (let n = 0; n < 60; n++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/collections`); if (response.ok) break } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  assert(response?.ok, 'installed editor server did not start')
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { origin: `http://127.0.0.1:${sitePort}` } })
  assert.equal(health.status, 204, 'local preview origin could not probe editor availability')
  const wrongOriginHealth = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { origin: 'http://127.0.0.1:1' } })
  assert.equal(wrongOriginHealth.status, 403, 'health probe accepted a non-configured origin')
  let state = await response.json()
  assert.equal(state.configured, true)
  assert(state.collections.some((collection) => collection.id === 'notes'), 'content collection not exposed')
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token
  const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-editor-token': token }

  const schemaOperation = {
    name: 'smokeNotes', base: './src/content/smoke-notes', pattern: '*.md', hash: state.configHash,
    fields: [{ name: 'title', type: 'string', required: true }],
  }
  const contentConfig = path.join(consumer, 'src/content.config.ts')
  const originalConfig = await readFile(contentConfig, 'utf8')
  const schemaPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(schemaOperation) })
  const schemaPreview = await schemaPreviewResponse.json()
  assert(schemaPreviewResponse.ok && schemaPreview.previewId, `static collection preview failed: ${JSON.stringify(schemaPreview)}`)
  assert.equal(await readFile(contentConfig, 'utf8'), originalConfig, 'collection preview wrote before confirmation')
  assert.match(schemaPreview.diff.after, /smokeNotes/)
  assert.match(schemaPreview.diff.after, /z\.string\(\)/)
  const schemaCommit = await fetch(`http://127.0.0.1:${port}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...schemaOperation, previewId: schemaPreview.previewId }) })
  assert.equal(schemaCommit.status, 200, `static collection commit failed: ${await schemaCommit.text()}`)
  assert.equal(await readFile(contentConfig, 'utf8'), originalConfig.slice(0, schemaPreview.diff.start) + schemaPreview.diff.after + originalConfig.slice(schemaPreview.diff.end), 'collection commit changed bytes outside its confirmed diff')
  state = await (await fetch(`http://127.0.0.1:${port}/api/collections`)).json()
  const smokeNotes = state.collections.find((collection) => collection.id === 'smokeNotes')
  assert(smokeNotes?.supported && smokeNotes.creationSupported, 'created collection was not rediscovered as editable')

  const createdStaticNote = path.join(consumer, 'src/content/smoke-notes/first-note.md')
  const entryOperation = { collectionId: 'smokeNotes', entryId: 'first-note.md', values: { title: 'Created collection entry — 東京' }, hash: state.configHash }
  const entryPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify(entryOperation) })
  const entryPreview = await entryPreviewResponse.json()
  assert(entryPreviewResponse.ok && entryPreview.previewId, `new collection entry preview failed: ${JSON.stringify(entryPreview)}`)
  assert.equal(entryPreview.diff.after, '---\ntitle: Created collection entry — 東京\n---\n')
  await assert.rejects(readFile(createdStaticNote), 'new collection entry preview wrote before confirmation')
  const entryCommit = await fetch(`http://127.0.0.1:${port}/api/collections/create-entry/commit`, { method: 'POST', headers, body: JSON.stringify({ ...entryOperation, previewId: entryPreview.previewId }) })
  assert.equal(entryCommit.status, 201, `new collection entry commit failed: ${await entryCommit.text()}`)
  assert.equal(await readFile(createdStaticNote, 'utf8'), entryPreview.diff.after, 'entry bytes differ from the confirmed preview')

  await writeFile(path.join(consumer, 'src/pages/created-notes.astro'), `---
import { getCollection } from 'astro:content'
const entries = await getCollection('smokeNotes')
---
<ul>{entries.map((entry) => <li data-entry-id={entry.id}>{entry.data.title}</li>)}</ul>`)
  const build = spawnSync('npm', ['run', 'build'], { cwd: consumer, encoding: 'utf8', timeout: 180000 })
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
  assert((await readFile(path.join(consumer, 'dist/referenzen/index.html'), 'utf8')).includes('Referenzen-Beweis'))
  const productionFiles = []
  const collectProductionFiles = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await collectProductionFiles(file)
      else if (entry.isFile()) productionFiles.push(file)
    }
  }
  await collectProductionFiles(path.join(consumer, 'dist'))
  for (const file of productionFiles.filter((name) => /\.(?:html|js|mjs|css|json)$/.test(name))) {
    const content = await readFile(file, 'utf8')
    for (const marker of ['astro-visual-cms-editor', 'avcms:challenge', 'avcms:ready', '/api/collections', '/api/mdx-components', '/api/astro-galleries']) {
      assert(!content.includes(marker), `production artifact ${path.relative(consumer, file)} contains dev-only marker ${marker}`)
    }
  }
  assert((await readFile(path.join(consumer, 'dist/mdx-proof/index.html'), 'utf8')).includes('Original MDX label'), 'Astro did not compile the synthetic MDX target')
  assert((await readFile(path.join(consumer, 'dist/internal-gallery/index.html'), 'utf8')).includes('keep-alpha'), 'Astro did not compile the synthetic internal array gallery')
  const createdCollectionHtml = await readFile(path.join(consumer, 'dist/created-notes/index.html'), 'utf8')
  assert.match(createdCollectionHtml, /data-entry-id="first-note"/)
  assert.match(createdCollectionHtml, /Created collection entry — 東京/)

  let astroLogs = ''
  astro = spawn(path.join(consumer, 'node_modules/.bin/astro'), ['dev', '--host', '127.0.0.1', '--port', String(sitePort), '--strictPort'], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  astro.stdout.on('data', (chunk) => astroLogs += chunk)
  astro.stderr.on('data', (chunk) => astroLogs += chunk)
  let page
  for (let n = 0; n < 120; n++) {
    try { page = await fetch(`http://127.0.0.1:${sitePort}/referenzen/`); if (page.ok) break } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(page?.ok, 'installed Astro dev server did not serve custom preview route')
  assert((await page.text()).includes('Referenzen-Beweis'))
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const previewPage = await context.newPage()
    await previewPage.goto(`http://127.0.0.1:${sitePort}/referenzen/`)
    await previewPage.waitForFunction(() => document.querySelector('astro-dev-toolbar')?.shadowRoot, null, { timeout: 15_000 })
    await previewPage.waitForFunction(() => document.querySelector('astro-dev-toolbar')?.shadowRoot?.querySelector('[data-app-id="astro-visual-cms-editor"]'), null, { timeout: 15_000 })
    const popupPromise = context.waitForEvent('page', { timeout: 10_000 })
    await previewPage.evaluate(() => document.querySelector('astro-dev-toolbar').shadowRoot.querySelector('[data-app-id="astro-visual-cms-editor"]').click())
    const editorPage = await popupPromise
    await editorPage.waitForURL((url) => url.hostname === '127.0.0.1' && url.port === String(port), { timeout: 10_000 })
    await editorPage.waitForLoadState('domcontentloaded')
    assert.equal(new URL(editorPage.url()).searchParams.get('route'), 'references', 'toolbar did not map the trusted preview route ID')
    assert.equal(previewPage.url(), `http://127.0.0.1:${sitePort}/referenzen/`, 'toolbar navigation replaced the preview')
    await editorPage.locator('#mdx-components-panel:not([hidden])').waitFor({ timeout: 15_000 })
    assert.match(await editorPage.locator('#status').textContent(), /Galerie-Fixture \(422\)/, 'unsupported demo fixture should not block the configured custom-component editor')
    await context.close()
  } finally { await browser.close() }
  const notes = state.collections.find((collection) => collection.id === 'notes')
  const note = notes.entries.find((entry) => entry.id === 'one.md')
  assert(note?.hash, 'glob collection entry was not discovered with a source hash')
  const collectionOperation = { collectionId: 'notes', entryId: 'one.md', field: 'order', value: 3, hash: note.hash }
  const collectionPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/collections/preview`, { method: 'POST', headers, body: JSON.stringify(collectionOperation) })
  const collectionPreview = await collectionPreviewResponse.json()
  assert(collectionPreviewResponse.ok && collectionPreview.previewId, `numeric collection preview failed: ${JSON.stringify(collectionPreview)}`)
  assert.equal(await readFile(noteFile, 'utf8'), noteSource, 'numeric collection preview wrote before confirmation')
  const collectionCommit = await fetch(`http://127.0.0.1:${port}/api/collections/commit`, { method: 'POST', headers, body: JSON.stringify({ ...collectionOperation, previewId: collectionPreview.previewId }) })
  assert.equal(collectionCommit.status, 200, `numeric collection commit failed: ${await collectionCommit.text()}`)
  const noteAfter = noteSource.replace('order: 1', 'order: 3')
  assert.equal(await readFile(noteFile, 'utf8'), noteAfter, 'numeric collection commit changed bytes outside the selected scalar')
  let notesRendered = false
  for (let n = 0; n < 100; n++) {
    const page = await fetch(`http://127.0.0.1:${sitePort}/notes/`)
    if (page.ok) {
      const html = await page.text()
      if (html.indexOf('data-note-id="two"') < html.indexOf('data-note-id="one"')) { notesRendered = true; break }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(notesRendered, 'Astro glob collection did not sync the confirmed numeric edit and rerender the sorted route')
  const createOperation = { collectionId: 'notes', entryId: 'three.md', values: { title: 'Three', order: 0 }, hash: state.configHash }
  const createPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/collections/create-entry/preview`, { method: 'POST', headers, body: JSON.stringify(createOperation) })
  const createPreview = await createPreviewResponse.json()
  assert(createPreviewResponse.ok && createPreview.previewId, `glob entry creation preview failed: ${JSON.stringify(createPreview)}`)
  const createdNote = path.join(consumer, 'src/content/notes/three.md')
  await assert.rejects(readFile(createdNote), 'entry preview must not create a file before confirmation')
  assert.equal(createPreview.diff.after, '---\ntitle: Three\norder: 0\n---\n')
  const createCommit = await fetch(`http://127.0.0.1:${port}/api/collections/create-entry/commit`, { method: 'POST', headers, body: JSON.stringify({ ...createOperation, previewId: createPreview.previewId }) })
  assert.equal(createCommit.status, 201, `glob entry creation commit failed: ${await createCommit.text()}`)
  assert.equal(await readFile(createdNote, 'utf8'), createPreview.diff.after, 'created YAML entry bytes differ from the confirmed preview')
  let entryRendered = false
  for (let n = 0; n < 100; n++) {
    const page = await fetch(`http://127.0.0.1:${sitePort}/notes/`)
    if (page.ok) {
      const html = await page.text()
      if (html.indexOf('data-note-id="three"') < html.indexOf('data-note-id="two"')) { entryRendered = true; break }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(entryRendered, 'Astro glob collection did not sync and render the confirmed new entry')
  const mdxCatalog = await (await fetch(`http://127.0.0.1:${port}/api/mdx-components`)).json()
  const target = mdxCatalog.targets.find((item) => item.id === 'fixture-gallery')
  assert.equal(target?.instances[0]?.props.label, 'Original MDX label', 'installed MDX adapter did not inspect the component')
  const operation = { targetId: 'fixture-gallery', instanceId: 'fixture-gallery', prop: 'label', value: 'Installed MDX edit', hash: target.hash }
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify(operation) })
  const preview = await previewResponse.json()
  assert(previewResponse.ok && preview.previewId, `installed MDX preview failed: ${JSON.stringify(preview)}`)
  assert.equal(await readFile(mdxFile, 'utf8'), mdxSource, 'MDX preview wrote before confirmation')
  const commit = await fetch(`http://127.0.0.1:${port}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...operation, previewId: preview.previewId }) })
  assert.equal(commit.status, 200, `installed MDX commit failed: ${await commit.text()}`)
  let mdxAfter = mdxSource.replace('label="Original MDX label"', 'label="Installed MDX edit"')
  assert.equal(await readFile(mdxFile, 'utf8'), mdxAfter, 'MDX adapter changed bytes outside the selected literal')
  for (const [prop, value, oldLiteral, newLiteral] of [['rank', 4, 'rank={2}', 'rank={4}'], ['enabled', false, 'enabled={true}', 'enabled={false}'], ['tone', 'bold', 'tone="quiet"', 'tone="bold"']]) {
    const latest = await (await fetch(`http://127.0.0.1:${port}/api/mdx-components`)).json()
    const typedTarget = latest.targets.find((item) => item.id === 'fixture-gallery')
    const typedOperation = { targetId: 'fixture-gallery', instanceId: 'fixture-gallery', prop, value, hash: typedTarget.hash }
    const typedPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify(typedOperation) })
    const typedPreview = await typedPreviewResponse.json()
    assert(typedPreviewResponse.ok && typedPreview.previewId, `typed ${prop} preview failed: ${JSON.stringify(typedPreview)}`)
    const typedCommit = await fetch(`http://127.0.0.1:${port}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...typedOperation, previewId: typedPreview.previewId }) })
    assert.equal(typedCommit.status, 200, `typed ${prop} commit failed: ${await typedCommit.text()}`)
    const currentSource = await readFile(mdxFile, 'utf8')
    assert.equal(currentSource, mdxAfter.replace(oldLiteral, newLiteral), `${prop} commit changed bytes beyond its literal`)
    mdxAfter = currentSource
  }
  const uiBrowser = await chromium.launch({ headless: true })
  try {
    const uiContext = await uiBrowser.newContext()
    const uiPage = await uiContext.newPage()
    await uiPage.goto(`http://127.0.0.1:${port}/?route=references`)
    await uiPage.locator('#mdx-components-panel:not([hidden])').waitFor({ timeout: 15_000 })
    await uiPage.locator('#mdx-prop').selectOption('label')
    assert.equal(await uiPage.locator('#mdx-value-control input').getAttribute('type'), 'text')
    await uiPage.locator('#mdx-prop').selectOption('rank')
    const rankInput = uiPage.locator('#mdx-value-control input[type="number"]')
    await rankInput.waitFor()
    assert.equal(await rankInput.inputValue(), '4')
    await uiPage.locator('#mdx-prop').selectOption('enabled')
    assert.equal(await uiPage.locator('#mdx-value-control input').getAttribute('type'), 'checkbox')
    assert.equal(await uiPage.locator('#mdx-value-control input').isChecked(), false)
    await uiPage.locator('#mdx-prop').selectOption('tone')
    assert.equal(await uiPage.locator('#mdx-value-control select').inputValue(), 'bold')
    await uiPage.locator('#mdx-prop').selectOption('rank')
    await uiPage.locator('#mdx-value-control input[type="number"]').fill('5')
    await uiPage.locator('#mdx-preview-button').click()
    await uiPage.locator('#mdx-confirmation:not([hidden])').waitFor()
    assert.equal(await uiPage.locator('#mdx-diff-before').textContent(), '{4}')
    assert.equal(await uiPage.locator('#mdx-diff-after').textContent(), '{5}')
    const uiCommitResponse = uiPage.waitForResponse((response) => response.url().endsWith('/api/mdx-components/commit') && response.request().method() === 'POST')
    await uiPage.locator('#mdx-confirm-button').click()
    assert.equal((await uiCommitResponse).status(), 200, 'custom component field UI commit failed')
    const uiExpectedSource = mdxAfter.replace('rank={4}', 'rank={5}')
    assert.equal(await readFile(mdxFile, 'utf8'), uiExpectedSource, 'UI commit changed bytes outside the selected custom component scalar')
    mdxAfter = uiExpectedSource
    const galleryPage = await uiContext.newPage()
    await galleryPage.goto(`http://127.0.0.1:${port}/?route=references`)
    await galleryPage.locator('#gallery-picker button[data-gallery-id="internal-gallery"]').waitFor()
    await galleryPage.locator('#gallery-picker button[data-gallery-id="internal-gallery"]').click()
    await galleryPage.locator('#images button[aria-label^="Nach unten"]').first().click()
    await galleryPage.locator('#diff-confirmation:not([hidden])').waitFor()
    assert.match(await galleryPage.locator('#diff-after').textContent(), /beta[\s\S]*alpha/)
    const astroGalleryCommit = galleryPage.waitForResponse((response) => response.url().endsWith('/api/astro-galleries/commit') && response.request().method() === 'POST')
    await galleryPage.locator('#confirm-change').click()
    assert.equal((await astroGalleryCommit).status(), 200, 'Astro internal-array UI commit failed')
    const expectedGallery = astroGallerySource.replace('{ name: "alpha", alt: "Alpha", note: "keep-alpha" },\n  { name: "beta", alt: "Beta", note: "keep-beta" },', '{ name: "beta", alt: "Beta", note: "keep-beta" },\n  { name: "alpha", alt: "Alpha", note: "keep-alpha" },')
    assert.equal(await readFile(astroGalleryFile, 'utf8'), expectedGallery, 'Astro internal-gallery edit changed bytes outside the object-array reorder')
  } finally { await uiBrowser.close() }
  let astroGalleryRendered = false
  for (let n = 0; n < 100; n++) {
    const response = await fetch(`http://127.0.0.1:${sitePort}/internal-gallery/`)
    if (response.ok) { const html = await response.text(); if (html.indexOf('data-image="beta"') < html.indexOf('data-image="alpha"') && html.includes('keep-beta') && html.includes('keep-alpha')) { astroGalleryRendered = true; break } }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(astroGalleryRendered, `Astro internal gallery did not HMR-render the reordered object array: ${astroLogs}`)
  let mdxRendered = false
  for (let n = 0; n < 100; n++) {
    const page = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`)
    if (page.ok) { const html = await page.text(); if (html.includes('Installed MDX edit') && html.includes('data-rank="5"') && html.includes('data-enabled="false"') && html.includes('data-tone="bold"')) { mdxRendered = true; break } }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!mdxRendered) {
    const last = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`).catch(() => null)
    throw new Error(`Astro MDX route did not rerender the confirmed installed-package edit (last status ${last?.status ?? 'unavailable'}): ${(await last?.text())?.slice(0, 1200) ?? ''}\n${astroLogs}`)
  }
  const ui = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert(ui.includes('/referenzen/'), 'custom preview route not rendered by editor UI')
  console.log(`package smoke passed: ${packed.filename}, ${names.length} tarball entries, Astro production isolation, installed editor API, confirmed collection/entry creation, numeric Content Sync, Dev Toolbar route launch, typed custom-component UI/API preview/commit, exact source-byte preservation, Astro internal-array UI preview/commit, and MDX/Astro gallery HMR`)
} finally {
  await stop(child)
  if (astro) {
    const consumer = path.join(temp, 'consumer')
    spawnSync(path.join(consumer, 'node_modules/.bin/astro'), ['dev', 'stop'], { cwd: consumer, stdio: 'ignore', timeout: 10000 })
  }
  await stop(astro)
  await stopTempProcesses()
  for (let attempt = 0; ; attempt++) {
    try { await rm(temp, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 5 || error.code !== 'ENOTEMPTY') throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
