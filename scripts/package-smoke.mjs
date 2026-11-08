import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
  for (const required of ['LICENSE', 'src/editor/astro-integration.mjs', 'src/editor/server.mjs', 'src/editor/cli.mjs', 'docs/editor-package.md']) assert(names.includes(required), `tarball missing ${required}`)
  assert(!names.some((name) => name.startsWith('test/') || name.startsWith('src/pages/')), 'demo app/test files leaked into tarball')
  const consumer = path.join(temp, 'consumer')
  await mkdir(path.join(consumer, 'src/pages'), { recursive: true })
  await mkdir(path.join(consumer, 'src/content/notes'), { recursive: true })
  await mkdir(path.join(consumer, 'src/components'), { recursive: true })
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'astro build' } }))
  await writeFile(path.join(consumer, 'astro.config.mjs'), `import { defineConfig } from 'astro/config'; import mdx from '@astrojs/mdx'; import { createLoopbackDevIntegration } from '@astro-visual-cms/editor/integration'; export default defineConfig({ integrations: [mdx(), createLoopbackDevIntegration()] })`)
  await writeFile(path.join(consumer, 'src/pages/referenzen.astro'), '<html><body>Referenzen-Beweis</body></html>')
  await writeFile(path.join(consumer, 'src/components/Gallery.astro'), '---\nconst { sorted = [] } = Astro.props\n---\n<section>{sorted.join(",")}</section>')
  const fixtureFile = path.join(consumer, 'src/pages/fixture.mdx')
  await writeFile(fixtureFile, 'import Gallery from "../components/Gallery.astro";\n\nexport const ITEMS = ["noise-fixture-01", "noise-fixture-02", "noise-fixture-03"];\n\n<Gallery sorted={ITEMS} />')
  const mdxFile = path.join(consumer, 'src/pages/mdx-proof.mdx')
  const mdxSource = 'import Card from "../components/Card.astro";\n\n<Card id="fixture-gallery" label="Original MDX label" />'
  await writeFile(path.join(consumer, 'src/components/Card.astro'), '---\nconst { id, label = "" } = Astro.props\n---\n<section data-card-id={id}>{label}</section>')
  await writeFile(mdxFile, mdxSource)
  await writeFile(path.join(consumer, 'src/content.config.ts'), `import { defineCollection, z } from 'astro:content'; export const collections = { notes: defineCollection({ type: 'content', schema: z.object({ title: z.string() }) }) }`)
  await writeFile(path.join(consumer, 'src/content/notes/one.md'), '---\ntitle: One\n---\nText')
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-save', path.join(temp, packed.filename), 'astro@7.4.7', '@astrojs/mdx@8.1.3'], { cwd: consumer, encoding: 'utf8', timeout: 180000 })
  assert.equal(install.status, 0, install.stderr)
  const build = spawnSync('npm', ['run', 'build'], { cwd: consumer, encoding: 'utf8', timeout: 180000 })
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
  assert((await readFile(path.join(consumer, 'dist/referenzen/index.html'), 'utf8')).includes('Referenzen-Beweis'))
  assert((await readFile(path.join(consumer, 'dist/mdx-proof/index.html'), 'utf8')).includes('Original MDX label'), 'Astro did not compile the synthetic MDX target')
  const port = 19000 + Math.floor(Math.random() * 1000)
  const sitePort = port + 1000
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
  const config = { port, sitePort, projectRoot: '.', contentConfigPath: 'src/content.config.ts', fixturePath: 'src/pages/fixture.mdx', previewRoutes: [{ id: 'references', label: 'Referenzen', path: '/referenzen/' }], mdxComponentTargets: [{ id: 'fixture-gallery', projectRoot: '.', filePath: 'src/pages/mdx-proof.mdx', importSource: '../components/Card.astro', idProp: 'id', editableProps: ['label'] }] }
  await writeFile(path.join(consumer, 'editor.json'), JSON.stringify(config))
  child = spawn(path.join(consumer, 'node_modules/.bin/astro-visual-cms-editor'), ['--config', 'editor.json'], { cwd: consumer, stdio: 'ignore', detached: process.platform !== 'win32' })
  let response
  for (let n = 0; n < 60; n++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/collections`); break } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  assert(response?.ok, 'installed editor server did not start')
  const state = await response.json()
  assert.equal(state.configured, true)
  assert(state.collections.some((collection) => collection.id === 'notes'), 'content collection not exposed')
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token
  const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-editor-token': token }
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
  const mdxAfter = mdxSource.replace('label="Original MDX label"', 'label="Installed MDX edit"')
  assert.equal(await readFile(mdxFile, 'utf8'), mdxAfter, 'MDX adapter changed bytes outside the selected literal')
  let mdxRendered = false
  for (let n = 0; n < 100; n++) {
    const page = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`)
    if (page.ok && (await page.text()).includes('Installed MDX edit')) { mdxRendered = true; break }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!mdxRendered) {
    const last = await fetch(`http://127.0.0.1:${sitePort}/mdx-proof/`).catch(() => null)
    throw new Error(`Astro MDX route did not rerender the confirmed installed-package edit (last status ${last?.status ?? 'unavailable'}): ${(await last?.text())?.slice(0, 1200) ?? ''}\n${astroLogs}`)
  }
  const ui = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert(ui.includes('/referenzen/'), 'custom preview route not rendered by editor UI')
  console.log(`package smoke passed: ${packed.filename}, ${names.length} tarball entries, Astro build, installed editor API, MDX preview/commit and HMR`)
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
