import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const sitePort = Number(process.env.ASTRO_PORT || 4321)
const editorPort = Number(process.env.EDITOR_PORT || 4322)
const astroArgs = [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(sitePort), '--strictPort']
if (process.env.ASTRO_PORT) astroArgs.push('--ignore-lock')
const processes = [
  spawn(process.execPath, astroArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ASTRO_DEV_BACKGROUND: '1', EDITOR_PORT: String(editorPort) },
  }),
  spawn(process.execPath, process.env.AVCMS_CONFIG ? ['src/editor/cli.mjs'] : ['src/editor/sample-dev-server.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ASTRO_PORT: String(sitePort), EDITOR_PORT: String(editorPort) },
  }),
]

let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of processes) child.kill(signal)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
for (const child of processes) {
  child.on('exit', (code) => {
    if (!stopping) {
      stop()
      process.exitCode = code || 0
    }
  })
}
