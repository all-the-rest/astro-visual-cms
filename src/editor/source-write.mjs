import { createHash, randomBytes } from 'node:crypto'
import * as defaultFs from 'node:fs/promises'
import path from 'node:path'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function staleHashError() {
  const error = new Error('Fixture changed since it was loaded; reload before saving.')
  error.code = 'STALE_HASH'
  return error
}

function concurrentWriteError() {
  const error = new Error('Source is already being written; reload before saving.')
  error.code = 'STALE_HASH'
  return error
}

async function acquireSourceWriteLock(filePath, fs) {
  const lockPath = `${path.resolve(filePath)}.avcms-lock`
  let handle
  try {
    handle = await fs.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw concurrentWriteError()
    throw error
  }

  try {
    await handle.writeFile(`pid=${process.pid}\n`, 'utf8')
    await handle.sync()
    const identity = await handle.stat()
    return async () => {
      await handle.close()
      let current
      try {
        current = await fs.lstat(lockPath)
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      if (current.dev === identity.dev && current.ino === identity.ino) {
        try {
          await fs.unlink(lockPath)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    }
  } catch (error) {
    let identity
    try {
      identity = await handle.stat()
    } catch {
      // The lock may already have been removed; do not guess at its owner.
    }
    await handle.close().catch(() => {})
    if (identity) {
      try {
        const current = await fs.lstat(lockPath)
        if (current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(lockPath)
      } catch {
        // Preserve the original lock initialization error.
      }
    }
    throw error
  }
}

/**
 * Write source atomically after checking the original hash twice. An exclusive
 * same-directory sidecar lock serializes cooperating editor processes from the
 * first read through rename; contention fails closed as a stale-source conflict.
 * It is not a lock for unrelated programs that do not use this writer.
 */
export async function writeSourceAtomically(filePath, expectedHash, nextSource, fs = defaultFs) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw staleHashError()
  }

  const releaseLock = await acquireSourceWriteLock(filePath, fs)
  let tempPath
  let tempExists = false

  try {
    const initialStat = await fs.stat(filePath)
    if (!initialStat.isFile()) throw staleHashError()
    const initialBytes = await fs.readFile(filePath)
    if (sha256(initialBytes) !== expectedHash) throw staleHashError()

    const directory = path.dirname(filePath)
    const basename = path.basename(filePath)
    while (!tempExists) {
      const candidate = path.join(directory, `.${basename}.${randomBytes(16).toString('hex')}.tmp`)
      try {
        await fs.writeFile(candidate, nextSource, { encoding: 'utf8', flag: 'wx' })
        await fs.chmod(candidate, initialStat.mode & 0o777)
        tempPath = candidate
        tempExists = true
      } catch (error) {
        if (error.code === 'EEXIST') continue
        try {
          await fs.unlink(candidate)
        } catch {
          // Preserve the write error; cleanup is best-effort if the filesystem failed.
        }
        throw error
      }
    }

    const finalBytes = await fs.readFile(filePath)
    if (sha256(finalBytes) !== expectedHash) throw staleHashError()

    await fs.rename(tempPath, filePath)
    tempExists = false
  } finally {
    try {
      if (tempExists) {
        try {
          await fs.unlink(tempPath)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    } finally {
      await releaseLock()
    }
  }
}

/** Create a complete source file atomically without ever replacing an existing path. */
export async function createSourceExclusively(filePath, source, fs = defaultFs) {
  const directory = path.dirname(filePath)
  const basename = path.basename(filePath)
  let tempPath
  let handle
  try {
    while (!handle) {
      const candidate = path.join(directory, `.${basename}.${randomBytes(16).toString('hex')}.tmp`)
      try {
        handle = await fs.open(candidate, 'wx', 0o666)
        tempPath = candidate
      } catch (error) {
        if (error.code === 'EEXIST') continue
        throw error
      }
    }
    await handle.writeFile(source, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.link(tempPath, filePath)
  } finally {
    await handle?.close().catch(() => {})
    if (tempPath) await fs.unlink(tempPath).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
  return { created: true }
}
