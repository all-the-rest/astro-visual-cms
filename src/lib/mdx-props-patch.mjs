import { createProcessor } from '@mdx-js/mdx'
import { hashSource } from './gallery-patch.mjs'

const processor = createProcessor({ format: 'mdx' })
function reject(message, code = 'UNSUPPORTED_TARGET') { throw Object.assign(new Error(message), { code }) }

function normalizeFields(editableProps, fields) {
  if (fields === undefined && Array.isArray(editableProps)) fields = editableProps.map((name) => ({ name, type: 'string' }))
  if (!Array.isArray(fields) || !fields.length || fields.length > 32) reject('Invalid trusted component field list.', 'INVALID_ADAPTER_CONFIG')
  const names = new Set()
  return fields.map((field) => {
    const allowed = ['name', 'type', 'label', 'min', 'max', 'step', 'values']
    if (!field || typeof field !== 'object' || Array.isArray(field) || Object.keys(field).some((key) => !allowed.includes(key)) ||
        typeof field.name !== 'string' || !/^[A-Za-z_$][\w$-]*$/.test(field.name) || names.has(field.name) ||
        !['string', 'number', 'boolean', 'enum'].includes(field.type)) reject('Invalid trusted component field descriptor.', 'INVALID_ADAPTER_CONFIG')
    names.add(field.name)
    if (field.label !== undefined && (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 80 || /[\u0000-\u001f\u007f]/.test(field.label))) reject('Invalid field label.', 'INVALID_ADAPTER_CONFIG')
    if (field.type === 'number') {
      if (Object.hasOwn(field, 'values') || ['min', 'max', 'step'].some((key) => Object.hasOwn(field, key) && (typeof field[key] !== 'number' || !Number.isFinite(field[key]))) ||
          field.min !== undefined && field.max !== undefined && field.min > field.max || field.step !== undefined && field.step <= 0) reject('Invalid numeric field constraints.', 'INVALID_ADAPTER_CONFIG')
    } else if (field.type === 'enum') {
      if (!Array.isArray(field.values) || !field.values.length || field.values.length > 32 || field.values.some((item) => typeof item !== 'string' || !item || item.length > 128) || new Set(field.values).size !== field.values.length || ['min', 'max', 'step'].some((key) => Object.hasOwn(field, key))) reject('Invalid enum choices.', 'INVALID_ADAPTER_CONFIG')
    } else if (['min', 'max', 'step', 'values'].some((key) => Object.hasOwn(field, key))) reject('Constraints are unsupported for this field type.', 'INVALID_ADAPTER_CONFIG')
    return Object.freeze({ ...field })
  })
}

function literal(source, attr, descriptor) {
  const bomCorrection = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const start = attr.position?.start?.offset + bomCorrection, end = attr.position?.end?.offset + bomCorrection
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) reject('Parser did not provide an exact attribute source range.')
  const raw = source.slice(start, end), name = String(attr.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let expression, value, encoded
  if (descriptor.type === 'string' || descriptor.type === 'enum') {
    const match = new RegExp(`^${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")$`).exec(raw)
    if (!match) reject(`Prop ${attr.name} must be a quoted static string.`)
    try { value = JSON.parse(match[1]) } catch { reject('String literal is not an exact JSON string.') }
    if (value !== attr.value) reject('String literal decoding is ambiguous.')
    expression = match[1]; encoded = JSON.stringify
  } else {
    const match = new RegExp(`^${name}\\s*=\\s*\\{(true|false|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\}$`).exec(raw)
    if (!match) reject(`Prop ${attr.name} must use a simple static scalar expression.`)
    expression = match[1]; value = expression === 'true' ? true : expression === 'false' ? false : Number(expression)
    if (descriptor.type === 'boolean' && typeof value !== 'boolean' || descriptor.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) reject(`Prop ${attr.name} has the wrong scalar type.`)
    encoded = (next) => `{${String(next)}}`
  }
  if (!validValue(descriptor, value)) reject(`Prop ${attr.name} violates its trusted field constraints.`)
  const offset = start + (descriptor.type === 'number' || descriptor.type === 'boolean' ? raw.indexOf('{') : raw.lastIndexOf(expression))
  const rangeEnd = descriptor.type === 'number' || descriptor.type === 'boolean' ? source.indexOf('}', offset) + 1 : offset + expression.length
  if (rangeEnd <= offset) reject('Scalar expression source range is ambiguous.')
  return { value, range: { start: offset, end: rangeEnd }, encode: encoded }
}

