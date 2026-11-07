import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorServer } from '../src/editor/server.mjs'

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
