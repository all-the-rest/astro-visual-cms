import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CONSUMER_ROOT = path.resolve(process.env.ASTRO_CMS_CONSUMER || '/projects/powerbros.at')
const TEMP_PARENT = process.env.ASTRO_CMS_TEMP_ROOT || (process.platform === 'linux' && process.env.HOME ? '/tmp/opencode' : tmpdir())
const TEMP_ROOT = await mkdtemp(path.join(TEMP_PARENT, 'astro-visual-cms-production-'))
const APP_ROOT = path.join(TEMP_ROOT, 'consumer')
const REQUIRED_PROJECT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'astro.config.mjs', 'tsconfig.json', 'src', 'public']
let previewServer

function run(command, args, cwd, { timeout = 240_000, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, env })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.`)
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForPage(url, expectedText) {
  let lastStatus = 'unavailable'
  let lastBody = ''
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      lastStatus = response.status
      lastBody = await response.text()
      if (response.ok && lastBody.includes(expectedText)) return lastBody
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Astro preview did not serve ${url} with ${JSON.stringify(expectedText)} (last status ${lastStatus}).\n${lastBody.slice(0, 1000)}`)
}

async function stopPreview() {
  if (!previewServer) return
  try { process.kill(-previewServer.pid, 'SIGTERM') } catch {}
  if (previewServer.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => previewServer.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ])
  }
  try { process.kill(-previewServer.pid, 'SIGKILL') } catch {}
  previewServer = undefined
}

async function stopTemporaryProcesses() {
  if (!existsSync('/proc')) return
  const matchingPids = async () => {
    const pids = []
    for (const entry of (await readdir('/proc')).filter((item) => /^\d+$/.test(item))) {
      try {
        const command = (await readFile(`/proc/${entry}/cmdline`)).toString().replaceAll('\0', ' ')
        if (Number(entry) !== process.pid && command.includes(TEMP_ROOT)) pids.push(Number(entry))
      } catch {}
    }
    return pids
  }
  let pids = await matchingPids()
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  if (pids.length) await new Promise((resolve) => setTimeout(resolve, 250))
  pids = await matchingPids()
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
  if (pids.length) console.log(`TEMP_PROCESS_CLEANUP=${pids.join(',')}`)
}

function collectFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) collectFiles(file, output)
    else if (entry.isFile()) output.push(file)
  }
  return output
}

function assertNoCmsProductionArtifacts() {
  const distRoot = path.join(APP_ROOT, 'dist')
  const files = collectFiles(distRoot)
  assert.ok(files.some((file) => file.endsWith('.html')), 'Production build must emit ordinary Astro HTML pages.')

  const relativeFiles = files.map((file) => path.relative(distRoot, file).replaceAll(path.sep, '/'))
  const cmsRoutes = relativeFiles.filter((file) => /(?:^|\/)(?:editor|api\/(?:astro-galleries|collections|commit|preview|preview-ready|reorder|session|state))(?:\/|\.|$)/i.test(file))
  assert.deepEqual(cmsRoutes, [], 'Production output must not contain CMS UI or write/API routes.')

  const cmsMarkers = [
    'astro-visual-cms-loopback-dev-boundary',
    'astro-visual-cms-editor',
    'avcms:challenge',
    'avcms:ready',
    'avcms:selection',
    'data-astro-visual-cms-target',
    'id="collections-panel"',
    'id="mdx-components-panel"',
    'id="collection-diff-confirmation"',
    'http://127.0.0.1:4322',
    '/api/commit',
    '/api/preview',
    '/api/preview-ready',
    '/api/reorder',
    '/api/session',
    '/api/state',
    '/api/collections',
    '/api/collections/create-entry/',
    '/api/collections/config/',
    '/api/collections/preview',
    '/api/collections/commit',
    '/api/astro-galleries',
    '/api/astro-galleries/preview',
    '/api/astro-galleries/commit',
    '/api/health',
    '/api/mdx-components',
    '/api/mdx-components/preview',
    '/api/mdx-components/commit',
  ]
  const textFiles = files.filter((file) => /\.(?:html|js|mjs|css|json)$/.test(file))
  for (const file of textFiles) {
    const text = readFileSync(file, 'utf8')
    for (const marker of cmsMarkers) {
      assert.equal(text.includes(marker), false, `Production output contains CMS marker ${JSON.stringify(marker)} in ${path.relative(distRoot, file)}.`)
    }
  }
}

