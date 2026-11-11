import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const versions = ['7.2.4', '7.2.10', '7.3.8', '7.4.7']
const version = process.argv[2]
assert.ok(versions.includes(version), `Usage: npm run verify:astro-compat -- <${versions.join('|')}>`)
const temp = await mkdtemp(path.join(os.tmpdir(), 'avcms-astro-compat-'))
let dev
const run = (cmd, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let timedOut = false
  let forceKillTimer
  child.stdout.on('data', x => { output += x; process.stdout.write(x) })
  child.stderr.on('data', x => { output += x; process.stderr.write(x) })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  }, 240_000)
  child.on('error', e => { clearTimeout(timer); clearTimeout(forceKillTimer); reject(e) })
  child.on('close', status => { clearTimeout(timer); clearTimeout(forceKillTimer); resolve({ status, output, timedOut }) })
})
async function checked(cmd, args, cwd) {
  const result = await run(cmd, args, cwd)
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')} ${result.timedOut ? 'timed out' : `exited ${result.status}`}\n${result.output}`)
  return result
}
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath]
  }))
  return nested.flat()
}
try {
  const packed = await checked('npm', ['pack', '--pack-destination', temp], root)
  const tarball = path.join(temp, packed.output.trim().split('\n').at(-1))
  const app = path.join(temp, 'consumer')
  await mkdir(path.join(app, 'src/pages'), { recursive: true })
  await mkdir(path.join(app, 'src/components'), { recursive: true })
  await mkdir(path.join(app, 'src/assets'), { recursive: true })
  const devDependencies = {
    astro: version,
    sharp: '0.35.5',
    '@astro-visual-cms/editor': `file:${path.relative(app, tarball).split(path.sep).join('/')}`,
  }
  if (version !== '7.2.4') devDependencies['@astrojs/mdx'] = '8.1.3'
  await writeFile(path.join(app, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    devDependencies,
  }, null, 2))
  await writeFile(path.join(app, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n')
  await checked('pnpm', ['install', '--no-frozen-lockfile'], app)
  const installedAstro = JSON.parse(await readFile(path.join(app, 'node_modules/astro/package.json'), 'utf8'))
  assert.equal(installedAstro.version, version, `Expected exact Astro ${version}, received ${installedAstro.version}.`)
  // The layout-less `.md` preview emits the same head as Astro's own Markdown
  // page and reuses Astro's Markdown image placeholder. Both are runtime
  // internals this package binds to, so every checkpoint must prove that the
  // exact subpath and placeholder shape still exist instead of failing later
  // with an unexplained preview error.
  const consumerRequire = createRequire(path.join(app, 'package.json'))
  const serverRuntime = await import(pathToFileURL(consumerRequire.resolve('astro/runtime/server/index.js')).href)
  assert.equal(typeof serverRuntime.maybeRenderHead, 'function', `Astro ${version} does not export maybeRenderHead from astro/runtime/server/index.js.`)
  assert.equal(typeof serverRuntime.spreadAttributes, 'function', `Astro ${version} does not export spreadAttributes from astro/runtime/server/index.js.`)
  const markdownImages = await readFile(path.join(path.dirname(consumerRequire.resolve('astro/package.json')), 'dist/vite-plugin-markdown/images.js'), 'utf8')
  assert.ok(markdownImages.includes('__ASTRO_IMAGE_="'), `Astro ${version} no longer emits the __ASTRO_IMAGE_="..." Markdown image placeholder.`)
  if (version !== '7.2.4') {
    const installedMdx = JSON.parse(await readFile(path.join(app, 'node_modules/@astrojs/mdx/package.json'), 'utf8'))
    assert.equal(installedMdx.version, '8.1.3', `Expected exact @astrojs/mdx 8.1.3, received ${installedMdx.version}.`)
  }
  await writeFile(path.join(app, 'src/assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64'))
  await writeFile(path.join(app, 'src/components/Probe.astro'), `---\nimport { Image } from 'astro:assets';\nimport image from '../assets/pixel.png';\n---\n<div data-astro-visual-cms-target="compat-target" data-astro-visual-cms-instance="compat-instance">ASTRO_COMPAT_TARGET_${version}</div><Image src={image} alt="compat image" />`)
  await writeFile(path.join(app, 'src/pages/index.astro'), `---\nimport Probe from '../components/Probe.astro';\n---\n<html><body><Probe /></body></html>`)
  const mdx = version === '7.2.4' ? '' : "import mdx from '@astrojs/mdx';\n"
  const mdxIntegration = version === '7.2.4' ? '' : 'mdx(), '
  await writeFile(path.join(app, 'astro.config.mjs'), `import { defineConfig } from 'astro/config';\n${mdx}import { createLoopbackDevIntegration } from '@astro-visual-cms/editor/integration';\nexport default defineConfig({ base: '/compat/', integrations: [${mdxIntegration}createLoopbackDevIntegration({ previewRoutes: [{ id: 'compat', label: 'Compat', path: '/compat/' }] })] });`)
  if (version !== '7.2.4') await writeFile(path.join(app, 'src/pages/mdx.mdx'), `import Probe from '../components/Probe.astro'\n\n<Probe />`)
  const cli = path.join(app, 'node_modules/.bin/astro')
  await checked(cli, ['build'], app)
  const html = await readFile(path.join(app, 'dist/index.html'), 'utf8')
  assert.match(html, new RegExp(`ASTRO_COMPAT_TARGET_${version}`)); assert.match(html, /compat-instance/); assert.match(html, /_astro\/[^" ]+\.(?:webp|png|avif)/i)
  const productionHtml = [html]
  if (version !== '7.2.4') productionHtml.push(await readFile(path.join(app, 'dist/mdx/index.html'), 'utf8'))
  for (const output of productionHtml) assert.doesNotMatch(output, /avcms:challenge|astro-visual-cms-editor|astro-dev-toolbar/i)
  const forbiddenProductionMarkers = ['avcms:challenge', 'astro-visual-cms-editor', 'astro-dev-toolbar']
  for (const file of await filesUnder(path.join(app, 'dist'))) {
    const content = await readFile(file)
    for (const marker of forbiddenProductionMarkers) {
      assert.equal(content.includes(Buffer.from(marker)), false, `Production marker ${marker} found in ${path.relative(app, file)}.`)
    }
  }
  if (version !== '7.2.4') {
    const mdxHtml = productionHtml[1]
    assert.match(mdxHtml, new RegExp(`ASTRO_COMPAT_TARGET_${version}`))
    assert.match(mdxHtml, /compat-instance/)
  }
  dev = spawn(cli, ['dev', '--host', '127.0.0.1', '--port', '0'], { cwd: app, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; dev.stdout.on('data', x => { logs += x }); dev.stderr.on('data', x => { logs += x })
  let response
  for (let i = 0; i < 90; i++) {
    if ((dev.exitCode !== null && dev.exitCode !== 0) || dev.signalCode !== null) throw new Error(`astro dev exited (code ${dev.exitCode}, signal ${dev.signalCode}): ${logs}`)
    const port = Number(logs.match(/(?:localhost|127\.0\.0\.1):(\d+)/)?.[1])
    if (port) { try { response = await fetch(`http://127.0.0.1:${port}/compat/`); break } catch {} }
    await new Promise(r => setTimeout(r, 500))
  }
  assert.ok(response, `astro dev did not become ready: ${logs}`); assert.equal(response.status, 200)
  const devHtml = await response.text(); assert.match(devHtml, new RegExp(`ASTRO_COMPAT_TARGET_${version}`)); assert.match(devHtml, /compat-instance/); assert.match(devHtml, /astro:scripts\/page\.js/); assert.match(devHtml, /src="\/compat\/_image\?/)
  const imageSource = devHtml.match(/src="([^"]*\/compat\/_image\?[^"]+)"/)
  assert.ok(imageSource, 'Astro dev HTML did not include the prefixed optimized image endpoint.')
  const imageResponse = await fetch(new URL(imageSource[1].replaceAll('&amp;', '&'), response.url))
  assert.equal(imageResponse.status, 200, `Astro dev optimized image endpoint returned ${imageResponse.status}`)
  assert.match(imageResponse.headers.get('content-type') || '', /^image\//)
  const bridge = await fetch(new URL('/@id/astro:scripts/page.js', response.url))
  assert.equal(bridge.status, 200, `Astro dev page-script endpoint returned ${bridge.status}`)
  assert.match(await bridge.text(), /avcms:challenge/)
  if (version !== '7.2.4') {
    const mdxResponse = await fetch(new URL('mdx/', response.url))
    assert.equal(mdxResponse.status, 200, `Astro dev MDX route returned ${mdxResponse.status}`)
    const mdxDevHtml = await mdxResponse.text()
    assert.match(mdxDevHtml, new RegExp(`ASTRO_COMPAT_TARGET_${version}`))
    assert.match(mdxDevHtml, /compat-instance/)
  }
  console.log(`Astro ${version} packed-tarball compatibility passed${version === '7.2.4' ? ' (MDX omitted)' : ' with MDX 8.1.3'}.`)
} finally {
  if (dev && dev.exitCode === null && dev.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { dev.kill('SIGKILL'); resolve() }, 5_000)
      dev.once('close', () => { clearTimeout(timer); resolve() })
      dev.kill('SIGTERM')
    })
  }
  if (dev) await run(path.join(temp, 'consumer/node_modules/.bin/astro'), ['dev', 'stop'], path.join(temp, 'consumer')).catch(() => {})
  for (let attempt = 0; ; attempt++) {
    try { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); break }
    catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 250)) }
  }
}
