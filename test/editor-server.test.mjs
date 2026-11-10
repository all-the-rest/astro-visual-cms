import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { hashSource, inspectFixture } from '../src/lib/gallery-patch.mjs'
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

function getWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/state',
      headers: { host },
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.end()
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

test('trusted preview routes are strictly validated and safely embedded while defaults remain intact', async (t) => {
  const invalid = [
    [{ id: 'x', label: 'X', path: '/a/../b' }], [{ id: 'x', label: 'X', path: 'https://evil.test/' }],
    [{ id: 'x', label: 'X', path: '//evil.test/' }], [{ id: 'x', label: 'X', path: '/a?b' }],
    [{ id: 'x', label: 'X', path: '/a#b' }], [{ id: 'x', label: 'X', path: '/a%2fb' }],
    [{ id: 'x', label: 'X', path: '/%252e%252e/' }], [{ id: 'x', label: 'X', path: '/%252f' }],
    [{ id: 'x', label: 'X', path: '/a%ZZ' }], [{ id: 'x', label: 'X', path: '/a%00b' }],
    [{ id: 'x', label: 'X', path: '/a\\b' }], [{ id: 'same', label: 'A', path: '/' }, { id: 'same', label: 'B', path: '/b' }],
    [], Array.from({ length: 33 }, (_, i) => ({ id: `r${i}`, label: 'Route', path: '/' })),
  ]
  for (const previewRoutes of invalid) assert.throws(() => createEditorServer({ previewRoutes }), TypeError)

  const defaultEditor = createEditorServer({ port: 0 })
  const defaultPort = await listen(defaultEditor)
  t.after(() => close(defaultEditor))
  const defaultHtml = await (await fetch(`http://127.0.0.1:${defaultPort}/`)).text()
  assert.match(defaultHtml, /"id":"home","label":"Startseite","path":"\/"/)
  assert.match(defaultHtml, /"id":"fixture","label":"Fixture","path":"\/fixture\/","cacheBustOnRevision":true/)

  const editor = createEditorServer({ port: 0, sitePort: 4321, basePath: '/custom-base/', previewRoutes: [
    { id: 'proof', label: '</script><script>alert(1)</script> ', path: '/proof/' },
  ] })
  const port = await listen(editor)
  t.after(() => close(editor))
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert.ok(html.includes('\\u003c/script>'))
  assert.ok(html.includes('\\u2028'))
  assert.match(html, /const siteBasePath = '\/custom-base\/'/)
  assert.match(html, /button\.textContent = route\.label/)
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

test('preview and commit require the token, show the exact diff, and fail closed on existing-source replacement', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-server-'))
  const fixturePath = path.join(directory, 'fixture.mdx')
  const source = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = ["noise-fixture-01", "noise-fixture-03"];\n\n<Gallery sorted={FIRST} />\n`
  await writeFile(fixturePath, source, 'utf8')
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.throws(() => createEditorServer({ fixturePath, basePath: '/unsafe/../path/' }), TypeError)
  const sitePort = 4321
  const editor = createEditorServer({ port: 0, sitePort, fixturePath, basePath: '/synthetic-preview/' })
  const port = await listen(editor)
  const origin = `http://127.0.0.1:${port}`

  try {
    const htmlResponse = await fetch(`${origin}/`)
    const html = await htmlResponse.text()
    assert.match(html, new RegExp(`http:\\/\\/127\\.0\\.0\\.1:${sitePort}\\/synthetic-preview\\/src\\/styles\\/global\\.css`))
    assert.match(html, /const siteBasePath = '\/synthetic-preview\/'/)
    assert.match(html, /\{"id":"home","label":"Startseite","path":"\/","cacheBustOnRevision":false\}/)
    assert.match(html, /\{"id":"fixture","label":"Fixture","path":"\/fixture\/","cacheBustOnRevision":true\}/)
    const token = (await (await fetch(`${origin}/api/session`)).json()).token
    assert.match(token, /^[a-f0-9]{64}$/, 'The client must receive a random session token.')
    assert.doesNotMatch(html, new RegExp(token), 'The token must not be embedded in the served HTML.')
    const policy = htmlResponse.headers.get('content-security-policy')
    assert.ok(policy)
    assert.match(policy, /script-src 'nonce-[A-Za-z0-9_-]+'/)
    assert.match(html, /<script nonce="[A-Za-z0-9_-]+">/)
    assert.match(policy, new RegExp(`style-src http:\\/\\/127\\.0\\.0\\.1:${sitePort}`))
    assert.doesNotMatch(policy, /\*/)
    assert.match(policy, /connect-src 'self'/)
    assert.match(policy, /frame-src http:\/\/127\.0\.0\.1:/)
    assert.doesNotMatch(html, /__CSP_NONCE__|__SITE_BASE_PATH__/)
    assert.equal(htmlResponse.headers.get('access-control-allow-origin'), null)
    const stateResponse = await fetch(`${origin}/api/state`)
    const stateText = await stateResponse.text()
    assert.equal(stateResponse.status, 200)
    assert.doesNotMatch(stateText, new RegExp(token))
    const state = JSON.parse(stateText)
    const order = [...state.galleries[0].order].reverse()
    const payload = JSON.stringify({ galleryId: state.galleries[0].id, order, hash: state.hash })
    const headers = { origin, 'content-type': 'application/json' }

    assert.equal(await getWithHost(port, `localhost:${port}`), 403)
    const wrongOrigin = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers: { ...headers, origin: `http://localhost:${port}`, 'x-editor-token': token }, body: payload,
    })
    assert.equal(wrongOrigin.status, 403)
    const missingToken = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers, body: payload,
    })
    assert.equal(missingToken.status, 403)
    const wrongToken = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': `${token[0] === '0' ? '1' : '0'}${token.slice(1)}` }, body: payload,
    })
    assert.equal(wrongToken.status, 403)
    const oldDirectWrite = await fetch(`${origin}/api/reorder`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token }, body: payload,
    })
    assert.equal(oldDirectWrite.status, 404, 'The old write endpoint must not bypass confirmation.')

    const invalidExtraField = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token },
      body: JSON.stringify({ galleryId: state.galleries[0].id, order, hash: state.hash, path: '/tmp/source' }),
    })
    assert.equal(invalidExtraField.status, 422)
    const previewResponse = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token }, body: payload,
    })
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json()
    assert.match(preview.previewId, /^[a-f0-9]{64}$/)
    assert.deepEqual(preview.diff, {
      start: source.indexOf('["noise-fixture-01", "noise-fixture-03"]'),
      end: source.indexOf('["noise-fixture-01", "noise-fixture-03"]') + '["noise-fixture-01", "noise-fixture-03"]'.length,
      before: '["noise-fixture-01", "noise-fixture-03"]',
      after: '["noise-fixture-03","noise-fixture-01"]',
    })
    assert.deepEqual(Object.keys(preview).sort(), ['diff', 'hash', 'nextHash', 'previewId'])
    assert.doesNotMatch(JSON.stringify(preview), /fixture\.mdx|src\/pages|import Gallery|<Gallery/)
    assert.deepEqual(await readFile(fixturePath, 'utf8'), source, 'Preview must never write source.')

    const mismatchedCommit = await fetch(`${origin}/api/commit`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token },
      body: JSON.stringify({ previewId: preview.previewId, galleryId: state.galleries[0].id, order: state.galleries[0].order, hash: state.hash }),
    })
    assert.equal(mismatchedCommit.status, 409)
    const freshPreviewResponse = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token }, body: payload,
    })
    const freshPreview = await freshPreviewResponse.json()
    const unsupportedOptOut = await fetch(`${origin}/api/commit`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token },
      body: JSON.stringify({ ...JSON.parse(payload), previewId: freshPreview.previewId, safeSourceReplacementMode: false }),
    })
    assert.equal(unsupportedOptOut.status, 422)
    assert.equal((await unsupportedOptOut.json()).code, 'INVALID_REQUEST')
    const accepted = await fetch(`${origin}/api/commit`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': token },
      body: JSON.stringify({ ...JSON.parse(payload), previewId: freshPreview.previewId }),
    })
    assert.equal(accepted.status, 409)
    assert.equal((await accepted.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
    assert.deepEqual(inspectFixture(await readFile(fixturePath, 'utf8')).galleries[0].order, state.galleries[0].order)
  } finally {
    await close(editor)
  }
})

