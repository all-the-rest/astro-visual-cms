import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { discoverContentCollections, planCollectionCreation, planCollectionFieldExtension } from './collection-discovery.mjs'

export const MAX_COLLECTION_ENTRIES = 250
const MAX_SCANNED_NODES = 10_000
const MAX_COLLECTIONS = 64
const MAX_TOTAL_SCANNED_NODES = 20_000
const MAX_TOTAL_ENTRIES = 500
const MAX_TOTAL_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_ENTRY_BYTES = 1024 * 1024
const EDITABLE_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'enum'])
const EDITABLE_FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/
const SUPPORTED_PATTERNS = new Set(['*.md', '*.mdx', '**/*.md', '**/*.mdx'])

function sha256(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function safeFailure(code, reason) {
  const error = new Error(reason)
  error.code = code
  return error
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertNoDotDot(value) {
  return typeof value === 'string' && !value.split(/[\\/]/).includes('..')
}

function assertSafePath(root, candidate, expectedKind) {
  if (!inside(root, candidate)) throw safeFailure('UNSAFE_COLLECTION_PATH', 'Resolved content path is outside the configured project root.')
  const relative = path.relative(root, candidate)
  const segments = relative.split(path.sep)
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    let stats
    try {
      stats = lstatSync(current)
    } catch {
      throw safeFailure('UNSAFE_COLLECTION_PATH', 'A configured content path does not exist.')
    }
    if (stats.isSymbolicLink()) throw safeFailure('UNSAFE_COLLECTION_PATH', 'Symbolic links in configured content paths are read-only.')
    const final = index === segments.length - 1
    if (!final && !stats.isDirectory()) throw safeFailure('UNSAFE_COLLECTION_PATH', 'A configured content path ancestor is not a directory.')
    if (final && expectedKind === 'directory' && !stats.isDirectory()) {
      throw safeFailure('UNSAFE_COLLECTION_PATH', 'A collection base is not a directory.')
    }
    if (final && expectedKind === 'file' && !stats.isFile()) {
      throw safeFailure('UNSAFE_COLLECTION_PATH', 'A collection entry is not a regular file.')
    }
  }
  let actual
  try {
    actual = realpathSync(candidate)
  } catch {
    throw safeFailure('UNSAFE_COLLECTION_PATH', 'A configured content path could not be resolved safely.')
  }
  if (actual !== candidate) throw safeFailure('UNSAFE_COLLECTION_PATH', 'A configured content path resolves through a symbolic link.')
  return candidate
}

function publicField(field) {
  const editable = EDITABLE_FIELD_TYPES.has(field.type) && EDITABLE_FIELD_NAME.test(field.name)
  return {
    name: field.name,
    type: field.type,
    required: field.required,
    optional: field.optional,
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...(field.values ? { values: field.values } : {}),
    editable,
    ...(!editable ? { reason: field.type === 'date' || field.type.startsWith('array<')
      ? `Frontmatter editing for ${field.type} fields is not supported.`
      : 'This field name or type is outside the editable scalar subset.' } : {}),
  }
}

function patternSupported(patterns) {
  return Array.isArray(patterns) && patterns.length > 0 && patterns.every((pattern) => SUPPORTED_PATTERNS.has(pattern))
}

function matchesPatterns(id, patterns) {
  return patterns.some((pattern) => {
    if (pattern === '*.md') return !id.includes('/') && id.endsWith('.md')
    if (pattern === '*.mdx') return !id.includes('/') && id.endsWith('.mdx')
    if (pattern === '**/*.md') return id.endsWith('.md')
    if (pattern === '**/*.mdx') return id.endsWith('.mdx')
    return false
  })
}

function scanBase(root, base, patterns, budget) {
  const basePath = path.resolve(root, base)
  if (!inside(root, basePath) || !assertNoDotDot(base)) {
    throw safeFailure('UNSAFE_COLLECTION_PATH', 'Collection base must stay inside the configured project root.')
  }
  assertSafePath(root, basePath, 'directory')
  const files = []
  let scannedNodes = 0
  const visit = (directory, prefix) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      scannedNodes += 1
      budget.scannedNodes += 1
      if (scannedNodes > MAX_SCANNED_NODES || budget.scannedNodes > MAX_TOTAL_SCANNED_NODES) {
        throw safeFailure('COLLECTION_LIMIT', 'Collection directory exceeds the safe scan limit.')
      }
      const id = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        throw safeFailure('UNSAFE_COLLECTION_PATH', 'Symbolic links inside a collection base are read-only.')
      }
      if (stats.isDirectory()) {
        visit(absolute, id)
      } else if (stats.isFile() && matchesPatterns(id, patterns)) {
        files.push({ id, path: absolute, size: stats.size })
        budget.entries += 1
        budget.entryBytes += stats.size
        if (files.length > MAX_COLLECTION_ENTRIES || budget.entries > MAX_TOTAL_ENTRIES || budget.entryBytes > MAX_TOTAL_ENTRY_BYTES) {
          throw safeFailure('COLLECTION_LIMIT', `Collection exceeds the ${MAX_COLLECTION_ENTRIES}-entry discovery limit.`)
        }
      }
    }
  }
  visit(basePath, '')
  return files
}

