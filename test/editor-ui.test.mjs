import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import test from 'node:test'

const UI_PATH = new URL('../src/editor/index.html', import.meta.url)

test('editor client script is valid and keeps native drag/drop plus keyboard buttons', async () => {
  const html = await readFile(UI_PATH, 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'The editor must include its browser client.')
  assert.doesNotThrow(() => new Script(script))
  assert.match(script, /addEventListener\('dragstart'/)
  assert.match(script, /addEventListener\('dragover'/)
  assert.match(script, /addEventListener\('drop'/)
  assert.match(script, /await persistOrder\(nextOrder\)/)
  assert.match(script, /aria-label/)
  assert.match(script, /button\.disabled = saving/)
  assert.match(script, /api\/preview-ready\?hash=/)
})
