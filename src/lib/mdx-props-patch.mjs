import { createProcessor } from '@mdx-js/mdx'
import { hashSource } from './gallery-patch.mjs'

const processor = createProcessor({ format: 'mdx' })

function reject(message, code = 'UNSUPPORTED_TARGET') {
  const error = new Error(message)
  error.code = code
  throw error
}

/** Build a narrow, trusted adapter for literal string props on imported MDX components. */
export function createMdxPropsAdapter({ importSource, idProp = 'id', editableProps }) {
  if (typeof importSource !== 'string' || !importSource || typeof idProp !== 'string' ||
      !/^[A-Za-z_$][\w$-]*$/.test(idProp) || !Array.isArray(editableProps) || editableProps.length === 0 ||
      editableProps.some((prop) => typeof prop !== 'string' || !/^[A-Za-z_$][\w$-]*$/.test(prop)) ||
      new Set(editableProps).size !== editableProps.length || editableProps.includes(idProp)) {
    reject('Invalid trusted component adapter configuration.', 'INVALID_ADAPTER_CONFIG')
  }

  function inspect(source) {
    let tree
    try { tree = processor.parse(source) } catch { reject('The MDX source is unsupported.', 'UNSUPPORTED_SYNTAX') }
    const imports = []
    const instances = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'mdxjsEsm') {
        // Deliberately accept only static import declarations parsed by the MDX ESM parser.
        const ast = node.data?.estree
        for (const item of ast?.body || []) {
          if (item.type === 'ImportDeclaration' && item.source.value === importSource) {
            if (item.importKind === 'type') reject('Type-only component imports are not editable.')
            const named = item.specifiers.filter((s) => s.type === 'ImportDefaultSpecifier')
            if (named.length !== 1 || item.specifiers.length !== 1) reject('Target must be one default-only import from the trusted source.')
            imports.push(named[0].local.name)
          }
        }
      }
      if (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) && node.name) instances.push(node)
      for (const [key, value] of Object.entries(node)) {
        if (key === 'position' || key === 'data') continue
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(tree)
    if (imports.length !== 1) reject('Expected one target default import from the trusted module.')
    const binding = imports[0]
    // Alias imports are supported by binding name, while mismatched JSX names are inert.
    const targets = instances.filter((node) => node.name === binding)
    if (targets.length === 0) reject('No uniquely identified target component instance exists.')
    const seenIds = new Set()
    const records = targets.map((node) => {
      const attrs = node.attributes || []
      if (attrs.some((a) => a.type !== 'mdxJsxAttribute')) reject('Spread attributes are read-only.')
      const ids = attrs.filter((a) => a.name === idProp)
      if (ids.length !== 1 || typeof ids[0].value !== 'string') reject('Target identity must be one static string literal.')
      const id = ids[0].value
      if (seenIds.has(id)) reject('Duplicate target identity is ambiguous.')
      seenIds.add(id)
      const values = {}
      const seenProps = new Set()
      for (const attr of attrs) {
        if (attr.name === idProp) continue
        if (!editableProps.includes(attr.name)) reject(`Unknown prop ${attr.name} is read-only.`)
        if (seenProps.has(attr.name)) reject(`Duplicate prop ${attr.name} is ambiguous.`)
        seenProps.add(attr.name)
        if (typeof attr.value !== 'string') reject(`Prop ${attr.name} must be a static string literal.`)
        values[attr.name] = { value: attr.value, range: literalRange(source, attr) }
      }
      return { id, values }
    })
    return { instances: records.map(({ id, values }) => ({ id, props: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.value])) })), hash: hashSource(source), records }
  }

  return Object.freeze({
    inspect(source) {
      const { instances, hash } = inspect(source)
      return { instances, hash }
    },
    patch(source, id, prop, value, expectedHash) {
      if (hashSource(source) !== expectedHash) reject('Source changed since preview.', 'STALE_HASH')
      if (!editableProps.includes(prop) || typeof value !== 'string') reject('Only configured string props can be edited.', 'UNSUPPORTED_VALUE')
      const { records } = inspect(source)
      const matches = records.filter((record) => record.id === id)
      if (matches.length !== 1) reject('Target identity is missing or ambiguous.')
      const target = matches[0].values[prop]
      if (!target) reject('Configured prop is absent or not statically editable.')
      const before = source.slice(target.range.start, target.range.end)
      const after = JSON.stringify(value)
      const updated = source.slice(0, target.range.start) + after + source.slice(target.range.end)
      const checked = inspect(updated)
      return { source: updated, instances: checked.records.map(({ id: instanceId, values }) => ({ id: instanceId, props: Object.fromEntries(Object.entries(values).map(([key, item]) => [key, item.value])) })), hash: checked.hash, diff: { start: target.range.start, end: target.range.end, before, after } }
    },
  })
}

function literalRange(source, attribute) {
  const start = attribute.position?.start?.offset
  const end = attribute.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) reject('Parser did not provide a literal source range.')
  const raw = source.slice(start, end)
  const escapedName = String(attribute.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escapedName}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")$`).exec(raw)
  if (!match) reject('Only exact JSON-compatible quoted string attribute ranges are supported.')
  let decoded
  try { decoded = JSON.parse(match[1]) } catch { reject('Only JSON-compatible quoted string literals are supported.') }
  if (decoded !== attribute.value) reject('Quoted literal decoding is ambiguous for this MDX parser value.')
  const literalStart = start + raw.indexOf(match[1])
  const literalEnd = literalStart + match[1].length
  return { start: literalStart, end: literalEnd }
}
