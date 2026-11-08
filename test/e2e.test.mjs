import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
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

function renderedGalleries(html) {
  return [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)].flatMap((match) => {
    const order = match[1].match(/\bdata-gallery-order="([^"]*)"/)?.[1]
    return order === undefined ? [] : [{ order, html: match[2] }]
  })
}

test('separate editor and Astro ports render multiple galleries and persist one safe reorder', { timeout: 75_000 }, async () => {
  const original = await readFile(FIXTURE_PATH)
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      ASTRO_PORT: String(SITE_PORT),
      EDITOR_PORT: String(EDITOR_PORT),
      ASTRO_BASE_PATH: '/e2e-synthetic/',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })

  try {
    const siteResponse = await waitFor(`http://127.0.0.1:${SITE_PORT}/e2e-synthetic/fixture/`, child)
    const editorResponse = await waitFor(`http://127.0.0.1:${EDITOR_PORT}/`, child)
    const html = await siteResponse.text()
    const editor = await editorResponse.text()
    assert.match(html, /Ein Wochenende zwischen Küste und Stadt/)
    assert.match(html, /Zufälliges Noise-Testbild/)
    assert.match(html, /Unbekannte CMS-Komponente/)
    assert.deepEqual(renderedGalleries(html).map(({ order }) => order), [
      'noise-fixture-01,noise-fixture-03',
      'noise-fixture-02',
    ])
    const imageSrc = html.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1]
    assert.ok(imageSrc, 'The rendered Astro fixture must contain an Astro Image source.')
    const imageResponse = await fetch(new URL(imageSrc.replaceAll('&amp;', '&'), `http://127.0.0.1:${SITE_PORT}`))
    assert.equal(imageResponse.status, 200)
    const imageMetadata = await sharp(Buffer.from(await imageResponse.arrayBuffer())).metadata()
    assert.equal(imageMetadata.width, 640)
    assert.equal(imageMetadata.height, 400)
    assert.match(editor, /<iframe[^>]+title="Seitenvorschau"/)
    assert.match(editor, /id="gallery-picker"/)
    assert.match(editor, new RegExp(`http://127\\.0\\.0\\.1:${SITE_PORT}`))
    const editorToken = (await (await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/session`)).json()).token
    assert.match(editorToken, /^[a-f0-9]{64}$/, 'The editor session endpoint must return its per-session token.')
    assert.doesNotMatch(editor, new RegExp(editorToken), 'The token must not be embedded in editor HTML.')
    const stylesheet = await fetch(`http://127.0.0.1:${SITE_PORT}/e2e-synthetic/src/styles/global.css?direct`)
    assert.equal(stylesheet.status, 200)
    assert.match(await stylesheet.text(), /\.btn/)

    const stateResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/state`)
    const state = await stateResponse.json()
    const selected = state.galleries.find((gallery) => gallery.id === 'HIGHLIGHTS')
    const untouched = state.galleries.find((gallery) => gallery.id === 'DETAILS')
    const order = [...selected.order].reverse()
    const rejectedOrigin = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview`, {
      method: 'POST',
      headers: {
        origin: `http://localhost:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ hash: state.hash, galleryId: selected.id, order }),
    })
    assert.equal(rejectedOrigin.status, 403)
    const rejectedClientPath = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ hash: state.hash, galleryId: selected.id, order, filePath: '../../README.md' }),
    })
    assert.equal(rejectedClientPath.status, 422)
    const previewResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ hash: state.hash, galleryId: selected.id, order }),
    })
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json()
    assert.ok(preview.previewId)
    assert.ok(preview.diff)
    assert.deepEqual(await readFile(FIXTURE_PATH), original, 'A preview must leave the source bytes unchanged.')
    const resultResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/commit`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ previewId: preview.previewId, hash: state.hash, galleryId: selected.id, order }),
    })
    assert.equal(resultResponse.status, 200)
    const saved = await resultResponse.json()
    assert.deepEqual(saved.galleries, [
      { id: selected.id, order },
      untouched,
    ])
    const previewReadyResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview-ready?hash=${saved.hash}`)
    assert.equal(previewReadyResponse.status, 200)
    const previewReady = await previewReadyResponse.json()
    assert.deepEqual(previewReady.galleries, saved.galleries)
    assert.equal(previewReady.hash, saved.hash)
    const refreshedPreview = await fetch(previewReady.previewUrl)
    assert.equal(refreshedPreview.status, 200)
    const rendered = await refreshedPreview.text()
    const patchedSource = await readFile(FIXTURE_PATH, 'utf8')
    assert.deepEqual(inspectFixture(patchedSource).galleries, saved.galleries)
    const actualGalleries = renderedGalleries(rendered)
    assert.deepEqual(actualGalleries.map(({ order }) => order).sort(), saved.galleries.map((gallery) => gallery.order.join(',')).sort())
    for (const [index, gallery] of saved.galleries.entries()) {
      const section = actualGalleries[index]
      assert.ok(section, `Missing rendered gallery ${gallery.id}`)
      const positions = gallery.order.map((slug) => section.html.indexOf(slug))
      assert.ok(positions.every((position) => position >= 0))
      assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
    }

    const staleResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ hash: state.hash, galleryId: selected.id, order: selected.order }),
    })
    assert.equal(staleResponse.status, 409)
    assert.deepEqual(await readFile(FIXTURE_PATH), Buffer.from(patchedSource, 'utf8'),
      'A second write based on the old revision must not overwrite the first accepted write.')

    const pendingResponse = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/preview`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ hash: saved.hash, galleryId: selected.id, order: selected.order }),
    })
    assert.equal(pendingResponse.status, 200)
    const pending = await pendingResponse.json()
    const externalLine = '\n// synthetic external modification after accepted save\n'
    await appendFile(FIXTURE_PATH, externalLine)
    const externalConflict = await fetch(`http://127.0.0.1:${EDITOR_PORT}/api/commit`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${EDITOR_PORT}`,
        'content-type': 'application/json',
        'x-editor-token': editorToken,
      },
      body: JSON.stringify({ previewId: pending.previewId, hash: saved.hash, galleryId: selected.id, order: selected.order }),
    })
    assert.equal(externalConflict.status, 409)
    assert.deepEqual(await readFile(FIXTURE_PATH), Buffer.concat([Buffer.from(patchedSource), Buffer.from(externalLine)]),
      'An external edit after the accepted save must survive a stale revision request.')
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
