import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashSource } from '../src/lib/gallery-patch.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ASTRO_CLI = path.join(ROOT, 'node_modules/astro/bin/astro.mjs')
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64')
// The default Astro Markdown processor is Sätteri. Resolve its package from the
// pinned Astro installation so the regression exercises the real plugin
// pipeline instead of a synthetic renderer stub.
const pnpmPackages = await readdir(path.join(ROOT, 'node_modules/.pnpm'))
const astroPackage = pnpmPackages.find((name) => name.startsWith('astro@'))
const satteriProcessorPath = astroPackage
  ? path.join(ROOT, 'node_modules/.pnpm', astroPackage, 'node_modules/@astrojs/markdown-satteri/dist/satteri-processor.js')
  : ''

function availablePort() {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitFor(url, child, getLogs) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolated Astro dev exited early (${child.exitCode}):\n${getLogs()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (response.ok) return response
    } catch {
      // Astro has not opened its listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${url}:\n${getLogs()}`)
}

const blockTypes = [{
  type: 'card', label: 'Card', componentName: 'Card', importSource: '../components/Card.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}, {
  type: 'boom', label: 'Boom', componentName: 'Boom', importSource: '../components/Boom.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}]

async function createSite(t, { source, sentinel = null, targetFile = 'src/pages/blocks.md', previewPath = '/blocks/', extraFiles = [], configImports = '', configExtras = '' }) {
  const created = await mkdtemp(path.join(tmpdir(), 'astro-virtual-md-preview-'))
  t.after(() => rm(created, { recursive: true, force: true }))
  // Astro compares module ids with the configured root; use the canonical path
  // so `/var` vs `/private/var` does not split the project into two roots.
  const directory = await realpath(created)
  await symlink(path.join(ROOT, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n')
  await mkdir(path.join(directory, 'src/pages'), { recursive: true })
  await mkdir(path.join(directory, 'src/components'), { recursive: true })
  await mkdir(path.join(directory, 'src/layouts'), { recursive: true })
  await mkdir(path.join(directory, 'src/assets'), { recursive: true })
  const file = path.join(directory, targetFile)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, source)
  for (const [name, contents] of extraFiles) {
    const extra = path.join(directory, name)
    await mkdir(path.dirname(extra), { recursive: true })
    await writeFile(extra, contents)
  }
  await writeFile(path.join(directory, 'src/assets/pixel.png'), PIXEL)
  await writeFile(path.join(directory, 'src/components/Card.astro'), '---\nconst { id, title = "" } = Astro.props\n---\n<article data-virtual-card={id}><h2>{title}</h2></article>\n<style>article[data-virtual-card]{outline:1px solid rgb(1, 2, 3)}</style>')
  await writeFile(path.join(directory, 'src/components/Boom.astro'), '---\nconst { id, title = "" } = Astro.props\nif (title === "fail") throw new Error("Synthetic block render failure")\n---\n<article data-boom={id}>{title}</article>')
  await writeFile(path.join(directory, 'src/layouts/Post.astro'), '---\nconst { frontmatter, headings } = Astro.props\n---\n<html><head><title>{frontmatter.title}</title></head><body data-layout="post" data-headings={headings.length}><slot /></body></html>')
  if (sentinel) {
    await writeFile(path.join(directory, 'src/components/Sentinel.astro'), `---\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(sentinel)}, 'sentinel-component-module')\n---\n<div data-sentinel>sentinel rendered</div>`)
  }
  const integrationUrl = pathToFileURL(path.join(ROOT, 'src/editor/astro-integration.mjs')).href
  const config = `import { defineConfig } from 'astro/config';\n` +
    `import mdx from '@astrojs/mdx';\n` +
    configImports +
    `import { createLoopbackDevIntegration } from '${integrationUrl}';\n` +
    `const root = new URL('.', import.meta.url).pathname;\n` +
    `export default defineConfig({ root, ${configExtras} integrations: [mdx(), createLoopbackDevIntegration({ previewRoutes: [{ id: 'blocks', path: '${previewPath}' }], mdxBlockTargets: [{ id: 'blocks', projectRoot: root, filePath: new URL('./${targetFile}', import.meta.url).pathname, previewRouteId: 'blocks', blockTypes: ${JSON.stringify(blockTypes)} }] })] });\n`
  await writeFile(path.join(directory, 'astro.config.mjs'), config)
  return { directory, file }
}

async function startSite(t, directory) {
  const port = await availablePort()
  const child = spawn(process.execPath, [ASTRO_CLI, 'dev', '--root', directory, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: directory,
    env: { ...process.env, NODE_ENV: 'development', ASTRO_TELEMETRY_DISABLED: '1', ASTRO_DEV_BACKGROUND: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })
  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  t.after(stop)
  const origin = `http://127.0.0.1:${port}`
  const page = async () => {
    const response = await fetch(`${origin}/blocks/?cache=${Date.now()}`, { signal: AbortSignal.timeout(30_000) })
    return { status: response.status, html: await response.text() }
  }
  // The editor reloads after the bridge preview; Astro may still be
  // invalidating modules, so retry until the expected render is visible.
  const pageMatching = async (pattern, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      last = await page()
      if (last.status === 200 && pattern.test(last.html)) return last
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return last
  }
  await waitFor(`${origin}/blocks/`, child, () => logs)
  const bridge = await (await fetch(`${origin}/@id/astro:scripts/page.js`)).text()
  const token = bridge.match(/const blockPreviewToken="([a-f0-9]{64})"/)?.[1]
  assert.ok(token, 'the injected bridge must expose the preview token to the same-origin page')
  const headers = {
    host: new URL(origin).host,
    origin,
    referer: `${origin}/blocks/`,
    'content-type': 'application/json',
    'x-avcms-token': token,
  }
  const preview = (body) => fetch(`${origin}/__avcms/mdx-block-preview`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { origin, child, logs: () => logs, page, pageMatching, headers, preview, stop }
}

test('a .md block preview is rendered by the real Astro dev route without a source write', { timeout: 75_000 }, async (t) => {
  const source = '# Virtual Markdown route\n\nThe saved Markdown paragraph survives unchanged.\n'
  const { directory, file } = await createSite(t, { source })
  const site = await startSite(t, directory)
  try {
    const initial = await site.page()
    assert.match(initial.html, /Virtual Markdown route/)
    assert.doesNotMatch(initial.html, /data-virtual-card/)
    const preview = await site.preview({
      targetId: 'blocks', requestId: 'virtual-md-preview', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-virtual', blockType: 'card', values: { title: 'Rendered by Astro' } }],
    })
    assert.equal(preview.status, 200, `${await preview.text()}\n${site.logs()}`)
    assert.equal(await readFile(file, 'utf8'), source, 'the preview wrote the Markdown source')
    await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' }, 'the preview created an .mdx path')
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.startsWith('.')), [], 'the preview created a virtual source file')

    const rendered = await site.pageMatching(/data-virtual-card="block-virtual"/)
    assert.match(rendered.html, /data-virtual-card="block-virtual"/)
    assert.match(rendered.html, /Rendered by Astro<\/h2>/)
    assert.match(rendered.html, /outline: 1px solid (?:#010203|rgb\(1, 2, 3\))/, 'component styles must still be emitted for the preview page')
    assert.match(rendered.html, /The saved Markdown paragraph survives unchanged/)
    assert.equal(await readFile(file, 'utf8'), source)

    // A slow editor render must still be able to acknowledge its draft. Waiting
    // longer than the previous 6-second grace reproduces the old mid-flight drop
    // with the real default plugin configuration.
    await new Promise((resolve) => setTimeout(resolve, 6_500))
    const acknowledged = await site.preview({ targetId: 'blocks', requestId: 'virtual-md-preview', rendered: true })
    assert.equal(acknowledged.status, 200, 'a render acknowledged after 6.5s must still be accepted')

    const reset = await site.preview({ targetId: 'blocks', requestId: 'virtual-md-reset', reset: true })
    assert.equal(reset.status, 200)
    const restored = await site.page()
    assert.doesNotMatch(restored.html, /data-virtual-card/)
    assert.match(restored.html, /Virtual Markdown route/)
    assert.equal(await readFile(file, 'utf8'), source)
    await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${site.logs()}`)
  } finally {
    await site.stop()
  }
})

test('plain Markdown expressions, JSX, ESM and code fences are never executed or converted', { timeout: 90_000 }, async (t) => {
  const sentinel = path.join(await mkdtemp(path.join(tmpdir(), 'avcms-sentinel-')), 'executed.txt')
  t.after(() => rm(path.dirname(sentinel), { recursive: true, force: true }))
  const write = JSON.stringify(sentinel)
  const source = [
    '---',
    'title: "Adversarial --- Markdown"',
    'layout: ../layouts/Post.astro',
    '---',
    '',
    'import { writeFileSync } from "node:fs"',
    "import Sentinel from '../components/Sentinel.astro'",
    '',
    '# Adversarial Markdown',
    '',
    `An inline placeholder {writeFileSync(${write}, "inline")} stays literal text.`,
    '',
    `{writeFileSync(${write}, "flow")}`,
    '',
    `export const pwned = writeFileSync(${write}, "esm")`,
    '',
    '<Sentinel />',
    '',
    '<div data-legit-html="kept">Raw HTML survives.</div>',
    '',
    '```js',
    'const literal = { writeFileSync: true }',
    '<Card id="in-code" title="code" />',
    '```',
    '',
    `Inline \`{writeFileSync(${write}, "code")}\` stays inline code and <Card id="inline" title="text" /> stays text.`,
    '',
    '![pixel](../assets/pixel.png)',
    '',
  ].join('\n')
  const { directory, file } = await createSite(t, { source, sentinel })
  const site = await startSite(t, directory)
  try {
    const initial = await site.page()
    assert.equal(initial.status, 200, site.logs())
    // Nothing in the saved Markdown was executed as MDX/ESM/JSX.
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' }, 'pre-existing Markdown was executed server-side')
    // The frontmatter layout and Markdown headings are still applied.
    assert.match(initial.html, /data-layout="post"/)
    assert.match(initial.html, /data-headings="1"/)
    assert.match(initial.html, /<title>Adversarial --- Markdown<\/title>/)
    // Ordinary Markdown semantics survive: headings, prose, code fences, inline
    // code, raw HTML and Astro-processed images.
    assert.match(initial.html, /<h1 id="adversarial-markdown">Adversarial Markdown<\/h1>/)
    assert.match(initial.html, /An inline placeholder \{writeFileSync\([^)]*\)\} stays literal text\./)
    assert.match(initial.html, /\{writeFileSync\([^)]*\)\}/)
    assert.match(initial.html, /export const pwned = writeFileSync\(/)
    assert.match(initial.html, /import Sentinel from /)
    assert.match(initial.html, /<div data-legit-html="kept">Raw HTML survives\.<\/div>/)
    assert.match(initial.html, /data-language="js"[\s\S]*\{ writeFileSync: /)
    assert.match(initial.html, /&lt;[\s\S]*Card[\s\S]*in-code[\s\S]*\/&gt;/)
    assert.match(initial.html, /<img[^>]+alt="pixel"/)
    assert.doesNotMatch(initial.html, /data-sentinel/)
    assert.doesNotMatch(initial.html, /data-virtual-card/)

    // The one thing that becomes a component is the catalog-generated block.
    const preview = await site.preview({
      targetId: 'blocks', requestId: 'adversarial-preview', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-adversarial', blockType: 'card', values: { title: 'Trusted block' } }],
    })
    assert.equal(preview.status, 200, `${await preview.text()}\n${site.logs()}`)
    const rendered = await site.pageMatching(/data-virtual-card="block-adversarial"/)
    assert.equal(rendered.status, 200, site.logs())
    assert.match(rendered.html, /data-virtual-card="block-adversarial"/)
    assert.match(rendered.html, /Trusted block<\/h2>/)
    assert.match(rendered.html, /Raw HTML survives\./)
    assert.match(rendered.html, /An inline placeholder \{writeFileSync/)
    assert.doesNotMatch(rendered.html, /data-sentinel/)
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' }, 'the preview executed pre-existing Markdown')
    assert.equal(await readFile(file, 'utf8'), source, 'the preview wrote the Markdown source')
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.startsWith('.')), [])

    const reset = await site.preview({ targetId: 'blocks', requestId: 'adversarial-reset', reset: true })
    assert.equal(reset.status, 200)
    const restored = await site.page()
    assert.doesNotMatch(restored.html, /data-virtual-card/)
    assert.match(restored.html, /Adversarial Markdown/)
    assert.equal(await readFile(file, 'utf8'), source)
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${site.logs()}`)
  } finally {
    await site.stop()
  }
})

test('a failing generated component is discarded and the saved Markdown recovers', { timeout: 75_000 }, async (t) => {
  const source = '# Recovery target\n\nSaved prose that must return unchanged.\n'
  const { directory, file } = await createSite(t, { source })
  const site = await startSite(t, directory)
  try {
    const preview = await site.preview({
      targetId: 'blocks', requestId: 'failing-preview', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-failing', blockType: 'boom', values: { title: 'fail' } }],
    })
    assert.equal(preview.status, 200, `${await preview.text()}\n${site.logs()}`)
    // The throwing component cannot render: the route surfaces the Astro error
    // and never confirms the draft. The editor (or the bounded expiry) resets
    // the overlay, and the saved Markdown renders again.
    const failed = await site.page()
    assert.equal(failed.html.includes('Saved prose that must return unchanged'), false, failed.html.slice(0, 4000))
    assert.doesNotMatch(failed.html, /data-boom/)
    const reset = await site.preview({ targetId: 'blocks', requestId: 'failing-reset', reset: true })
    assert.equal(reset.status, 200)
    assert.equal((await reset.json()).changed, true)
    const recovered = await site.page()
    assert.equal(recovered.status, 200, site.logs())
    assert.doesNotMatch(recovered.html, /data-boom/)
    assert.match(recovered.html, /Saved prose that must return unchanged/)
    assert.equal(await readFile(file, 'utf8'), source)
    await assert.rejects(readFile(`${file}x`), { code: 'ENOENT' })
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.startsWith('.')), [])
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${site.logs()}`)
  } finally {
    await site.stop()
  }
})

test('final Markdown metadata produced by a real Satteri plugin is carried into the preview', { timeout: 90_000 }, async (t) => {
  assert.ok(satteriProcessorPath && (await import('node:fs')).existsSync(satteriProcessorPath), 'the pinned Astro Sätteri processor must be available')
  const source = [
    '---',
    'title: "Original frontmatter title"',
    'layout: ../layouts/Post.astro',
    '---',
    '',
    '# Plugin metadata target',
    '',
    'Saved prose with plugin-derived metadata.',
    '',
  ].join('\n')
  const configImports = `import { createSatteriMarkdownProcessor } from ${JSON.stringify(pathToFileURL(satteriProcessorPath).href)};\n` +
    `const metadataPlugin = { name: 'test-metadata', before(root, ctx) { ctx.data.astro.frontmatter = { ...ctx.data.astro.frontmatter, title: 'Plugin metadata title', computedByPlugin: true }; } };\n`
  const configExtras = `markdown: { processor: { name: 'satteri', options: { mdastPlugins: [metadataPlugin], hastPlugins: [], features: {} }, createRenderer(shared) { return createSatteriMarkdownProcessor({ ...shared, mdastPlugins: [metadataPlugin], hastPlugins: [], features: {} }); } } },`
  const { directory, file } = await createSite(t, { source, configImports, configExtras })
  const site = await startSite(t, directory)
  try {
    // The saved page already sees the plugin's transformed layout metadata.
    const initial = await site.page()
    assert.equal(initial.status, 200, site.logs())
    assert.match(initial.html, /<title>Plugin metadata title<\/title>/)
    assert.doesNotMatch(initial.html, /<title>Original frontmatter title<\/title>/)

    const preview = await site.preview({
      targetId: 'blocks', requestId: 'plugin-metadata-preview', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-plugin', blockType: 'card', values: { title: 'Plugin preview block' } }],
    })
    assert.equal(preview.status, 200, `${await preview.text()}\n${site.logs()}`)
    const rendered = await site.pageMatching(/data-virtual-card="block-plugin"/)
    assert.equal(rendered.status, 200, site.logs())
    // The virtual page must carry the renderer's final metadata, not the raw YAML.
    assert.match(rendered.html, /<title>Plugin metadata title<\/title>/)
    assert.doesNotMatch(rendered.html, /<title>Original frontmatter title<\/title>/)
    assert.equal(await readFile(file, 'utf8'), source)
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${site.logs()}`)
  } finally {
    await site.stop()
  }
})

test('a Content Layer .md route is detected instead of falsely confirming an overlay', { timeout: 90_000 }, async (t) => {
  const source = [
    '---',
    'title: "Content Layer title"',
    '---',
    '',
    '# Content Layer body',
    '',
    'Saved content-layer prose.',
    '',
  ].join('\n')
  const extraFiles = [
    ['src/content.config.ts', `import { defineCollection } from 'astro:content';\nimport { glob } from 'astro/loaders';\nimport { z } from 'astro/zod';\nexport const collections = { pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }) };\n`],
    ['src/pages/blocks/index.astro', `---\nimport { getEntry, render } from 'astro:content';\nconst entry = await getEntry('pages', 'blocks');\nconst { Content } = await render(entry);\n---\n<html><body data-content-layer>{entry.data.title}<Content /></body></html>\n`],
  ]
  const { directory, file } = await createSite(t, { source, targetFile: 'src/content/pages/blocks.md', extraFiles })
  const site = await startSite(t, directory)
  try {
    const initial = await site.page()
    assert.equal(initial.status, 200, site.logs())
    assert.match(initial.html, /Content Layer body/)
    assert.doesNotMatch(initial.html, /data-virtual-card/)

    const preview = await site.preview({
      targetId: 'blocks', requestId: 'content-layer-preview', hash: hashSource(source),
      operations: [{ action: 'add', blockId: 'block-content-layer', blockType: 'card', values: { title: 'Must not be claimed' } }],
    })
    assert.equal(preview.status, 200, `${await preview.text()}\n${site.logs()}`)
    // The route renders the Content Layer store, so the reloaded page still
    // shows the saved source even though the server armed a draft.
    const rendered = await site.page()
    assert.equal(rendered.status, 200, site.logs())
    assert.doesNotMatch(rendered.html, /data-virtual-card/)
    assert.match(rendered.html, /Saved content-layer prose\./)
    const acknowledgment = await site.preview({ targetId: 'blocks', requestId: 'content-layer-preview', rendered: true })
    assert.equal(acknowledgment.status, 409)
    const failure = await acknowledgment.json()
    assert.equal(failure.code, 'PREVIEW_NOT_OVERLAID', JSON.stringify(failure))
    assert.match(failure.error, /Content Layer|did not request this source module/)
    // The draft is gone and the saved bytes are untouched.
    const reset = await site.preview({ targetId: 'blocks', requestId: 'content-layer-reset', reset: true })
    assert.equal(reset.status, 200)
    assert.equal((await reset.json()).changed, false)
    assert.equal(await readFile(file, 'utf8'), source)
    const recovered = await site.page()
    assert.equal(recovered.status, 200, site.logs())
    assert.match(recovered.html, /Saved content-layer prose\./)
    assert.doesNotMatch(recovered.html, /data-virtual-card/)
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${site.logs()}`)
  } finally {
    await site.stop()
  }
})

test('an applied .md proposal stays literal HTML and is never executed as a component', { timeout: 75_000 }, async (t) => {
  const source = [
    '# Applied Markdown proposal',
    '',
    '<!-- astro-visual-cms:blocks:start -->',
    '<Card id="applied-literal" title="Literal HTML only" />',
    '<!-- astro-visual-cms:blocks:end -->',
    '',
    'Saved prose after the editor-owned zone.',
    '',
  ].join('\n')
  const { directory, file } = await createSite(t, { source })
  const site = await startSite(t, directory)
  try {
    const page = await site.page()
    assert.equal(page.status, 200, site.logs())
    assert.match(page.html, /Applied Markdown proposal/)
    assert.match(page.html, /Saved prose after the editor-owned zone\./)
    // In a `.md` page the call is raw HTML text, exactly as the exported
    // `application.mode: literal-markdown` proposal states.
    assert.doesNotMatch(page.html, /data-virtual-card/)
    assert.match(page.html, /id="applied-literal"/i)
    assert.match(page.html, /Literal HTML only/)
    assert.equal(await readFile(file, 'utf8'), source)
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${site.logs()}`)
  } finally {
    await site.stop()
  }
})