function safeConfigPath(root, configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0 || !assertNoDotDot(configPath)) {
    throw safeFailure('UNSAFE_CONFIG_PATH', 'Configured content config path must be a trusted project-relative or in-root path.')
  }
  const candidate = path.resolve(root, configPath)
  if (!inside(root, candidate)) throw safeFailure('UNSAFE_CONFIG_PATH', 'Configured content config path must be inside the trusted project root.')
  return candidate
}

/** Server-only adapter for a trusted project root and content config file. */
export function createCollectionRuntime({ projectRoot, contentConfigPath }) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('Collection discovery requires an absolute trusted projectRoot.')
  }
  if (typeof contentConfigPath !== 'string' || contentConfigPath.length === 0) {
    throw new TypeError('Collection discovery requires a trusted contentConfigPath.')
  }
  const root = path.resolve(projectRoot)
  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch {
    throw new TypeError('The trusted projectRoot must be an existing directory without symlink traversal.')
  }
  if (realRoot !== root || !lstatSync(root).isDirectory()) {
    throw new TypeError('The trusted projectRoot must be an existing directory without symlink traversal.')
  }
  const configFile = safeConfigPath(root, contentConfigPath)

  function readConfig() {
    assertSafePath(root, configFile, 'file')
    let stats
    try {
      stats = lstatSync(configFile)
    } catch {
      throw safeFailure('UNSAFE_CONFIG_PATH', 'Configured content config file is unavailable.')
    }
    if (stats.size > MAX_ENTRY_BYTES) throw safeFailure('CONFIG_LIMIT', 'Content config exceeds the safe source-size limit.')
    let bytes
    try {
      bytes = readFileSync(configFile)
    } catch {
      throw safeFailure('UNSAFE_CONFIG_PATH', 'Configured content config file is unavailable.')
    }
    if (bytes.length > MAX_ENTRY_BYTES) throw safeFailure('CONFIG_LIMIT', 'Content config exceeds the safe source-size limit.')
    const source = bytes.toString('utf8')
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw safeFailure('UNSAFE_CONFIG_PATH', 'Configured content config is not valid UTF-8.')
    return { source, hash: sha256(source), discovery: discoverContentCollections(source) }
  }

  function inspect() {
    try {
      const config = readConfig()
      if (config.discovery.collections.length > MAX_COLLECTIONS) {
        return {
          configured: true,
          supported: false,
          reason: `Content config exceeds the ${MAX_COLLECTIONS}-collection discovery limit.`,
          collections: [],
          configEditing: {
            supported: false,
            creationSupported: false,
            fieldExtensionSupported: false,
            mode: 'read-only',
            reason: 'Collection creation and schema extension are not connected to the confirmed-write API.',
          },
          _configHash: config.hash,
          _collectionBases: new Map(),
          _collectionPatterns: new Map(),
        }
      }
      const budget = { scannedNodes: 0, entries: 0, entryBytes: 0 }
      const collections = config.discovery.collections.map((collection) => {
        const result = {
          id: collection.name,
          name: collection.name,
          supported: Boolean(collection.supported),
          mode: 'read-only',
          creationSupported: false,
          fields: (collection.fields || []).map(publicField),
          entries: [],
        }
        if (typeof collection.name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(collection.name)) {
          result.supported = false
          result.reason = 'Collection name is outside the supported static identifier subset.'
          return result
        }
        if (!collection.supported) {
          result.reason = collection.reason || 'Collection syntax is outside the supported static subset.'
          return result
        }
        if (!patternSupported(collection.patterns)) {
          result.supported = false
          result.reason = 'Only literal *.md, *.mdx, **/*.md, and **/*.mdx entry patterns are supported.'
          return result
        }
        try {
          const files = scanBase(root, collection.base, collection.patterns, budget)
          result.entries = files.map(({ id, size, path: entryPath }) => ({
            id,
            hash: null,
            editable: result.fields.some((field) => field.editable),
            ...(!result.fields.length ? { reason: collection.reason || 'Collection has no editable schema fields.' } : {}),
            size,
            _path: entryPath,
          }))
          if (!result.fields.some((field) => field.editable)) {
            result.reason = collection.reason || 'Collection has no editable scalar schema fields.'
            return result
          }
          for (const entry of result.entries) {
            if (entry.size > MAX_ENTRY_BYTES) {
              result.entries = []
              result.supported = false
              result.reason = 'An entry exceeds the safe source-size limit; collection is read-only.'
              return result
            }
            try {
              const bytes = readFileSync(entry._path)
              entry.hash = sha256(bytes.toString('utf8'))
            } catch {
              result.entries = []
              result.supported = false
              result.reason = 'A collection entry could not be read safely.'
              return result
            }
          }
          result.mode = 'editable'
          const patterns = config.discovery.collections.find((item) => item.name === collection.name)?.patterns || []
          result.creationExtension = patterns.some((pattern) => pattern.endsWith('.md')) ? '.md' : '.mdx'
          result.creationSupported = patterns.some((pattern) => pattern.endsWith('.md') || pattern.endsWith('.mdx')) &&
            result.fields.every((field) => field.editable || !field.required || field.default !== undefined)
          if (!result.creationSupported) result.creationReason = patterns.some((pattern) => pattern.endsWith('.md'))
            ? 'Entry creation requires every required field to use the supported scalar subset or have a static default.'
            : 'Entry creation requires a supported .md or .mdx glob and supported required scalar fields.'
        } catch (error) {
          result.supported = false
          result.reason = error.code === 'COLLECTION_LIMIT'
            ? 'Aggregate collection discovery limits were reached; this collection is read-only.'
            : error.code === 'UNSAFE_COLLECTION_PATH'
              ? error.message
              : 'Collection files could not be discovered safely.'
          result.entries = []
        }
        return result
      })
      // Internal path data is stripped before the state is returned by the HTTP layer.
      return {
        configured: true,
        supported: config.discovery.supported,
        ...(config.discovery.reason ? { reason: config.discovery.reason } : {}),
        collections,
        configEditing: {
          supported: config.discovery.supported,
          creationSupported: config.discovery.supported,
          fieldExtensionSupported: config.discovery.supported,
          mode: config.discovery.supported ? 'creation-and-schema-extension' : 'read-only',
          reason: config.discovery.supported ? 'API-only static collection creation and explicit schema field extension are available.' : 'Unsupported or dynamic config syntax remains read-only.',
        },
        _configHash: config.hash,
        _collectionBases: new Map(config.discovery.collections
          .filter((item) => typeof item.name === 'string')
          .map((item) => [item.name, item.base])),
        _collectionPatterns: new Map(config.discovery.collections
          .filter((item) => typeof item.name === 'string')
          .map((item) => [item.name, item.patterns || []])),
      }
    } catch (error) {
      return {
        configured: true,
        supported: false,
        collections: [],
        reason: error.code === 'UNSAFE_CONFIG_PATH' || error.code === 'UNSAFE_COLLECTION_PATH'
          ? error.message
          : 'Content config could not be read safely; collection editing is read-only.',
        configEditing: {
          supported: false,
          creationSupported: false,
          fieldExtensionSupported: false,
          mode: 'read-only',
          reason: 'Content config could not be read safely.',
        },
        _configHash: null,
        _collectionBases: new Map(),
        _collectionPatterns: new Map(),
      }
    }
  }

  function getEntryForEdit(collectionId, entryId, fieldName) {
    const state = inspect()
    const collection = state.collections.find((item) => item.id === collectionId)
    if (!state.supported || !collection || collection.mode !== 'editable') {
      throw safeFailure('UNSUPPORTED_COLLECTION', collection?.reason || state.reason || 'Collection is not supported for edits.')
    }
    const field = collection.fields.find((item) => item.name === fieldName)
    if (!field?.editable) throw safeFailure('UNSUPPORTED_FIELD', 'Field is not in the supported scalar editing subset.')
    const entry = collection.entries.find((item) => item.id === entryId)
    if (!entry) throw safeFailure('UNSUPPORTED_ENTRY', 'Entry ID is not part of the current collection glob.')
    const base = path.resolve(root, state._collectionBases.get(collectionId))
    const absolute = path.resolve(base, entry.id)
    if (!inside(base, absolute) || !assertNoDotDot(entry.id) || entry.id.split('/').some((part) => !part || part === '.')) {
      throw safeFailure('UNSAFE_COLLECTION_PATH', 'Entry ID is not a safe relative collection entry ID.')
    }
    assertSafePath(root, absolute, 'file')
    const relativeId = path.relative(base, absolute).split(path.sep).join('/')
    if (!matchesPatterns(relativeId, state._collectionPatterns.get(collectionId))) {
      throw safeFailure('UNSUPPORTED_ENTRY', 'Entry ID does not match the current collection glob.')
    }
    let stats
    try {
      stats = lstatSync(absolute)
    } catch {
      throw safeFailure('UNSAFE_COLLECTION_PATH', 'Collection entry changed or became unavailable during validation.')
    }
    if (stats.size > MAX_ENTRY_BYTES) throw safeFailure('ENTRY_LIMIT', 'Collection entry exceeds the safe source-size limit.')
    let source
    try {
      source = readFileSync(absolute, 'utf8')
    } catch {
      throw safeFailure('UNSAFE_COLLECTION_PATH', 'Collection entry could not be read safely.')
    }
    return {
      state,
      collection,
      field,
      entry: { id: relativeId, hash: sha256(source) },
      source,
      path: absolute,
      configHash: state._configHash,
    }
  }

  function planEntryCreation({ collectionId, entryId, values, hash }) {
    const state = inspect()
    if (state._configHash !== hash) throw safeFailure('STALE_CONFIG', 'Content config changed; prepare the entry again.')
    const collection = state.collections.find((item) => item.id === collectionId)
    if (!state.supported || collection?.mode !== 'editable') {
      throw safeFailure('UNSUPPORTED_COLLECTION', collection?.reason || state.reason || 'Collection is not supported for entry creation.')
    }
    if (typeof entryId !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62})?\.(?:md|mdx)$/.test(entryId) || entryId.length > 68) {
      throw safeFailure('INVALID_ENTRY_ID', 'Entry filename must be a simple lowercase slug ending in .md or .mdx.')
    }
    if (!matchesPatterns(entryId, state._collectionPatterns.get(collectionId))) {
      throw safeFailure('UNSUPPORTED_ENTRY', 'Filename does not match the configured collection glob.')
    }
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 32) {
      throw safeFailure('INVALID_FIELD_VALUE', 'Entry values must be a bounded object of supported schema fields.')
    }
    const valuesByName = Object.create(null)
    for (const key of Object.keys(values)) valuesByName[key] = values[key]
    const data = Object.create(null)
    for (const field of collection.fields) {
      const supplied = Object.hasOwn(valuesByName, field.name)
      if (!field.editable) {
        if (supplied) throw safeFailure('UNSUPPORTED_FIELD', `Entry creation cannot set unsupported field ${field.name}.`)
        if (field.required && field.default === undefined) throw safeFailure('UNSUPPORTED_FIELD', `Required field ${field.name} is outside the supported scalar subset.`)
        if (field.default !== undefined) data[field.name] = field.default
        continue
      }
      if (supplied) {
        const value = valuesByName[field.name]
        const matches = field.type === 'string' ? typeof value === 'string' && value.length <= 512
          : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : field.type === 'boolean' ? typeof value === 'boolean'
              : field.type === 'enum' ? typeof value === 'string' && field.values.includes(value)
                : false
        if (!matches) throw safeFailure('INVALID_FIELD_VALUE', `Value does not match supported schema field ${field.name}.`)
        data[field.name] = value
      } else if (field.default !== undefined) {
        data[field.name] = field.default
      } else if (field.required) {
        throw safeFailure('INVALID_FIELD_VALUE', `Required field ${field.name} is missing.`)
      }
    }
    const knownNames = new Set(collection.fields.map((field) => field.name))
    if (Object.keys(valuesByName).some((key) => !knownNames.has(key))) {
      throw safeFailure('UNSUPPORTED_FIELD', 'Entry values contain a field outside the current collection schema.')
    }
    const source = `---\n${stringifyYaml(data, { lineWidth: 0 })}---\n`
    if (Buffer.byteLength(source) > MAX_ENTRY_BYTES) throw safeFailure('ENTRY_LIMIT', 'Generated entry exceeds the safe source-size limit.')
    const base = path.resolve(root, state._collectionBases.get(collectionId))
    assertSafePath(root, base, 'directory')
    const target = path.resolve(base, entryId)
    if (!inside(base, target) || path.dirname(target) !== base) throw safeFailure('UNSAFE_COLLECTION_PATH', 'New entry must be directly inside the trusted collection base.')
    try {
      lstatSync(target)
      throw safeFailure('ENTRY_EXISTS', 'An entry already exists at this filename.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const updatedState = inspect()
    if (updatedState._configHash !== hash || updatedState.collections.find((item) => item.id === collectionId)?.mode !== 'editable') {
      throw safeFailure('STALE_CONFIG', 'Collection configuration changed; prepare the entry again.')
    }
    return {
      collectionId,
      entryId,
      path: target,
      source,
      hash: sha256(source),
      configHash: hash,
      diff: { start: 0, end: 0, before: '', after: source },
    }
  }

  function planFieldExtension(operation) {
    const config = readConfig()
    if (config.hash !== operation.hash) throw safeFailure('STALE_CONFIG', 'Content config changed; prepare the edit again.')
    if (!config.discovery.supported) throw safeFailure('UNSUPPORTED_CONFIG', 'Content config is outside the supported static subset.')
    return planCollectionFieldExtension(config.source, { collection: operation.collection, field: operation.field, expectedHash: operation.hash })
  }

  function planCreation(operation) {
    const config = readConfig()
    if (config.hash !== operation.hash) throw safeFailure('STALE_CONFIG', 'Content config changed; prepare the edit again.')
    if (!config.discovery.supported) throw safeFailure('UNSUPPORTED_CONFIG', 'Content config is outside the supported static subset.')
    const basePath = path.resolve(root, operation.base)
    assertSafePath(root, basePath, 'directory')
    return planCollectionCreation(config.source, {
      name: operation.name, base: operation.base, pattern: operation.pattern,
      fields: operation.fields, expectedHash: operation.hash,
    })
  }

  return {
    inspect,
    getEntryForEdit,
    planEntryCreation,
    planFieldExtension,
    planCreation,
    configPath: configFile,
    assertEntrySafe(filePath) {
      assertSafePath(root, filePath, 'file')
    },
  }
}

export function publicCollectionState(state) {
  const { _configHash, _collectionBases, _collectionPatterns, ...publicState } = state
  publicState.configHash = _configHash
  for (const collection of publicState.collections || []) {
    collection.entries = collection.entries.map(({ _path, ...entry }) => entry)
  }
  return publicState
}
