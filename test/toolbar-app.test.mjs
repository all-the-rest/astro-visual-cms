import assert from 'node:assert/strict'
import test from 'node:test'
import toolbarApp from '../src/editor/toolbar-app.mjs?port=4322&routes=%5B%5D'

function harness({ open, fetchImpl, pathname = '/', module = toolbarApp }) {
  let toggled, notification
  const messages = []
  const canvas = { replaceChildren() { messages.length = 0 }, append(node) { messages.push(node.textContent) } }
  const app = { onToggled(callback) { toggled = callback }, toggleNotification(payload) { notification = payload } }
  const previous = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch, document: globalThis.document }
  globalThis.window = { open }
  globalThis.location = { pathname }
  globalThis.fetch = fetchImpl
  globalThis.document = { createElement: () => ({ textContent: '' }) }
  module.init(canvas, app)
  return { toggle: () => toggled({ state: true }), messages, get notification() { return notification }, restore() { Object.assign(globalThis, previous) } }
}

test('toolbar launcher reports popup blocking without relying on undocumented toolbar APIs', () => {
  const state = harness({ open: () => null, fetchImpl: async () => new Response(null, { status: 204 }) })
  try {
    state.toggle()
    assert.match(state.messages.join(' '), /Pop-ups/)
    assert.equal(state.notification?.level, 'warning')
  } finally { state.restore() }
})

test('toolbar launcher closes a blank tab and reports editor unavailability', async () => {
  let closed = false
  const state = harness({ open: () => ({ close() { closed = true }, set opener(_value) {}, location: { replace() {} } }), fetchImpl: async () => { throw new Error('offline') } })
  try {
    state.toggle()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, true)
    assert.match(state.messages.join(' '), /Editor nicht erreichbar/)
    assert.equal(state.notification?.level, 'error')
  } finally { state.restore() }
})

test('toolbar launch carries only the matched trusted route ID and defaults when unmapped', async () => {
  const routes = encodeURIComponent(JSON.stringify([{ id: 'references', path: '/referenzen/', label: 'Referenzen' }]))
  const app = (await import(`../src/editor/toolbar-app.mjs?port=4322&routes=${routes}`)).default
  for (const [pathname, expectedRoute] of [['/referenzen/', 'references'], ['/not-mapped/', null]]) {
    let openedUrl = ''
    const state = harness({
      open: () => ({ set opener(_value) {}, location: { replace(value) { openedUrl = value } } }),
      fetchImpl: async () => new Response(null, { status: 204 }),
      pathname,
      module: app,
    })
    try {
      state.toggle()
      await new Promise((resolve) => setImmediate(resolve))
      const url = new URL(openedUrl)
      assert.equal(url.searchParams.get('route'), expectedRoute)
      assert.equal(url.searchParams.has('path'), false)
      assert.equal(url.pathname, '/')
    } finally { state.restore() }
  }
})