try {
  assert.ok(await stat(CONSUMER_ROOT).then((result) => result.isDirectory()).catch(() => false),
    `Astro consumer directory does not exist: ${CONSUMER_ROOT}. Set ASTRO_CMS_CONSUMER to a project directory.`)
  for (const name of REQUIRED_PROJECT_FILES) {
    await cp(path.join(CONSUMER_ROOT, name), path.join(APP_ROOT, name), { recursive: true, preserveTimestamps: true })
  }

  const installEnv = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }
  run('pnpm', ['install', '--offline', '--frozen-lockfile'], APP_ROOT, { env: installEnv })

  const packOutput = run('npm', ['pack', '--json', '--pack-destination', TEMP_ROOT], REPOSITORY_ROOT)
  const packResult = JSON.parse(packOutput)
  const packed = Array.isArray(packResult) ? packResult[0] : packResult['@astro-visual-cms/editor']
  assert.ok(packed?.filename, 'npm pack did not return the editor tarball filename.')
  run('pnpm', ['add', '--offline', path.join(TEMP_ROOT, packed.filename)], APP_ROOT, { env: installEnv })

  const configPath = path.join(APP_ROOT, 'astro.config.mjs')
  const originalConfig = await readFile(configPath, 'utf8')
  const configWithIntegration = originalConfig
    .replace('import sitemap from "@astrojs/sitemap";', 'import sitemap from "@astrojs/sitemap";\nimport { createLoopbackDevIntegration } from "@astro-visual-cms/editor/integration";')
    .replace('integrations: [sitemap()],', 'integrations: [sitemap(), createLoopbackDevIntegration()],')
  assert.notEqual(configWithIntegration, originalConfig, 'Update the script anchors if the external Astro config changes.')
  await writeFile(configPath, configWithIntegration)

  const buildOutput = run('pnpm', ['run', 'build'], APP_ROOT, { env: installEnv })
  assert.match(buildOutput, /astro (?:check|build)|built in|generating/i, 'Expected the project build script to run Astro.')
  assertNoCmsProductionArtifacts()

  // No editor CLI/server is started by this gate. Only Astro's ordinary preview is launched.
  const previewPort = await freePort()
  const astroCli = await realpath(path.join(APP_ROOT, 'node_modules/astro/bin/astro.mjs'))
  previewServer = spawn(process.execPath, [astroCli, 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], {
    cwd: APP_ROOT,
    env: installEnv,
    stdio: 'ignore',
    detached: true,
  })
  const previewUrl = `http://127.0.0.1:${previewPort}`
  await waitForPage(`${previewUrl}/referenzen/`, 'Street-Show Porec')
  for (const endpoint of ['/api/collections', '/api/mdx-components', '/api/astro-galleries', '/api/health']) {
    const cmsApiResponse = await fetch(`${previewUrl}${endpoint}`, { signal: AbortSignal.timeout(2_000) })
    assert.equal(cmsApiResponse.status, 404, `Ordinary Astro preview must not expose ${endpoint}.`)
  }

  console.log(`EXTERNAL_CONSUMER=${CONSUMER_ROOT}`)
  console.log(`TARBALL_INSTALL=PASS; ${packed.filename}`)
  console.log('EDITOR_PROCESS=NOT_STARTED')
  console.log('PRODUCTION_ISOLATION=PASS; no CMS routes, UI, dev bridge, or collection write endpoints in dist')
  console.log('ORDINARY_PREVIEW=PASS; /referenzen/ served real project content with Astro only')
  console.log('CMS_API_ABSENT=PASS; collection, MDX-component, Astro-gallery, and health endpoints return 404')
} finally {
  await stopPreview()
  await stopTemporaryProcesses()
  await rm(TEMP_ROOT, { recursive: true, force: true })
}
