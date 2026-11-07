import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import test from 'node:test'
import sharp from 'sharp'
import { inspectFixture } from '../src/lib/gallery-patch.mjs'

const FIXTURE_PATH = new URL('../src/pages/fixture.mdx', import.meta.url)
const SITE_PORT = 14321
const EDITOR_PORT = 14322

async function waitFor(url, child) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dev process exited early (${child.exitCode}).`)
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // Servers are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

test('separate editor and Astro ports render the MDX page and persist a safe reorder', { timeout: 75_000 }, async () => {
  const original = await readFile(FIXTURE_PATH)
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, ASTRO_PORT: String(SITE_PORT), EDITOR_PORT: String(EDITOR_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })

  try {
    const siteResponse = await waitFor(`http://127.0.0.1:${SITE_PORT}/fixture/`, child)
    const editorResponse = await waitFor(`http://127.0.0.1:${EDITOR_PORT}/`, child)
    const html = await siteResponse.text()
    const editor = await editorResponse.text()
    assert.match(html, /Echte gerenderte MDX-Fixture/)
    assert.match(html, /Zufälliges Noise-Testbild/)
    assert.match(html, /Unbekannte CMS-Komponente/)
    const imageSrc = html.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1]
    assert.ok(imageSrc, 'The rendered Astro fixture must contain an Astro Image source.')
    const imageResponse = await fetch(new URL(imageSrc.replaceAll('&amp;', '&'), `http://127.0.0.1:${SITE_PORT}`))
    assert.equal(imageResponse.status, 200)
    const imageMetadata = await sharp(Buffer.from(await imageResponse.arrayBuffer())).metadata()
    assert.equal(imageMetadata.width, 640)
    assert.equal(imageMetadata.height, 400)
    assert.match(editor, /<iframe[^>]+title="MDX-Fixture-Vorschau"/)
    assert.match(editor, new RegExp(`http://127\\.0\\.0\\.1:${SITE_PORT}`))
    const stylesheet = await fetch(`http://127.0.0.1:${SITE_PORT}/src/styles/global.css?direct`)
    assert.equal(stylesheet.status, 200)
    assert.match(await stylesheet.text(), /\.btn/)

    const stateResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/state`)
    const state = await stateResponse.json()
    const order = [...state.order].reverse()
    const rejectedOrigin = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/reorder`, {
      method: 'POST',
      headers: {
        origin: `http://localhost:${EDITOR_PORT}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hash: state.hash, order }),
    })
    assert.equal(rejectedOrigin.status, 403)
    const resultResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/reorder`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hash: state.hash, order }),
    })
    assert.equal(resultResponse.status, 200)
    const saved = await resultResponse.json()
    assert.deepEqual(saved.order, order)
    const previewReadyResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview-ready?hash=${saved.hash}`)
    assert.equal(previewReadyResponse.status, 200)
    const previewReady = await previewReadyResponse.json()
    assert.deepEqual(previewReady.order, order)
    assert.equal(previewReady.hash, saved.hash)
    const refreshedPreview = await fetch(previewReady.previewUrl)
    assert.equal(refreshedPreview.status, 200)
    const rendered = await refreshedPreview.text()
    const patchedSource = await readFile(FIXTURE_PATH, 'utf8')
    assert.deepEqual(inspectFixture(patchedSource).order, order)
    assert.ok(rendered.includes(`data-gallery-order="${order.join(',')}"`))
    assert.ok(rendered.indexOf(order[0]) >= 0 && rendered.indexOf(order[0]) < rendered.indexOf(order[1]), rendered.match(/<figcaption[^]*?<\/figcaption>/g)?.join('\n'))

    const staleResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/reorder`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hash: state.hash, order: state.order }),
    })
    assert.equal(staleResponse.status, 409)
  } catch (error) {
    throw new Error(`${error.message}\nDev logs:\n${logs}`)
  } finally {
    await writeFile(FIXTURE_PATH, original)
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  assert.doesNotMatch(logs, /Error:|failed/i)
})
