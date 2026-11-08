import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectFixture } from '../src/lib/gallery-patch.mjs'
import { createEditorServer, isLoopbackAddress, validateDemoImageSlugs } from '../src/editor/server.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  server.closeAllConnections?.()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

test('the fixture write server refuses production mode', () => {
  const priorNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.throws(() => createEditorServer(), /development-only/)
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = priorNodeEnv
  }
})

test('the fixed demo server keeps image slugs manifest-bound without constraining parser inputs', () => {
  const supported = [{ id: 'SORTING', order: ['noise-fixture-01'] }]
  assert.deepEqual(validateDemoImageSlugs(supported), supported)
  assert.throws(() => validateDemoImageSlugs([
    { id: 'SORTING', order: ['arbitrary-parser-only-slug'] },
  ]), { code: 'UNSUPPORTED_IMAGE_SLUG' })
})

test('loopback address helper accepts IPv4, IPv6, and mapped IPv4 loopback only', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:127.255.255.255']) {
    assert.equal(isLoopbackAddress(address), true, `${address} should be loopback`)
  }
  for (const address of ['', '127.0.0.2', '192.168.1.2', '::ffff:128.0.0.1', '::ffff:127.256.0.1', '::2']) {
    assert.equal(isLoopbackAddress(address), false, `${address} should not be loopback`)
  }
})

test('standalone editor reports an occupied port and exits non-zero', async () => {
  const occupied = createServer()
  const port = await listen(occupied)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/editor/server.mjs', import.meta.url))], {
    env: { ...process.env, EDITOR_PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Standalone editor did not exit after EADDRINUSE.')), 5_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    assert.notEqual(code, 0)
    assert.match(stderr, new RegExp(`port ${port} is already in use`))
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await close(occupied)
  }
})

test('standalone editor closes cleanly on SIGTERM', async () => {
  const reservation = createServer()
  const port = await listen(reservation)
  await close(reservation)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/editor/server.mjs', import.meta.url))], {
    env: { ...process.env, EDITOR_PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Standalone editor did not start.')), 5_000)
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
        if (output.includes(`Fixture editor: http://127.0.0.1:${port}`)) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Standalone editor exited before listening (${code}).`))
      })
    })
    child.kill('SIGTERM')
    assert.deepEqual(await exited, { code: 0, signal: null })
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('reorder requires the per-server token and accepts a correct token on a synthetic fixture', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-server-'))
  const fixturePath = path.join(directory, 'fixture.mdx')
  const source = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = ["noise-fixture-01", "noise-fixture-03"];\n\n<Gallery sorted={FIRST} />\n`
  await writeFile(fixturePath, source, 'utf8')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const editor = createEditorServer({ port: 0, fixturePath })
  const port = await listen(editor)
  const origin = `http://127.0.0.1:${port}`

  try {
    const html = await (await fetch(`${origin}/`)).text()
    const token = (await (await fetch(`${origin}/api/session`)).json()).token
    assert.match(token, /^[a-f0-9]{64}$/, 'The client must receive a random session token.')
    assert.doesNotMatch(html, new RegExp(token), 'The token must not be embedded in the served HTML.')
    const stateResponse = await fetch(`${origin}/api/state`)
    const stateText = await stateResponse.text()
    assert.equal(stateResponse.status, 200)
    assert.doesNotMatch(stateText, new RegExp(token))
    const state = JSON.parse(stateText)
    const order = [...state.galleries[0].order].reverse()
    const payload = JSON.stringify({ galleryId: state.galleries[0].id, order, hash: state.hash })
    const headers = { origin, 'content-type': 'application/json' }

    const missingToken = await fetch(`${origin}/api/reorder`, {
      method: 'POST', headers, body: payload,
    })
    assert.equal(missingToken.status, 403)
    const wrongToken = await fetch(`${origin}/api/reorder`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': `${token[0] === '0' ? '1' : '0'}${token.slice(1)}` }, body: payload,
    })
    assert.equal(wrongToken.status, 403)
    const accepted = await fetch(`${origin}/api/reorder`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token }, body: payload,
    })
    assert.equal(accepted.status, 200)
    const saved = await accepted.json()
    assert.deepEqual(saved.galleries[0].order, order)
    assert.deepEqual(inspectFixture(await readFile(fixturePath, 'utf8')).galleries[0].order, order)
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(token))
  } finally {
    await close(editor)
  }
})

test('a restarted editor rotates its token and rejects the previous session token', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-restart-'))
  const fixturePath = path.join(directory, 'fixture.mdx')
  const source = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = ["noise-fixture-01", "noise-fixture-03"];\n\n<Gallery sorted={FIRST} />\n`
  await writeFile(fixturePath, source, 'utf8')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const first = createEditorServer({ port: 0, fixturePath })
  const firstOrigin = `http://127.0.0.1:${await listen(first)}`
  const firstToken = (await (await fetch(`${firstOrigin}/api/session`)).json()).token
  await close(first)

  const second = createEditorServer({ port: 0, fixturePath })
  const secondOrigin = `http://127.0.0.1:${await listen(second)}`
  try {
    const secondToken = (await (await fetch(`${secondOrigin}/api/session`)).json()).token
    assert.notEqual(secondToken, firstToken, 'A new editor process must not reuse the previous token.')
    const state = await (await fetch(`${secondOrigin}/api/state`)).json()
    const payload = JSON.stringify({
      galleryId: state.galleries[0].id,
      order: [...state.galleries[0].order].reverse(),
      hash: state.hash,
    })
    const headers = { origin: secondOrigin, 'content-type': 'application/json' }
    const previousToken = await fetch(`${secondOrigin}/api/reorder`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': firstToken }, body: payload,
    })
    assert.equal(previousToken.status, 403)
    const rotatedToken = await fetch(`${secondOrigin}/api/reorder`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': secondToken }, body: payload,
    })
    assert.equal(rotatedToken.status, 200)
  } finally {
    await close(second)
  }
})

test('preview readiness waits for galleries in fixture order instead of accepting swapped markers', async () => {
  let renderedHtml = ''
  let previewRequests = 0
  const site = createServer((_request, response) => {
    previewRequests += 1
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(renderedHtml)
  })
  const sitePort = await listen(site)
  const editor = createEditorServer({ port: 0, sitePort })
  const editorPort = await listen(editor)
  let switchToCorrectOrder

  try {
    const stateResponse = await fetch(`http://127.0.0.1:${editorPort}/api/state`)
    const state = await stateResponse.json()
    assert.ok(state.galleries.length > 1, 'The fixture must contain multiple galleries.')
    const markerHtml = (galleries) => galleries
      .map(({ order }) => `<section data-gallery-order="${order.join(',')}"></section>`)
      .join('')
    renderedHtml = markerHtml([...state.galleries].reverse())

    const ready = fetch(`http://127.0.0.1:${editorPort}/api/preview-ready?hash=${state.hash}`)
    switchToCorrectOrder = setTimeout(() => {
      renderedHtml = markerHtml(state.galleries)
    }, 250)

    const response = await ready
    assert.equal(response.status, 200)
    assert.ok(previewRequests > 1, 'Readiness must retry while markers are in the wrong order.')
    const payload = await response.json()
    assert.deepEqual(payload.galleries, state.galleries)
  } finally {
    clearTimeout(switchToCorrectOrder)
    await Promise.all([close(editor), close(site)])
  }
})
