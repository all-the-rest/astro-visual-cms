import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, symlink, cp, rm, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEditorServer } from '../src/editor/server.mjs'
import { createSampleDevelopmentConfig } from '../src/editor/sample-dev-config.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: repo, stdio: 'inherit', ...opts })
  child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
})
const files = new Set((await new Promise((resolve, reject) => {
  const child = spawn('git', ['ls-files', '-z'], { cwd: repo }); let out = ''
  child.stdout.on('data', (chunk) => out += chunk); child.once('error', reject); child.once('exit', (code) => code ? reject(new Error('git ls-files failed')) : resolve(out))
})).split('\0').filter(Boolean))
// This harness must also copy a newly added dev-only bridge dependency before its first commit.
files.add('src/lib/markdown-paragraph-map.mjs')
files.add('src/editor/sample-dev-config.mjs')
const root = await mkdtemp(path.join(tmpdir(), 'avcms-readonly-'))
const receipt = path.join(repo, 'test-results', 'readonly-copy-path')
const collectionReceipt = path.join(repo, 'test-results', 'readonly-collection-copy-path')
const markdownReceipt = path.join(repo, 'test-results', 'readonly-markdown-copy-path')
const mdxConflictReceipt = path.join(repo, 'test-results', 'readonly-mdx-conflict-copy-path')
const sampleDraftReceipt = path.join(repo, 'test-results', 'readonly-sample-draft-copy-path')
const children = []
let editor
let astroStarted = false
let cleanupPromise
function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      const childExits = children.map((child) => child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, 'exit').catch(() => {}))
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const forceKill = setTimeout(() => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 5_000)
      forceKill.unref()
      if (editor?.listening) {
        const closed = new Promise((resolve) => editor.close(resolve))
        editor.closeAllConnections?.()
        await closed
      }
      await Promise.all(childExits)
      clearTimeout(forceKill)
      if (astroStarted) {
        await run(process.execPath, [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'dev', 'stop'], { cwd: root }).catch(() => {})
        astroStarted = false
      }
      if (process.env.AVCMS_PRESERVE_FAILED_COPY !== '1') await rm(root, { recursive: true, force: true })
      await rm(receipt, { force: true })
      await rm(collectionReceipt, { force: true })
      await rm(markdownReceipt, { force: true })
      await rm(mdxConflictReceipt, { force: true })
      await rm(sampleDraftReceipt, { force: true })
    })()
  }
  return cleanupPromise
}
process.once('SIGTERM', () => cleanup().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) }))
process.once('SIGINT', () => cleanup().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) }))
try {
  for (const file of files) {
    if (['.git', 'node_modules', 'dist', '.astro', 'playwright-report', 'test-results'].includes(file.split('/')[0])) continue
    const dest = path.join(root, file); await mkdir(path.dirname(dest), { recursive: true }); await cp(path.join(repo, file), dest)
  }
  await symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  await run(process.execPath, [path.join(root, 'scripts/generate-noise.mjs')], { cwd: root })
  const fixture = path.join(root, 'src/pages/fixture.mdx')
  const mode = process.env.AVCMS_READONLY_MODE || 'duplicate'
  if (!['duplicate', 'unmapped', 'gallery', 'collection', 'markdown', 'mdx-conflict', 'sample-draft'].includes(mode)) throw new Error('AVCMS_READONLY_MODE must be duplicate, unmapped, gallery, collection, markdown, mdx-conflict, or sample-draft.')
  if (mode === 'duplicate') {
    const original = await readFile(fixture, 'utf8')
    if (!original.includes('id="marker-two"')) throw new Error('Synthetic duplicate-ID fixture anchor was not found.')
    await writeFile(fixture, original.replace('id="marker-two"', 'id="marker-one"'))
  } else if (mode === 'unmapped') {
    const component = path.join(root, 'src/components/EditorUnknownChip.astro')
    const source = await readFile(component, 'utf8')
    if (!source.includes('data-astro-visual-cms-instance={id}')) throw new Error('Synthetic component marker anchor was not found.')
    await writeFile(component, source.replace('data-astro-visual-cms-instance={id}', 'data-astro-visual-cms-instance={id.toUpperCase()}'))
  } else if (mode === 'gallery') {
    const original = await readFile(fixture, 'utf8')
    const importAnchor = "import EditorUnknownChip from '../components/EditorUnknownChip.astro';"
    const galleryAnchor = '<Gallery sorted={HIGHLIGHTS} />'
    if (!original.includes(importAnchor) || !original.includes(galleryAnchor)) throw new Error('Synthetic gallery fixture anchors were not found.')
    await writeFile(path.join(root, 'src/components/NestedUnknown.astro'), '<div data-nested-unknown><slot /></div>\n')
    await writeFile(fixture, original.replace(importAnchor, `${importAnchor}\nimport NestedUnknown from '../components/NestedUnknown.astro';`).replace(galleryAnchor, '<NestedUnknown><Gallery sorted={HIGHLIGHTS} /></NestedUnknown>'))
  } else if (mode === 'collection') {
    const contentRoot = path.join(root, 'src/content/acceptance-notes')
    const contentFile = path.join(contentRoot, 'nested', 'entry.mdx')
    const configFile = path.join(root, 'src/content.config.ts')
    const pageFile = path.join(root, 'src/pages/collection-proof.astro')
    await mkdir(path.dirname(contentFile), { recursive: true })
    await writeFile(configFile, `import { defineCollection, z } from 'astro:content';\nimport { glob } from 'astro/loaders';\nexport const collections = { notes: defineCollection({ loader: glob({ pattern: '**/*.mdx', base: './src/content/acceptance-notes' }), schema: z.object({ title: z.string(), rank: z.number() }) }) };\n`)
    await writeFile(contentFile, `---\ntitle: "Synthetic collection entry"\nrank: 7\n---\nimport EditorUnknownChip from '../../../components/EditorUnknownChip.astro'\n\n# Collection body remains MDX\n\n<EditorUnknownChip id="collection-proof" label="Nested synthetic component" />\n`)
    await writeFile(pageFile, `---\nimport { getCollection, render } from 'astro:content';\nconst [entry] = await getCollection('notes');\nif (!entry) throw new Error('Synthetic MDX collection entry was not loaded.');\nconst { Content } = await render(entry);\n---\n<html><body><h1 data-entry-title>{entry.data.title}</h1><p data-entry-rank={String(entry.data.rank)}>{entry.data.rank}</p><Content /></body></html>\n`)
    await mkdir(path.dirname(collectionReceipt), { recursive: true })
    await writeFile(collectionReceipt, JSON.stringify({ contentFile, configFile, pageFile }))
  } else if (mode === 'mdx-conflict') {
    const files = ['mdx-conflict-one.mdx', 'mdx-conflict-two.mdx'].map((name) => path.join(root, 'src/pages', name))
    for (const [index, file] of files.entries()) await writeFile(file, `import EditorUnknownChip from '../components/EditorUnknownChip.astro'\n\n<EditorUnknownChip id="conflict-${index + 1}" label="Initial ${index + 1}" title="Title ${index + 1}" />\n`)
    await mkdir(path.dirname(mdxConflictReceipt), { recursive: true })
    await writeFile(mdxConflictReceipt, JSON.stringify(files))
  } else if (mode === 'sample-draft') {
    const contentFile = path.join(root, 'src/content/reisinger-like/editorial/showcase/index.mdx')
    await mkdir(path.dirname(sampleDraftReceipt), { recursive: true })
    await writeFile(sampleDraftReceipt, contentFile)
  } else {
    const markdownFile = path.join(root, 'src/pages/markdown-proof.mdx')
    await writeFile(markdownFile, 'Synthetic mapped Markdown paragraph.\n')
    const astroConfig = path.join(root, 'astro.config.mjs')
    const configSource = await readFile(astroConfig, 'utf8')
    const integrationCall = 'createLoopbackDevIntegration({'
    const configuredIntegration = `createLoopbackDevIntegration({ markdownParagraphTargets: [{ id: 'markdown-note', instanceId: 'paragraph-one', filePath: path.join(PROJECT_ROOT, 'src/pages/markdown-proof.mdx') }],`
    if (!configSource.includes(integrationCall)) throw new Error('Synthetic Astro integration anchor was not found for the Markdown copy gate.')
    await writeFile(astroConfig, configSource.replace(integrationCall, configuredIntegration))
    await mkdir(path.dirname(markdownReceipt), { recursive: true })
    await writeFile(markdownReceipt, markdownFile)
  }
  await mkdir(path.dirname(receipt), { recursive: true }); await writeFile(receipt, fixture)
  const sitePort = 15331, editorPort = 15332
  const astroBin = path.join(root, 'node_modules/astro/bin/astro.mjs')
  await run(process.execPath, [astroBin, 'dev', '--background', '--host', '127.0.0.1', '--port', String(sitePort)], {
    cwd: root,
    env: { ...process.env, ASTRO_BASE_PATH: '/browser-synthetic/', EDITOR_PORT: String(editorPort) },
  })
  astroStarted = true
  const sampleOptions = mode === 'sample-draft' ? createSampleDevelopmentConfig(root) : null
  // Every mode runs with existing-source replacement fail-closed; edit confirmations export proposals only.
  editor = createEditorServer({
    port: editorPort, sitePort, fixturePath: fixture, basePath: '/browser-synthetic/',
    ...(mode === 'collection' ? { previewRoutes: [
      { id: 'home', label: 'Startseite', path: '/' },
      { id: 'fixture', label: 'Fixture', path: '/fixture/', cacheBustOnRevision: true },
      { id: 'collection', label: 'Collection proof', path: '/collection-proof/' },
    ] } : {}),
    ...(mode === 'collection' ? { projectRoot: root, contentConfigPath: 'src/content.config.ts' } : {}),
    ...(mode === 'markdown' ? { mdxParagraphTargets: [{ id: 'markdown-note', instanceId: 'paragraph-one', projectRoot: root, filePath: path.join(root, 'src/pages/markdown-proof.mdx') }] } : {}),
    ...(sampleOptions ? {
      fixturePath: sampleOptions.fixturePath,
      projectRoot: sampleOptions.projectRoot,
      contentConfigPath: sampleOptions.contentConfigPath,
      markdownDraftTargets: sampleOptions.markdownDraftTargets,
      previewRoutes: sampleOptions.previewRoutes,
    } : {}),
    ...(mode === 'mdx-conflict' ? { mdxComponentTargets: ['one', 'two'].map((id) => ({ id, projectRoot: root, filePath: path.join(root, `src/pages/mdx-conflict-${id}.mdx`), importSource: '../components/EditorUnknownChip.astro', idProp: 'id', fields: [{ name: 'label', type: 'string' }, { name: 'title', type: 'string' }] })) } : {}),
    ...(['collection', 'markdown', 'mdx-conflict'].includes(mode) ? {} : { mdxComponentTargets: [{ id: 'fixture', projectRoot: root, filePath: fixture, importSource: '../components/EditorUnknownChip.astro', idProp: 'id', editableProps: ['label'] }] }),
  })
  const deadline = Date.now() + 110_000
  while (Date.now() < deadline) {
    try {
      const route = mode === 'sample-draft' ? 'reisinger-sample/editorial/showcase/' : 'fixture/'
      if ((await fetch(`http://127.0.0.1:${sitePort}/browser-synthetic/${route}`)).ok) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (Date.now() >= deadline) throw new Error('Astro route did not start.')
  await new Promise((resolve, reject) => {
    editor.once('error', reject)
    editor.listen(editorPort, '127.0.0.1', resolve)
  })
  await new Promise(() => {})
} catch (error) { console.error(error); await cleanup(); process.exitCode = 1 }