test('replacement policy keeps preview/read available, preserves stale edits, and blocks current revisions before injected writer', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-safe-mode-'))
  const fixturePath = path.join(directory, 'fixture.mdx')
  const external = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = ["noise-fixture-03", "noise-fixture-01"];\n\n<Gallery sorted={FIRST} />\n`
  const source = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = ["noise-fixture-01", "noise-fixture-03"];\n\n<Gallery sorted={FIRST} />\n`
  await writeFile(fixturePath, source)
  let writes = 0
  const editor = createEditorServer({ port: 0, fixturePath, writeSource: async () => { writes++ } })
  const origin = `http://127.0.0.1:${await listen(editor)}`
  t.after(async () => { await close(editor); await rm(directory, { recursive: true, force: true }) })
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  const state = await (await fetch(`${origin}/api/state`)).json()
  const order = [...state.galleries[0].order].reverse()
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': token }
  const preview = await (await fetch(`${origin}/api/preview`, { method: 'POST', headers, body: JSON.stringify({ galleryId: state.galleries[0].id, order, hash: state.hash }) })).json()
  // A stale source is rejected before the replacement-policy guard.
  await writeFile(fixturePath, external)
  const response = await fetch(`${origin}/api/commit`, { method: 'POST', headers, body: JSON.stringify({ galleryId: state.galleries[0].id, order, hash: state.hash, previewId: preview.previewId }) })
  assert.equal(response.status, 409)
  const staleFailure = await response.json()
  assert.equal(staleFailure.code, 'STALE_HASH')
  assert.equal(writes, 0)
  assert.equal(await (await import('node:fs/promises')).readFile(fixturePath, 'utf8'), external)
  // With a current revision, the default returns the same actionable refusal.
  await writeFile(fixturePath, source)
  const currentState = await (await fetch(`${origin}/api/state`)).json()
  const currentPreview = await (await fetch(`${origin}/api/preview`, { method: 'POST', headers, body: JSON.stringify({ galleryId: currentState.galleries[0].id, order, hash: currentState.hash }) })).json()
  const unchangedRevision = await fetch(`${origin}/api/commit`, { method: 'POST', headers, body: JSON.stringify({ galleryId: currentState.galleries[0].id, order, hash: currentState.hash, previewId: currentPreview.previewId }) })
  assert.equal(unchangedRevision.status, 409)
  const refusal = await unchangedRevision.json()
  assert.equal(refusal.code, 'SOURCE_REPLACEMENT_DISABLED')
  assert.match(refusal.error, /no changes were written/i)
  assert.equal(writes, 0)
  assert.equal(await (await import('node:fs/promises')).readFile(fixturePath, 'utf8'), source)
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
    const preview = await fetch(`${secondOrigin}/api/preview`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': secondToken }, body: payload,
    })
    const previewResult = await preview.json()
    const previousToken = await fetch(`${secondOrigin}/api/commit`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': firstToken }, body: payload,
    })
    assert.equal(previousToken.status, 403)
    const rotatedToken = await fetch(`${secondOrigin}/api/commit`, {
      method: 'POST', headers: { ...headers, 'x-editor-token': secondToken },
      body: JSON.stringify({ ...JSON.parse(payload), previewId: previewResult.previewId }),
    })
    assert.equal(rotatedToken.status, 409)
    assert.equal((await rotatedToken.json()).code, 'SOURCE_REPLACEMENT_DISABLED')
  } finally {
    await close(second)
  }
})

