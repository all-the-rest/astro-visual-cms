import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  for (const required of ['LICENSE', 'src/editor/astro-integration.mjs', 'src/editor/mdx-block-preview.mjs', 'src/editor/toolbar-app.mjs', 'src/editor/server.mjs', 'src/editor/cli.mjs', 'src/editor/editor.css', 'src/editor/editor.generated.css', 'src/lib/astro-gallery-patch.mjs', 'src/lib/mdx-blocks.mjs', 'docs/editor-package.md']) assert(names.includes(required), `tarball missing ${required}`)
  assert(!names.some((name) => name.startsWith('test/') || name.startsWith('src/pages/')), 'demo app/test files leaked into tarball')
  const consumer = path.join(temp, 'consumer')
  await mkdir(path.join(consumer, 'src/pages'), { recursive: true })
  await mkdir(path.join(consumer, 'src/content/notes'), { recursive: true })
  await mkdir(path.join(consumer, 'src/content/smoke-notes'), { recursive: true })
  await mkdir(path.join(consumer, 'src/components'), { recursive: true })
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'astro build' } }))
  const port = 19000 + Math.floor(Math.random() * 1000)
  const sitePort = port + 1000
  const blockTypes = [{ type: 'card', label: 'Block card', componentName: 'BlockCard', importSource: '../components/BlockCard.astro', idProp: 'id', fields: [{ name: 'title', type: 'string', required: true }] }]
  await writeFile(path.join(consumer, 'astro.config.mjs'), `import path from 'node:path'; import { defineConfig } from 'astro/config'; import mdx from '@astrojs/mdx'; import { createLoopbackDevIntegration } from '@astro-visual-cms/editor/integration'; const blockTypes = ${JSON.stringify(blockTypes)}; export default defineConfig({ integrations: [mdx(), createLoopbackDevIntegration({ editorPort: '${port}', previewRoutes: [{ id: 'references', label: 'Referenzen', path: '/referenzen/' }, { id: 'block-proof', label: 'Block proof', path: '/block-proof/' }, { id: 'block-failure', label: 'Block failure', path: '/block-failure/' }], mdxBlockTargets: [{ id: 'block-fixture', projectRoot: process.cwd(), filePath: path.join(process.cwd(), 'src/pages/block-proof.md'), previewRouteId: 'block-proof', blockTypes }, { id: 'block-failure', projectRoot: process.cwd(), filePath: path.join(process.cwd(), 'src/pages/block-failure.md'), previewRouteId: 'block-failure', blockTypes }] })] })`)
  await writeFile(path.join(consumer, 'src/pages/referenzen.astro'), '<html><body>Referenzen-Beweis</body></html>')
  const astroGalleryFile = path.join(consumer, 'src/components/InternalGallery.astro')
  const astroGallerySource = `---\ntype GalleryImage = { name: string; alt: string; note: string };\nconst imageNames: GalleryImage[] = [\n  { name: "alpha", alt: "Alpha", note: "keep-alpha" },\n  { name: "beta", alt: "Beta", note: "keep-beta" },\n]\n---\n{imageNames.map((image) => <span data-image={image.name}>{image.alt}:{image.note}</span>)}`
  await writeFile(astroGalleryFile, astroGallerySource)
  await writeFile(path.join(consumer, 'src/pages/internal-gallery.astro'), `---\nimport InternalGallery from '../components/InternalGallery.astro'\n---\n<InternalGallery />`)
  await writeFile(path.join(consumer, 'src/components/Gallery.astro'), '---\nconst { sorted = [] } = Astro.props\n---\n<section>{sorted.join(",")}</section>')
  const fixtureFile = path.join(consumer, 'src/pages/fixture.mdx')
  await writeFile(fixtureFile, 'import Gallery from "../components/Gallery.astro";\n\nexport const ITEMS = ["noise-fixture-01", "noise-fixture-02", "noise-fixture-03"];\n\n<Gallery sorted={ITEMS} />')
  const mdxFile = path.join(consumer, 'src/pages/mdx-proof.mdx')
  const mdxSource = 'import Card from "../components/Card.astro";\nimport NestedComponent from "../components/NestedComponent.astro";\n\n<Card id="fixture-gallery" label="Original MDX label" rank={2} enabled={true} tone="quiet" unconfigured="preserve-me">\n  Nested MDX prose survives unchanged.\n\n  <NestedComponent label="Nested custom component content survives" />\n</Card>'
  await writeFile(path.join(consumer, 'src/components/Card.astro'), '---\nconst { id, label = "", rank = 0, enabled = false, tone = "" } = Astro.props\n---\n<section data-card-id={id} data-rank={rank} data-enabled={enabled} data-tone={tone}>{label}<slot /></section>')
  await writeFile(path.join(consumer, 'src/components/NestedComponent.astro'), '---\nconst { label = "" } = Astro.props\n---\n<aside data-nested-component>{label}</aside>')
  await writeFile(mdxFile, mdxSource)
  const blockFile = path.join(consumer, 'src/pages/block-proof.md')
  const blockSource = '# Original Markdown block target\n\nThis prose survives the virtual Markdown preview without a source write — 東京.\n'
  const blockFailureFile = path.join(consumer, 'src/pages/block-failure.md')
  const blockFailureSource = '# Astro compile failure target\n\nThis original Markdown must stay unchanged after a failed render.\n'
  await writeFile(path.join(consumer, 'src/components/BlockCard.astro'), '---\nconst { id, title = "" } = Astro.props\nif (title === "Fail Astro render") throw new Error("Synthetic Astro block rendering failure")\n---\n<article id={id} data-block-kind="package-smoke"><h2>{title}</h2></article>')
  await writeFile(blockFile, blockSource)
  await writeFile(blockFailureFile, blockFailureSource)
  await writeFile(path.join(consumer, 'src/pages/notes.astro'), `---
import { getCollection } from 'astro:content'
const notes = (await getCollection('notes')).sort((a, b) => a.data.order - b.data.order)
---
<ol>{notes.map((note) => <li data-note-id={note.id}>{note.data.title}</li>)}</ol>`)
  await writeFile(path.join(consumer, 'src/content.config.ts'), `import { defineCollection, z } from 'astro:content'; import { glob } from 'astro/loaders'; export const collections = { notes: defineCollection({ loader: glob({ base: './src/content/notes', pattern: '**/*.md' }), schema: z.object({ title: z.string(), order: z.number() }) }), smokeNotes: defineCollection({ loader: glob({ base: './src/content/smoke-notes', pattern: '*.md' }), schema: z.object({ title: z.string() }) }) }`)
  const noteFile = path.join(consumer, 'src/content/notes/one.md')
  const noteSource = '---\ntitle: One\norder: 1\n---\nText'
  await writeFile(noteFile, noteSource)
  await writeFile(path.join(consumer, 'src/content/notes/two.md'), '---\ntitle: Two\norder: 2\n---\nOther text')
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-save', path.join(temp, packed.filename), 'astro@7.4.7', '@astrojs/mdx@8.1.3'], { cwd: consumer, encoding: 'utf8', timeout: 180000 })
  assert.equal(install.status, 0, install.stderr)
  const config = { port, sitePort, projectRoot: '.', contentConfigPath: 'src/content.config.ts', fixturePath: 'src/pages/mdx-proof.mdx', previewRoutes: [{ id: 'references', label: 'Referenzen', path: '/referenzen/' }, { id: 'block-proof', label: 'Block proof', path: '/block-proof/' }, { id: 'block-failure', label: 'Block failure', path: '/block-failure/' }], astroGalleryTargets: [{ id: 'internal-gallery', projectRoot: '.', filePath: 'src/components/InternalGallery.astro', variableName: 'imageNames', identityProperty: 'name', labelProperty: 'alt' }], mdxComponentTargets: [{ id: 'fixture-gallery', projectRoot: '.', filePath: 'src/pages/mdx-proof.mdx', importSource: '../components/Card.astro', idProp: 'id', fields: [{ name: 'label', type: 'string' }, { name: 'rank', type: 'number', min: 1, max: 5, step: 1 }, { name: 'enabled', type: 'boolean' }, { name: 'tone', type: 'enum', values: ['quiet', 'bold'] }] }], mdxBlockTargets: [{ id: 'block-fixture', projectRoot: '.', filePath: 'src/pages/block-proof.md', previewRouteId: 'block-proof', blockTypes }, { id: 'block-failure', projectRoot: '.', filePath: 'src/pages/block-failure.md', previewRouteId: 'block-failure', blockTypes }] }
  await writeFile(path.join(consumer, 'editor.json'), JSON.stringify(config))
  child = spawn(path.join(consumer, 'node_modules/.bin/astro-visual-cms-editor'), ['--config', 'editor.json'], { cwd: consumer, stdio: 'ignore', detached: process.platform !== 'win32' })
  let response
  for (let n = 0; n < 60; n++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/collections`); if (response.ok) break } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  assert(response?.ok, 'installed editor server did not start')
  const editorHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert.match(editorHtml, /<link rel="stylesheet" href="\/editor\.css"/, 'installed editor must load its own stylesheet')
  const editorCssResponse = await fetch(`http://127.0.0.1:${port}/editor.css`)
  assert.equal(editorCssResponse.status, 200, 'installed editor stylesheet is not served')
  assert.match(await editorCssResponse.text(), /\.overflow-auto/, 'installed editor stylesheet lacks bounded preview layout rules')
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
    name: 'proposedNotes', base: './src/content/notes', pattern: '*.md', hash: state.configHash,
    fields: [{ name: 'title', type: 'string', required: true }],
  }
  const contentConfig = path.join(consumer, 'src/content.config.ts')
  const originalConfig = await readFile(contentConfig, 'utf8')
  const schemaPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/collections/config/create/preview`, { method: 'POST', headers, body: JSON.stringify(schemaOperation) })
  const schemaPreview = await schemaPreviewResponse.json()
  assert(schemaPreviewResponse.ok && schemaPreview.previewId, `static collection preview failed: ${JSON.stringify(schemaPreview)}`)
  assert.equal(await readFile(contentConfig, 'utf8'), originalConfig, 'collection preview wrote before confirmation')
  assert.match(schemaPreview.diff.after, /proposedNotes/)
  assert.match(schemaPreview.diff.after, /z\.string\(\)/)
  const schemaCommit = await fetch(`http://127.0.0.1:${port}/api/collections/config/create/commit`, { method: 'POST', headers, body: JSON.stringify({ ...schemaOperation, previewId: schemaPreview.previewId }) })
  const schemaCommitResult = await schemaCommit.json()
  assert.equal(schemaCommit.status, 409, `existing config replacement was not blocked: ${JSON.stringify(schemaCommitResult)}`)
  assert.equal(schemaCommitResult.code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(await readFile(contentConfig, 'utf8'), originalConfig, 'blocked schema proposal changed the config')
  state = await (await fetch(`http://127.0.0.1:${port}/api/collections`)).json()
  const smokeNotes = state.collections.find((collection) => collection.id === 'smokeNotes')
  assert(smokeNotes?.supported && smokeNotes.creationSupported, 'preconfigured static collection was not discovered as editable')
  assert.equal(state.collections.some((collection) => collection.id === 'proposedNotes'), false, 'a manual config proposal must not mutate discovery state')

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
    for (const marker of ['astro-visual-cms-editor', 'avcms:challenge', 'avcms:ready', 'avcms:mdx-block-preview', '__avcms/mdx-block-preview', '/api/collections', '/api/mdx-components', '/api/mdx-blocks', '/api/astro-galleries', 'mdx-blocks-panel']) {
      assert(!content.includes(marker), `production artifact ${path.relative(consumer, file)} contains dev-only marker ${marker}`)
    }
  }
  const mdxBuildHtml = await readFile(path.join(consumer, 'dist/mdx-proof/index.html'), 'utf8')
  assert(mdxBuildHtml.includes('Original MDX label'), 'Astro did not compile the synthetic MDX target')
  assert(mdxBuildHtml.includes('Nested MDX prose survives unchanged'), 'Astro did not render nested MDX prose')
  assert(mdxBuildHtml.includes('Nested custom component content survives'), 'Astro did not preserve the nested custom component slot')
  assert((await readFile(path.join(consumer, 'dist/internal-gallery/index.html'), 'utf8')).includes('keep-alpha'), 'Astro did not compile the synthetic internal array gallery')
  const blockBuildHtml = await readFile(path.join(consumer, 'dist/block-proof/index.html'), 'utf8')
  assert(blockBuildHtml.includes('Original Markdown block target') && blockBuildHtml.includes('This prose survives the virtual Markdown preview without a source write'), 'Astro did not compile the synthetic Markdown block target')
  assert((await readFile(path.join(consumer, 'dist/block-failure/index.html'), 'utf8')).includes('Astro compile failure target'), 'Astro did not compile the synthetic failure-recovery target')
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
  const mdxDevPage = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`)
  const mdxDevHtml = await mdxDevPage.text()
  assert(mdxDevPage.ok && mdxDevHtml.includes('Original MDX label') && mdxDevHtml.includes('Nested MDX prose survives unchanged') && mdxDevHtml.includes('Nested custom component content survives'), 'Astro dev did not render the configured custom component and its nested slot')
  const blockDevPage = await fetch(`http://127.0.0.1:${sitePort}/block-proof/`)
  assert((await blockDevPage.text()).includes('Original Markdown block target'), 'Astro dev did not render the configured Markdown block target')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const previewPage = await context.newPage()
    await previewPage.goto(`http://127.0.0.1:${sitePort}/referenzen/`)
    await previewPage.waitForFunction(() => document.querySelector('astro-dev-toolbar')?.shadowRoot, null, { timeout: 15_000 })
    await previewPage.waitForFunction(() => document.querySelector('astro-dev-toolbar')?.shadowRoot?.querySelector('[data-app-id="astro-visual-cms-editor"]'), null, { timeout: 15_000 })
    const popupPromise = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null)
    await previewPage.locator('astro-dev-toolbar button.item[data-app-id="astro-visual-cms-editor"]').click()
    const editorPage = await popupPromise
    assert(editorPage, 'Dev Toolbar did not open a page from the real click')
    await editorPage.waitForURL((url) => url.hostname === '127.0.0.1' && url.port === String(port), { timeout: 10_000 })
    await editorPage.waitForLoadState('domcontentloaded')
    assert.equal(new URL(editorPage.url()).searchParams.get('route'), 'references', 'toolbar did not map the trusted preview route ID')
    assert.equal(previewPage.url(), `http://127.0.0.1:${sitePort}/referenzen/`, 'toolbar navigation replaced the preview')
    await editorPage.locator('#mdx-components-panel:not([hidden])').waitFor({ timeout: 15_000 })
    await editorPage.locator('#mdx-blocks-panel:not([hidden])').waitFor({ timeout: 15_000 })
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
  const collectionCommitResult = await collectionCommit.json()
  assert.equal(collectionCommit.status, 409, `existing entry replacement was not blocked: ${JSON.stringify(collectionCommitResult)}`)
  assert.equal(collectionCommitResult.code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.equal(await readFile(noteFile, 'utf8'), noteSource, 'blocked numeric proposal changed the entry')
  let notesRendered = false
  for (let n = 0; n < 100; n++) {
    const page = await fetch(`http://127.0.0.1:${sitePort}/notes/`)
    if (page.ok) {
      const html = await page.text()
      if (html.indexOf('data-note-id="one"') < html.indexOf('data-note-id="two"')) { notesRendered = true; break }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(notesRendered, 'Astro glob collection did not preserve the source order after a blocked replacement')
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
  const commitResult = await commit.json()
  assert.equal(commit.status, 409, `existing MDX replacement was not blocked: ${JSON.stringify(commitResult)}`)
  assert.equal(commitResult.code, 'SOURCE_REPLACEMENT_DISABLED')
  let mdxAfter = mdxSource
  assert.equal(await readFile(mdxFile, 'utf8'), mdxSource, 'blocked MDX proposal changed source bytes')
  for (const [prop, value] of [['rank', 4], ['enabled', false], ['tone', 'bold']]) {
    const latest = await (await fetch(`http://127.0.0.1:${port}/api/mdx-components`)).json()
    const typedTarget = latest.targets.find((item) => item.id === 'fixture-gallery')
    const typedOperation = { targetId: 'fixture-gallery', instanceId: 'fixture-gallery', prop, value, hash: typedTarget.hash }
    const typedPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/mdx-components/preview`, { method: 'POST', headers, body: JSON.stringify(typedOperation) })
    const typedPreview = await typedPreviewResponse.json()
    assert(typedPreviewResponse.ok && typedPreview.previewId, `typed ${prop} preview failed: ${JSON.stringify(typedPreview)}`)
    const typedCommit = await fetch(`http://127.0.0.1:${port}/api/mdx-components/commit`, { method: 'POST', headers, body: JSON.stringify({ ...typedOperation, previewId: typedPreview.previewId }) })
    const typedCommitResult = await typedCommit.json()
    assert.equal(typedCommit.status, 409, `typed ${prop} replacement was not blocked: ${JSON.stringify(typedCommitResult)}`)
    assert.equal(typedCommitResult.code, 'SOURCE_REPLACEMENT_DISABLED')
    const currentSource = await readFile(mdxFile, 'utf8')
    assert.equal(currentSource, mdxAfter, `${prop} blocked proposal changed source bytes`)
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
    assert.equal(await rankInput.inputValue(), '2')
    await uiPage.locator('#mdx-prop').selectOption('enabled')
    assert.equal(await uiPage.locator('#mdx-value-control input').getAttribute('type'), 'checkbox')
    assert.equal(await uiPage.locator('#mdx-value-control input').isChecked(), true)
    await uiPage.locator('#mdx-prop').selectOption('tone')
    assert.equal(await uiPage.locator('#mdx-value-control select').inputValue(), 'quiet')
    await uiPage.locator('#mdx-prop').selectOption('rank')
    await uiPage.locator('#mdx-value-control input[type="number"]').fill('5')
    await uiPage.locator('#mdx-preview-button').click()
    await uiPage.locator('#mdx-confirmation:not([hidden])').waitFor()
    assert.equal(await uiPage.locator('#mdx-diff-before').textContent(), '{2}')
    assert.equal(await uiPage.locator('#mdx-diff-after').textContent(), '{5}')
    const uiCommitResponse = uiPage.waitForResponse((response) => response.url().endsWith('/api/mdx-components/commit') && response.request().method() === 'POST')
    await uiPage.locator('#mdx-confirm-button').click()
    assert.equal((await uiCommitResponse).status(), 409, 'custom component replacement must fail closed')
    await uiPage.locator('#source-proposal-panel').waitFor({ state: 'visible' })
    const [mdxDownload] = await Promise.all([
      uiPage.waitForEvent('download'), uiPage.locator('#source-proposal-export').click(),
    ])
    const mdxProposal = JSON.parse(await readFile(await mdxDownload.path(), 'utf8'))
    assert.deepEqual(mdxProposal, {
      schemaVersion: 1,
      type: 'astro-visual-cms-source-proposal',
      target: { kind: 'mdx-target', id: 'fixture-gallery' },
      baseHash: createHash('sha256').update(mdxSource).digest('hex'),
      proposedHash: createHash('sha256').update(mdxSource.replace('rank={2}', 'rank={5}')).digest('hex'),
      change: { instanceId: 'fixture-gallery', prop: 'rank', value: 5 },
      diff: { start: mdxSource.indexOf('{2}'), end: mdxSource.indexOf('{2}') + 3, before: '{2}', after: '{5}' },
    })
    assert(!JSON.stringify(mdxProposal).includes(mdxFile), 'proposal disclosed the source path')
    assert(!JSON.stringify(mdxProposal).includes(mdxSource), 'proposal embedded the full source file')
    assert.equal(await readFile(mdxFile, 'utf8'), mdxSource, 'the manual proposal must not write source')
    const mdxAfterProposalResponse = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`)
    const mdxAfterProposalHtml = await mdxAfterProposalResponse.text()
    assert(mdxAfterProposalResponse.ok && mdxAfterProposalHtml.includes('Original MDX label') && mdxAfterProposalHtml.includes('Nested MDX prose survives unchanged') && mdxAfterProposalHtml.includes('Nested custom component content survives'), 'Astro rendering changed after the fail-closed MDX proposal')
    await uiPage.locator('#mdx-conflict-discard').click()
    const noOpSource = await readFile(mdxFile, 'utf8')
    let noOpCommitRequests = 0
    uiPage.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/mdx-components/commit')) noOpCommitRequests += 1
    })
    await uiPage.locator('#mdx-value-control input[type="number"]').fill('2')
    await uiPage.locator('#mdx-preview-button').click()
    await uiPage.waitForFunction(() => document.querySelector('#status')?.textContent === 'Der MDX-Wert ist unverändert; es wurde nichts geschrieben.')
    assert.equal(await uiPage.locator('#mdx-confirmation').isHidden(), true, 'no-op must not show a confirmation diff')
    assert.equal(await readFile(mdxFile, 'utf8'), noOpSource, 'no-op UI preview changed source bytes')
    assert.equal(noOpCommitRequests, 0, 'no-op UI preview must not send a commit request')

    const blockPage = await uiContext.newPage()
    await blockPage.goto(`http://127.0.0.1:${port}/?route=block-proof`)
    await blockPage.locator('#mdx-blocks-panel:not([hidden])').waitFor({ timeout: 15_000 })
    const blockFrame = blockPage.frameLocator('#preview')
    await blockFrame.getByRole('heading', { name: 'Original Markdown block target' }).waitFor()
    await blockPage.locator('#mdx-block-add-field-title').fill('Installed package block')
    await blockPage.locator('#mdx-block-add').click()
    await blockFrame.getByRole('heading', { name: 'Installed package block' }).waitFor()
    await blockPage.locator('#mdx-block-confirmation:not([hidden])').waitFor()
    assert.equal(await readFile(blockFile, 'utf8'), blockSource, 'the virtual .md preview changed source bytes')
    await assert.rejects(readFile(`${blockFile}x`), { code: 'ENOENT' }, 'the virtual .md preview must not create an .mdx path')
    const blockCommit = blockPage.waitForResponse((response) => response.url().endsWith('/api/mdx-blocks/commit') && response.request().method() === 'POST')
    await blockPage.locator('#mdx-block-confirm').click()
    assert.equal((await blockCommit).status(), 409, 'existing MDX block replacement must fail closed')
    await blockPage.locator('#source-proposal-panel').waitFor({ state: 'visible' })
    const [blockDownload] = await Promise.all([
      blockPage.waitForEvent('download'), blockPage.locator('#source-proposal-export').click(),
    ])
    const blockProposal = JSON.parse(await readFile(await blockDownload.path(), 'utf8'))
    assert.deepEqual(blockProposal.target, { kind: 'mdx-blocks', id: 'block-fixture', sourceFormat: 'md' })
    assert.deepEqual(blockProposal.application, {
      mode: 'literal-markdown',
      rendersAsComponents: false,
      conversion: 'none',
      note: 'Applying this diff to a .md file leaves the generated calls as literal Markdown/HTML text; Astro does not execute them as components and no .md-to-.mdx conversion is performed.',
    })
    assert.equal(blockProposal.baseHash, createHash('sha256').update(blockSource).digest('hex'))
    assert.equal(blockProposal.change.operations.length, 1)
    assert.equal(blockProposal.change.operations[0].values.title, 'Installed package block')
    assert(Array.isArray(blockProposal.diffs) && blockProposal.diffs.length === 1)
    assert(!JSON.stringify(blockProposal).includes(blockFile), 'MDX block proposal disclosed the source path')
    assert(!JSON.stringify(blockProposal).includes(blockSource), 'MDX block proposal embedded the full source')
    assert.equal(await readFile(blockFile, 'utf8'), blockSource, 'blocked MDX block proposal changed source bytes')
    await blockPage.locator('#mdx-block-reset').click()
    await blockFrame.getByRole('heading', { name: 'Original Markdown block target' }).waitFor()
    assert.equal(await readFile(blockFile, 'utf8'), blockSource, 'reset after a virtual .md preview changed the original bytes')
    await assert.rejects(readFile(`${blockFile}x`), { code: 'ENOENT' }, 'reset must not leave an .mdx path')

    const failedBlockPage = await uiContext.newPage()
    await failedBlockPage.goto(`http://127.0.0.1:${port}/?route=block-failure`)
    await failedBlockPage.locator('#mdx-blocks-panel:not([hidden])').waitFor({ timeout: 15_000 })
    await failedBlockPage.locator('#mdx-block-target').selectOption('block-failure')
    const failedBlockFrame = failedBlockPage.frameLocator('#preview')
    await failedBlockFrame.getByRole('heading', { name: 'Astro compile failure target' }).waitFor()
    await failedBlockPage.locator('#mdx-block-add-field-title').fill('Fail Astro render')
    await failedBlockPage.locator('#mdx-block-add').click()
    await failedBlockPage.waitForFunction(
      () => document.querySelector('#mdx-blocks-status')?.textContent?.includes('Blockvorschau fehlgeschlagen'),
      null,
      { timeout: 25_000 },
    )
    assert.equal(await readFile(blockFailureFile, 'utf8'), blockFailureSource, 'unconfirmed Astro rendering must leave the original .md path and bytes untouched')
    await assert.rejects(readFile(`${blockFailureFile}x`), { code: 'ENOENT' }, 'a failed virtual preview must not create an .mdx path')
    assert.equal(await failedBlockPage.locator('#mdx-block-confirmation').isHidden(), true, 'an Astro compile failure must not enable proposal confirmation')
    await failedBlockFrame.getByRole('heading', { name: 'Astro compile failure target' }).waitFor()

    const galleryPage = await uiContext.newPage()
    await galleryPage.goto(`http://127.0.0.1:${port}/?route=references`)
    await galleryPage.locator('#gallery-picker button[data-gallery-id="internal-gallery"]').waitFor()
    await galleryPage.locator('#gallery-picker button[data-gallery-id="internal-gallery"]').click()
    await galleryPage.locator('#images button[aria-label^="Nach unten"]').first().click()
    await galleryPage.locator('#diff-confirmation:not([hidden])').waitFor()
    assert.match(await galleryPage.locator('#diff-after').textContent(), /beta[\s\S]*alpha/)
    const astroGalleryCommit = galleryPage.waitForResponse((response) => response.url().endsWith('/api/astro-galleries/commit') && response.request().method() === 'POST')
    await galleryPage.locator('#confirm-change').click()
    assert.equal((await astroGalleryCommit).status(), 409, 'Astro internal-array replacement must fail closed')
    const expectedGallery = astroGallerySource.replace('{ name: "alpha", alt: "Alpha", note: "keep-alpha" },\n  { name: "beta", alt: "Beta", note: "keep-beta" },', '{ name: "beta", alt: "Beta", note: "keep-beta" },\n  { name: "alpha", alt: "Alpha", note: "keep-alpha" },')
    await galleryPage.locator('#source-proposal-panel').waitFor({ state: 'visible' })
    const [galleryDownload] = await Promise.all([
      galleryPage.waitForEvent('download'), galleryPage.locator('#source-proposal-export').click(),
    ])
    const galleryProposal = JSON.parse(await readFile(await galleryDownload.path(), 'utf8'))
    assert.deepEqual(galleryProposal.target, { kind: 'astro-gallery', id: 'internal-gallery' })
    assert.equal(galleryProposal.baseHash, createHash('sha256').update(astroGallerySource).digest('hex'))
    assert.equal(galleryProposal.proposedHash, createHash('sha256').update(expectedGallery).digest('hex'))
    assert(!JSON.stringify(galleryProposal).includes(astroGalleryFile), 'Astro gallery proposal disclosed the source path')
    assert(!JSON.stringify(galleryProposal).includes(astroGallerySource), 'Astro gallery proposal embedded the full source')
    assert.equal(await readFile(astroGalleryFile, 'utf8'), astroGallerySource, 'blocked Astro gallery proposal changed source bytes')
  } finally { await uiBrowser.close() }
  let astroGalleryRendered = false
  for (let n = 0; n < 100; n++) {
    const response = await fetch(`http://127.0.0.1:${sitePort}/internal-gallery/`)
      if (response.ok) { const html = await response.text(); if (html.indexOf('data-image="alpha"') < html.indexOf('data-image="beta"') && html.includes('keep-beta') && html.includes('keep-alpha')) { astroGalleryRendered = true; break } }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(astroGalleryRendered, `Astro internal gallery did not preserve the source array order after the blocked edit: ${astroLogs}`)
  let mdxRendered = false
  for (let n = 0; n < 100; n++) {
    const page = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`)
      if (page.ok) { const html = await page.text(); if (html.includes('Original MDX label') && html.includes('data-rank="2"') && html.includes('data-enabled="true"') && html.includes('data-tone="quiet"')) { mdxRendered = true; break } }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!mdxRendered) {
    const last = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`).catch(() => null)
    throw new Error(`Astro MDX route did not render the unchanged installed-package source (last status ${last?.status ?? 'unavailable'}): ${(await last?.text())?.slice(0, 1200) ?? ''}\n${astroLogs}`)
  }
  const ui = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert(ui.includes('/referenzen/'), 'custom preview route not rendered by editor UI')
  console.log(`package smoke passed: ${packed.filename}, ${names.length} tarball entries, Astro production isolation, installed editor API, fail-closed existing-source proposals, exclusive collection entry creation, Dev Toolbar route launch, typed custom-component and nested-slot rendering, real Astro MDX block preview/proposal/reset, virtual .md rendering without rename, and compile-failure isolation, Astro internal-gallery proposals, exact source-byte preservation, and unchanged Astro rendering`)
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