function validValue(field, value) {
  if (field.type === 'string') return typeof value === 'string' && value.length <= 512
  if (field.type === 'enum') return typeof value === 'string' && field.values.includes(value)
  if (field.type === 'boolean') return typeof value === 'boolean'
  if (typeof value !== 'number' || !Number.isFinite(value) || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max) return false
  if (field.step === undefined) return true
  const steps = (value - (field.min ?? 0)) / field.step
  return Math.abs(steps - Math.round(steps)) <= Number.EPSILON * Math.max(1, Math.abs(steps)) * 8
}

export function createMdxPropsAdapter({ importSource, idProp = 'id', editableProps, fields }) {
  const descriptors = normalizeFields(editableProps, fields)
  if (typeof importSource !== 'string' || !importSource || typeof idProp !== 'string' || !/^[A-Za-z_$][\w$-]*$/.test(idProp) || descriptors.some((item) => item.name === idProp)) reject('Invalid trusted component adapter configuration.', 'INVALID_ADAPTER_CONFIG')
  const byName = new Map(descriptors.map((item) => [item.name, item]))
  function inspect(source) {
    let tree
    try { tree = processor.parse(source) } catch { reject('The MDX source is unsupported.', 'UNSUPPORTED_SYNTAX') }
    const imports = [], instances = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'mdxjsEsm') for (const item of node.data?.estree?.body || []) if (item.type === 'ImportDeclaration' && item.source.value === importSource) {
        if (item.importKind === 'type' || item.specifiers.length !== 1 || item.specifiers[0].type !== 'ImportDefaultSpecifier') reject('Target must be one default-only static import.')
        imports.push(item.specifiers[0].local.name)
      }
      if (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) && node.name) instances.push(node)
      for (const [key, value] of Object.entries(node)) if (key !== 'position' && key !== 'data') Array.isArray(value) ? value.forEach(visit) : value && typeof value === 'object' && visit(value)
    }
    visit(tree)
    if (imports.length !== 1) reject('Expected one target default import from the trusted module.')
    const targets = instances.filter((node) => node.name === imports[0])
    if (!targets.length) reject('No target component instance exists.')
    const ids = new Set()
    const records = targets.map((node) => {
      const attrs = node.attributes || []
      if (attrs.some((attr) => attr.type !== 'mdxJsxAttribute')) reject('Spread attributes are read-only.')
      const idAttrs = attrs.filter((attr) => attr.name === idProp)
      if (idAttrs.length !== 1 || typeof idAttrs[0].value !== 'string') reject('Identity must be one static string.')
      const id = idAttrs[0].value
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id)) reject('Duplicate or invalid target identity.')
      ids.add(id)
      const values = {}, seen = new Set()
      for (const attr of attrs) {
        if (attr.name === idProp) continue
        if (seen.has(attr.name)) reject(`Duplicate prop ${attr.name} is ambiguous.`)
        seen.add(attr.name)
        const descriptor = byName.get(attr.name)
        if (!descriptor) continue
        values[attr.name] = { ...literal(source, attr, descriptor), descriptor }
      }
      return { id, values }
    })
    return { records, hash: hashSource(source) }
  }
  return Object.freeze({
    descriptors,
    inspect(source) {
      const state = inspect(source)
      return { instances: state.records.map(({ id, values }) => ({ id, props: Object.fromEntries(Object.entries(values).map(([key, item]) => [key, item.value])) })), fields: descriptors, hash: state.hash }
    },
    patch(source, id, prop, value, expectedHash) {
      if (hashSource(source) !== expectedHash) reject('Source changed since preview.', 'STALE_HASH')
      const descriptor = byName.get(prop)
      if (!descriptor || !validValue(descriptor, value)) reject('Value violates the trusted component field.', 'UNSUPPORTED_VALUE')
      const state = inspect(source), matches = state.records.filter((record) => record.id === id)
      if (matches.length !== 1 || !matches[0].values[prop]) reject('Target identity or configured prop is absent or ambiguous.')
      const target = matches[0].values[prop]
      if (target.value === value) return { source, instances: this.inspect(source).instances, hash: state.hash, diff: null }
      const before = source.slice(target.range.start, target.range.end), after = target.encode(value)
      const updated = source.slice(0, target.range.start) + after + source.slice(target.range.end)
      const checked = inspect(updated)
      return { source: updated, instances: checked.records.map(({ id: instanceId, values }) => ({ id: instanceId, props: Object.fromEntries(Object.entries(values).map(([key, item]) => [key, item.value])) })), hash: checked.hash, diff: { start: target.range.start, end: target.range.end, before, after } }
    },
  })
}
