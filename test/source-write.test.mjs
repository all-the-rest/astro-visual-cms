import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSourceExclusively, writeSourceAtomically } from '../src/editor/source-write.mjs'

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

test('exclusive source creation publishes complete bytes and never replaces an existing entry', async (t) => {
  const { directory } = await makeFixture(t, 'existing file stays intact\n')
  const newPath = path.join(directory, 'new-entry.md')
  const content = '---\ntitle: "Neue Referenz — 東京"\n---\n'

  await createSourceExclusively(newPath, content)
  assert.deepEqual(await fs.readFile(newPath), Buffer.from(content, 'utf8'))
  await assert.rejects(createSourceExclusively(newPath, 'must not replace'), { code: 'EEXIST' })
  assert.equal(await fs.readFile(newPath, 'utf8'), content)
  assert.equal(await fs.readFile(path.join(directory, 'fixture.mdx'), 'utf8'), 'existing file stays intact\n')
  assert.deepEqual((await fs.readdir(directory)).sort(), ['fixture.mdx', 'new-entry.md'])
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

test('concurrent writes in one editor process are rejected while the source lock is held', async (t) => {
  const original = 'synthetic fixture source\n'
  const { directory, filePath } = await makeFixture(t, original)
  let signalLock
  let releaseWrite
  const lockHeld = new Promise((resolve) => { signalLock = resolve })
  const writeGate = new Promise((resolve) => { releaseWrite = resolve })
  let reads = 0
  const injectedFs = {
    ...fs,
    async readFile(target, ...args) {
      const bytes = await fs.readFile(target, ...args)
      if (target === filePath && ++reads === 2) {
        signalLock()
        await writeGate
      }
      return bytes
    },
  }
  const winner = writeSourceAtomically(filePath, hash(original), 'synthetic in-process winner\n', injectedFs)
  let timeout
  const lockTimeout = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('source writer did not acquire the lock')), 5_000) })
  try {
    await Promise.race([lockHeld, lockTimeout])
    await assert.rejects(writeSourceAtomically(filePath, hash(original), 'synthetic in-process loser\n'), { code: 'STALE_HASH' })
  } finally {
    clearTimeout(timeout)
    releaseWrite()
  }
  await winner
  assert.equal(await fs.readFile(filePath, 'utf8'), 'synthetic in-process winner\n')
  await assertNoTempFiles(directory)
})

test('a competing process cannot overwrite a source write while holding the per-file lock', async (t) => {
  const original = 'synthetic fixture source\n'
  const competingEdit = 'synthetic edit from the other editor process\n'
  const { directory, filePath } = await makeFixture(t, original)
  const moduleUrl = new URL('../src/editor/source-write.mjs', import.meta.url).href
  const childScript = `
    import * as fs from 'node:fs/promises'
    import { writeSourceAtomically } from ${JSON.stringify(moduleUrl)}
    const filePath = ${JSON.stringify(filePath)}
    const source = ${JSON.stringify(competingEdit)}
    const expectedHash = ${JSON.stringify(hash(original))}
    let reads = 0
    const injectedFs = {
      ...fs,
      async readFile(target, ...args) {
        const bytes = await fs.readFile(target, ...args)
        if (target === filePath && ++reads === 2) {
          process.stdout.write('LOCK_HELD\\n')
          await new Promise((resolve) => process.stdin.once('data', resolve))
        }
        return bytes
      },
    }
    await writeSourceAtomically(filePath, expectedHash, source, injectedFs)
    process.stdout.write('CHILD_COMMITTED\\n')
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const childClosed = new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])))

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not acquire its write lock: ${stderr}`)), 5_000)
    const check = () => {
      if (stdout.includes('LOCK_HELD\n')) {
        clearTimeout(timeout)
        resolve()
      }
    }
    child.stdout.on('data', check)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => {
      if (!stdout.includes('LOCK_HELD\n')) {
        clearTimeout(timeout)
        reject(new Error(`child exited before acquiring its write lock (${code}): ${stderr}`))
      }
    })
    check()
  })

  await assert.rejects(writeSourceAtomically(filePath, hash(original), 'synthetic competing local edit\n'), { code: 'STALE_HASH' })
  child.stdin.end('continue\n')
  const [code, signal] = await childClosed
  assert.equal(code, 0, `child failed (${signal}): ${stderr}`)
  assert.match(stdout, /CHILD_COMMITTED\n/)
  assert.deepEqual(await fs.readFile(filePath), Buffer.from(competingEdit, 'utf8'))
  await assertNoTempFiles(directory)
})
