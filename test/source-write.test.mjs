import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeSourceAtomically } from '../src/editor/source-write.mjs'

function hash(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

async function makeFixture(t, source) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'astro-editor-source-write-'))
  const filePath = path.join(directory, 'fixture.mdx')
  await fs.writeFile(filePath, source, 'utf8')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { directory, filePath }
}

async function assertNoTempFiles(directory) {
  assert.deepEqual(await fs.readdir(directory), ['fixture.mdx'])
}

test('stale expected hash writes nothing', async (t) => {
  const original = 'synthetic fixture source\n'
  const { directory, filePath } = await makeFixture(t, original)

  await assert.rejects(writeSourceAtomically(filePath, hash('different source'), 'replacement'), { code: 'STALE_HASH' })
  await assert.rejects(writeSourceAtomically(filePath, 'A'.repeat(64), 'replacement'), { code: 'STALE_HASH' })
  assert.equal(await fs.readFile(filePath, 'utf8'), original)
  await assertNoTempFiles(directory)
})

test('an external change between reads aborts without rename and cleans the temp file', async (t) => {
  const original = 'synthetic fixture source\n'
  const external = `${original}// external synthetic edit\n`
  const { directory, filePath } = await makeFixture(t, original)
  let reads = 0
  let renames = 0
  const injectedFs = {
    ...fs,
    async readFile(target, ...args) {
      reads += 1
      if (reads === 2) await fs.writeFile(target, external, 'utf8')
      return fs.readFile(target, ...args)
    },
    async rename(...args) {
      renames += 1
      return fs.rename(...args)
    },
  }

  await assert.rejects(writeSourceAtomically(filePath, hash(original), 'replacement', injectedFs), { code: 'STALE_HASH' })
  assert.equal(reads, 2)
  assert.equal(renames, 0)
  assert.equal(await fs.readFile(filePath, 'utf8'), external)
  await assertNoTempFiles(directory)
})

test('happy path atomically writes exact bytes and leaves no temp files', async (t) => {
  const original = 'synthetic fixture source\n'
  const nextSource = 'synthetic reordered fixture — exact UTF-8 bytes\n'
  const { directory, filePath } = await makeFixture(t, original)

  await writeSourceAtomically(filePath, hash(original), nextSource)
  assert.deepEqual(await fs.readFile(filePath), Buffer.from(nextSource, 'utf8'))
  await assertNoTempFiles(directory)
})

test('atomic replacement preserves restrictive source permission bits', async (t) => {
  const original = 'synthetic private source\n'
  const { directory, filePath } = await makeFixture(t, original)
  await fs.chmod(filePath, 0o600)

  await writeSourceAtomically(filePath, hash(original), 'replacement private source\n')

  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600)
  assert.equal(await fs.readFile(filePath, 'utf8'), 'replacement private source\n')
  await assertNoTempFiles(directory)
})

test('residual race boundary: a change after the final hash check and before rename is overwritten', async (t) => {
  const original = 'synthetic fixture source\n'
  const external = `${original}// external synthetic edit in final race window\n`
  const nextSource = 'synthetic requested replacement\n'
  const { directory, filePath } = await makeFixture(t, original)
  let reads = 0
  const injectedFs = {
    ...fs,
    async readFile(...args) {
      reads += 1
      return fs.readFile(...args)
    },
    async rename(tempPath, targetPath) {
      assert.equal(reads, 2, 'the simulated external write must be after the final hash check')
      await fs.writeFile(targetPath, external, 'utf8')
      return fs.rename(tempPath, targetPath)
    },
  }

  await writeSourceAtomically(filePath, hash(original), nextSource, injectedFs)
  assert.deepEqual(await fs.readFile(filePath), Buffer.from(nextSource, 'utf8'))
  await assertNoTempFiles(directory)
})
