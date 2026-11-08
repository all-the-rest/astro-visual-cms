import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, symlink, cp, rm, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEditorServer } from '../src/editor/server.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: repo, stdio: 'inherit', ...opts })
  child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
})
const files = (await new Promise((resolve, reject) => {
  const child = spawn('git', ['ls-files', '-z'], { cwd: repo }); let out = ''
  child.stdout.on('data', (chunk) => out += chunk); child.once('error', reject); child.once('exit', (code) => code ? reject(new Error('git ls-files failed')) : resolve(out))
})).split('\0').filter(Boolean)
const root = await mkdtemp(path.join(tmpdir(), 'avcms-readonly-'))
const children = []
let editor
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
      await rm(root, { recursive: true, force: true })
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
  if (!['duplicate', 'unmapped'].includes(mode)) throw new Error('AVCMS_READONLY_MODE must be duplicate or unmapped.')
  if (mode === 'duplicate') {
    const original = await readFile(fixture, 'utf8')
    if (!original.includes('id="marker-two"')) throw new Error('Synthetic duplicate-ID fixture anchor was not found.')
    await writeFile(fixture, original.replace('id="marker-two"', 'id="marker-one"'))
  } else {
    const component = path.join(root, 'src/components/EditorUnknownChip.astro')
    const source = await readFile(component, 'utf8')
    if (!source.includes('data-astro-visual-cms-instance={id}')) throw new Error('Synthetic component marker anchor was not found.')
    await writeFile(component, source.replace('data-astro-visual-cms-instance={id}', 'data-astro-visual-cms-instance={id.toUpperCase()}'))
  }
  const sitePort = 15331, editorPort = 15332
  const astro = spawn(process.execPath, [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(sitePort), '--strictPort'], { cwd: root, stdio: 'inherit', env: { ...process.env, ASTRO_BASE_PATH: '/browser-synthetic/', ASTRO_DEV_BACKGROUND: '1', EDITOR_PORT: String(editorPort) } })
  children.push(astro)
  astro.once('exit', () => {
    if (!cleanupPromise) cleanup().finally(() => process.exit(1))
  })
  editor = createEditorServer({ port: editorPort, sitePort, basePath: '/browser-synthetic/', mdxComponentTargets: [{ id: 'fixture', projectRoot: root, filePath: fixture, importSource: '../components/EditorUnknownChip.astro', idProp: 'id', editableProps: ['label'] }] })
  const deadline = Date.now() + 110_000
  while (Date.now() < deadline) {
    if (astro.exitCode !== null) throw new Error(`Copied Astro dev server exited (${astro.exitCode}).`)
    try {
      if ((await fetch(`http://127.0.0.1:${sitePort}/browser-synthetic/fixture/`)).ok) break
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