test('a source change after preview returns 409 and preserves the external edit', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-stale-preview-'))
  const fixturePath = path.join(directory, 'fixture.mdx')
  const source = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = ["noise-fixture-01", "noise-fixture-03"];\n\n<Gallery sorted={FIRST} />\n`
  await writeFile(fixturePath, source, 'utf8')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const editor = createEditorServer({ port: 0, fixturePath })
  const port = await listen(editor)
  const origin = `http://127.0.0.1:${port}`
  const token = (await (await fetch(`${origin}/api/session`)).json()).token
  const state = await (await fetch(`${origin}/api/state`)).json()
  const operation = {
    galleryId: state.galleries[0].id,
    order: [...state.galleries[0].order].reverse(),
    hash: state.hash,
  }
  const headers = { origin, 'content-type': 'application/json', 'x-editor-token': token }

  try {
    const previewResponse = await fetch(`${origin}/api/preview`, {
      method: 'POST', headers, body: JSON.stringify(operation),
    })
    const preview = await previewResponse.json()
    assert.equal(previewResponse.status, 200)
    const externalEdit = '\n# synthetic external edit after preview\n'
    await writeFile(fixturePath, source + externalEdit, 'utf8')

    const commitResponse = await fetch(`${origin}/api/commit`, {
      method: 'POST', headers,
      body: JSON.stringify({ ...operation, previewId: preview.previewId }),
    })
    assert.equal(commitResponse.status, 409)
    assert.equal((await commitResponse.json()).code, 'STALE_HASH')
    assert.deepEqual(await readFile(fixturePath), Buffer.from(source + externalEdit))
  } finally {
    await close(editor)
  }
})

