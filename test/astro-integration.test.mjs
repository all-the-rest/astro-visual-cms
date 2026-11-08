import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { astroBaseConfigValue, normalizeAstroBasePath } from '../src/editor/base-path.mjs'
import { createLoopbackDevIntegration } from '../src/editor/astro-integration.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ASTRO_CLI = path.join(ROOT, 'node_modules/astro/bin/astro.mjs')

test('Astro base paths normalize safely and reject traversal, query, and hash values', () => {
  assert.equal(normalizeAstroBasePath('/'), '/')
  assert.equal(normalizeAstroBasePath('/preview'), '/preview/')
  assert.equal(normalizeAstroBasePath('/preview/'), '/preview/')
  assert.equal(astroBaseConfigValue('/'), '/')
  assert.equal(astroBaseConfigValue('/preview/'), '/preview')

  for (const value of [
    'preview', '//other-host/path', '/../../outside/', '/a/../b/', '/safe?query=1',
    '/safe#fragment', '/%2e%2e/', '/back\\slash/', '/space here/', '/semi;colon/', '/duplicate//slash/',
  ]) {
    assert.throws(() => normalizeAstroBasePath(value), TypeError, value)
  }
})

test('loopback integration only changes Astro dev configuration, never build or preview', () => {
  assert.throws(() => createLoopbackDevIntegration({ editorPort: '0' }), TypeError)
  assert.throws(() => createLoopbackDevIntegration({ editorPort: 'not-a-port' }), TypeError)
  const integration = createLoopbackDevIntegration()
  assert.equal(integration.name, 'astro-visual-cms-loopback-dev-boundary')
  assert.deepEqual(Object.keys(integration.hooks), ['astro:config:setup'])
  const hook = integration.hooks['astro:config:setup']
  const updates = []
  const injected = []

  const args = (command) => ({ command, updateConfig: (config) => updates.push(config), injectScript: (...values) => injected.push(values) })
  hook(args('dev'))
  hook(args('build'))
  hook(args('preview'))
  assert.deepEqual(updates, [{ server: { host: '127.0.0.1' } }])
  assert.equal(injected.length, 1)
  assert.equal(injected[0][0], 'page')
  assert.match(injected[0][1], /127\.0\.0\.1:4322/)
  assert.match(injected[0][1], /avcms:ready/)

  const customPort = []
  createLoopbackDevIntegration({ editorPort: '15432' }).hooks['astro:config:setup']({
    command: 'dev', updateConfig() {}, injectScript: (...values) => customPort.push(values),
  })
  assert.match(customPort[0][1], /127\.0\.0\.1:15432/)

  const markdownIntegration = createLoopbackDevIntegration({
    markdownParagraphTargets: [{ id: 'note', instanceId: 'paragraph-one', filePath: path.join(ROOT, 'src/pages/fixture.mdx') }],
  })
  const mdastPlugins = []
  const configured = { markdown: { processor: { name: 'satteri', options: { mdastPlugins } } } }
  const markdownInjected = []
  markdownIntegration.hooks['astro:config:setup']({ command: 'dev', config: configured, updateConfig() {}, injectScript: (...values) => markdownInjected.push(values) })
  assert.equal(mdastPlugins.length, 1)
  assert.equal(typeof mdastPlugins[0], 'function')
  assert.equal(markdownInjected.length, 1)
  const productionPlugins = []
  markdownIntegration.hooks['astro:config:setup']({
    command: 'build', config: { markdown: { processor: { name: 'satteri', options: { mdastPlugins: productionPlugins } } } },
    updateConfig() {}, injectScript: (...values) => markdownInjected.push(values),
  })
  assert.deepEqual(productionPlugins, [])
  assert.equal(markdownInjected.length, 1)
  assert.throws(() => markdownIntegration.hooks['astro:config:setup']({
    command: 'dev', config: { markdown: { processor: { name: 'other', options: {} } } }, updateConfig() {}, injectScript() {},
  }), /cannot be mapped by the active Astro processor/)
})

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
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // Astro has not opened its listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${url}:\n${getLogs()}`)
}

test('isolated synthetic Astro app serves real routes under its configured base path', { timeout: 70_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-base-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await symlink(path.join(ROOT, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n')
  await mkdir(path.join(directory, 'src/pages'), { recursive: true })
  await writeFile(path.join(directory, 'src/pages/index.astro'),
    '<html><body><h1>Synthetic base home</h1><a href="/isolated-preview/fixture/">Fixture</a></body></html>\n')
  await writeFile(path.join(directory, 'src/pages/fixture.astro'),
    '<html><body><h1>Synthetic prefixed fixture</h1></body></html>\n')

  const integrationUrl = pathToFileURL(path.join(ROOT, 'src/editor/astro-integration.mjs')).href
  const config = `import { defineConfig } from 'astro/config';\n` +
    `import { createLoopbackDevIntegration } from '${integrationUrl}';\n` +
    `export default defineConfig({ root: new URL('.', import.meta.url).pathname, base: '/isolated-preview', integrations: [createLoopbackDevIntegration()] });\n`
  await writeFile(path.join(directory, 'astro.config.mjs'), config)

  const port = await availablePort()
  const child = spawn(process.execPath, [ASTRO_CLI, 'dev', '--root', directory, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: directory,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ASTRO_TELEMETRY_DISABLED: '1',
      ASTRO_DEV_BACKGROUND: '1',
    },
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

  const baseUrl = `http://127.0.0.1:${port}/isolated-preview/`
  try {
    const home = await waitFor(baseUrl, child, () => logs)
    assert.match(await home.text(), /Synthetic base home/)
    assert.match(await (await fetch(`${baseUrl}fixture/`)).text(), /Synthetic prefixed fixture/)
  } catch (error) {
    throw new Error(`${error.message}\nAstro logs:\n${logs}`)
  } finally {
    await stop()
  }
})
