import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createEditorServer, validateDemoImageSlugs } from '../src/editor/server.mjs'

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