test('unsupported synthetic MDX fails before the atomic writer can be called', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astro-editor-unsupported-'))
  const fixturePath = path.join(directory, 'fixture.mdx')
  const source = `import Gallery from '../components/Gallery.astro';\n\nexport const FIRST = [getImage()];\n\n<Gallery sorted={FIRST} />\n`
  await writeFile(fixturePath, source, 'utf8')
  t.after(() => rm(directory, { recursive: true, force: true }))
  let writerCalls = 0
  const editor = createEditorServer({
    port: 0,
    fixturePath,
    writeSource: async () => { writerCalls += 1 },
  })
  const port = await listen(editor)
  const origin = `http://127.0.0.1:${port}`
  const token = (await (await fetch(`${origin}/api/session`)).json()).token

  try {
    const preview = await fetch(`${origin}/api/preview`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-editor-token': token },
      body: JSON.stringify({ galleryId: 'FIRST', order: ['noise-fixture-01'], hash: hashSource(source) }),
    })
    assert.equal(preview.status, 422)
    assert.equal(writerCalls, 0)
    assert.deepEqual(await readFile(fixturePath), Buffer.from(source))
  } finally {
    await close(editor)
  }
})

test('preview readiness waits for galleries in fixture order instead of accepting swapped markers', async () => {
  let renderedHtml = ''
  let previewRequests = 0
  let requestedPath = ''
  const site = createServer((request, response) => {
    previewRequests += 1
    requestedPath = request.url
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(renderedHtml)
  })
  const sitePort = await listen(site)
  const editor = createEditorServer({ port: 0, sitePort, basePath: '/synthetic-preview/' })
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
    assert.match(requestedPath, /^\/synthetic-preview\/fixture\/\?preview=/)
    const payload = await response.json()
    assert.deepEqual(payload.galleries, state.galleries)
    assert.match(payload.previewUrl, new RegExp(`http:\\/\\/127\\.0\\.0\\.1:${sitePort}\\/synthetic-preview\\/fixture\\/\\?revision=`))
  } finally {
    clearTimeout(switchToCorrectOrder)
    await Promise.all([close(editor), close(site)])
  }
})
