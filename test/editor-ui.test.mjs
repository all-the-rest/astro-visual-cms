import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import test from 'node:test'

const UI_PATH = new URL('../src/editor/index.html', import.meta.url)

test('editor client script supports gallery selection, native drag/drop, keyboard buttons, and multi-gallery readiness', async () => {
  const html = await readFile(UI_PATH, 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'The editor must include its browser client.')
  assert.doesNotThrow(() => new Script(script))
  assert.match(script, /addEventListener\('dragstart'/)
  assert.match(script, /addEventListener\('dragover'/)
  assert.match(script, /addEventListener\('drop'/)
  assert.match(script, /await persistOrder\(galleryId, nextOrder\)/)
  assert.match(script, /aria-label/)
  assert.match(script, /aria-pressed/)
  assert.match(script, /selectedGalleryId/)
  assert.match(script, /galleryById\(galleryId\)/)
  assert.match(script, /JSON\.stringify\(\{ hash: current\.hash, galleryId, order \}\)/)
  assert.match(script, /button\.disabled = saving/)
  assert.match(script, /api\/preview-ready\?hash=/)
  assert.match(script, /alle Galerien/)
})
