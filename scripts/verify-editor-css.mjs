import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const committedPath = path.join(root, 'src/editor/editor.generated.css')
const tempRoot = await mkdtemp(path.join(tmpdir(), 'avcms-editor-css-'))
const generatedPath = path.join(tempRoot, 'editor.generated.css')
const cli = path.join(root, 'node_modules', '.bin', 'tailwindcss')

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(cli, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`tailwindcss exited ${code}: ${output}`)))
})

try {
  await run(['-i', 'src/editor/editor.css', '-o', generatedPath, '--minify'])
  const [committed, generated] = await Promise.all([readFile(committedPath), readFile(generatedPath)])
  if (!committed.equals(generated)) {
    console.error('src/editor/editor.generated.css is stale. Run `pnpm run build:editor-css` and commit the result.')
    process.exitCode = 1
  } else {
    console.log(`Editor stylesheet is current (${generated.length} bytes).`)
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
