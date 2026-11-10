import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

test('separate editor and Astro ports render multiple galleries and provide previews without replacing source', { timeout: 75_000 }, async () => {
  const original = await readFile(FIXTURE_PATH)
  const configDirectory = await mkdtemp(path.join(tmpdir(), 'astro-editor-e2e-config-'))
  const configPath = path.join(configDirectory, 'editor.json')
  await writeFile(configPath, JSON.stringify({
    port: EDITOR_PORT,
    sitePort: SITE_PORT,
    basePath: '/e2e-synthetic/',
    fixturePath: FIXTURE_PATH.pathname,
  }))
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      ASTRO_PORT: String(SITE_PORT),
      EDITOR_PORT: String(EDITOR_PORT),
      ASTRO_BASE_PATH: '/e2e-synthetic/',
      AVCMS_CONFIG: configPath,
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
    assert.equal(resultResponse.status, 409)
    assert.equal((await resultResponse.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
    assert.deepEqual(await readFile(FIXTURE_PATH), original, 'Confirmation must not replace an existing source file.')
    assert.deepEqual(inspectFixture(await readFile(FIXTURE_PATH, 'utf8')).galleries, state.galleries)
    assert.deepEqual(untouched.order, state.galleries.find((gallery) => gallery.id === untouched.id)?.order)
  } catch (error) {
    throw new Error(`${error.message}\nDev logs:\n${logs}`)
  } finally {
    if (!(await readFile(FIXTURE_PATH)).equals(original)) await writeFile(FIXTURE_PATH, original)
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(configDirectory, { recursive: true, force: true })
  }
  assert.doesNotMatch(logs, /Error:|failed/i)
})
