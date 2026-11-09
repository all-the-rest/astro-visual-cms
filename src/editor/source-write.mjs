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

/**
 * Write source atomically after checking the original hash twice. `fs` only needs
 * readFile(path), writeFile(path, data, options), rename(from, to), and unlink(path).
 * Wrapping rename in tests can model an external writer in the final check-to-rename
 * race window; this is not a cross-process compare-and-swap operation.
 */
export async function writeSourceAtomically(filePath, expectedHash, nextSource, fs = defaultFs) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw staleHashError()
  }

  const initialStat = await fs.stat(filePath)
  if (!initialStat.isFile()) throw staleHashError()
  const initialBytes = await fs.readFile(filePath)
  if (sha256(initialBytes) !== expectedHash) throw staleHashError()

  const directory = path.dirname(filePath)
  const basename = path.basename(filePath)
  let tempPath
  let tempExists = false

  try {
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
    if (tempExists) {
      try {
        await fs.unlink(tempPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
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
