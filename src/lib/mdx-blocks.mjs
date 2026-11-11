import { createProcessor } from '@mdx-js/mdx'
import { hashSource } from './gallery-patch.mjs'

const processor = createProcessor({ format: 'mdx' })
const identifier = /^[A-Za-z_$][\w$]*$/
const stableId = /^[A-Za-z0-9_-]{1,128}$/

function reject(message, code = 'UNSUPPORTED_BLOCK_SOURCE') {
  throw Object.assign(new Error(message), { code })
}

function normalizeField(field, names) {
  const keys = ['name', 'type', 'label', 'required', 'default', 'min', 'max', 'step', 'values']
  if (!field || typeof field !== 'object' || Array.isArray(field) || Object.keys(field).some((key) => !keys.includes(key)) ||
      typeof field.name !== 'string' || !identifier.test(field.name) || names.has(field.name) ||
      !['string', 'number', 'boolean', 'enum'].includes(field.type)) {
    reject('Invalid trusted block field descriptor.', 'INVALID_BLOCK_CONFIG')
  }
  names.add(field.name)
  if (field.label !== undefined && (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 80 || /[\u0000-\u001f\u007f]/.test(field.label))) {
    reject('Invalid trusted block field label.', 'INVALID_BLOCK_CONFIG')
  }
  if (field.required !== undefined && typeof field.required !== 'boolean') reject('Invalid required flag.', 'INVALID_BLOCK_CONFIG')
  const descriptor = { ...field, required: field.required === true }
  if (field.type === 'number') {
    if (Object.hasOwn(field, 'values') || ['min', 'max', 'step'].some((key) => Object.hasOwn(field, key) && (typeof field[key] !== 'number' || !Number.isFinite(field[key]))) ||
        field.min !== undefined && field.max !== undefined && field.min > field.max || field.step !== undefined && field.step <= 0) {
      reject('Invalid trusted numeric block field constraints.', 'INVALID_BLOCK_CONFIG')
    }
  } else if (field.type === 'enum') {
    if (!Array.isArray(field.values) || !field.values.length || field.values.length > 32 || field.values.some((value) => typeof value !== 'string' || !value || value.length > 128) ||
        new Set(field.values).size !== field.values.length || ['min', 'max', 'step'].some((key) => Object.hasOwn(field, key))) {
      reject('Invalid trusted block enum values.', 'INVALID_BLOCK_CONFIG')
    }
  } else if (['min', 'max', 'step', 'values'].some((key) => Object.hasOwn(field, key))) {
    reject('Constraints are unsupported for this block field type.', 'INVALID_BLOCK_CONFIG')
  }
  if (Object.hasOwn(field, 'default') && !validValue(descriptor, field.default)) reject('Block field default violates its trusted constraints.', 'INVALID_BLOCK_CONFIG')
  return Object.freeze(descriptor)
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

function normalizeBlockTypes(blockTypes) {
  if (!Array.isArray(blockTypes) || !blockTypes.length || blockTypes.length > 32) reject('Block types must be a bounded trusted list.', 'INVALID_BLOCK_CONFIG')
  const types = blockTypes.map((block) => {
    const keys = ['type', 'label', 'description', 'importSource', 'componentName', 'idProp', 'fields']
    if (!block || typeof block !== 'object' || Array.isArray(block) || Object.keys(block).some((key) => !keys.includes(key)) ||
        typeof block.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(block.type) ||
        typeof block.label !== 'string' || !block.label.trim() || block.label.length > 80 ||
        block.description !== undefined && (typeof block.description !== 'string' || block.description.length > 240) ||
        typeof block.importSource !== 'string' || !block.importSource || block.importSource.length > 512 || /[\u0000-\u001f\u007f]/.test(block.importSource) ||
        typeof block.componentName !== 'string' || !identifier.test(block.componentName) ||
        block.idProp !== undefined && (typeof block.idProp !== 'string' || !identifier.test(block.idProp)) ||
        !Array.isArray(block.fields) || block.fields.length > 32) {
      reject('Invalid trusted Astro block descriptor.', 'INVALID_BLOCK_CONFIG')
    }
    const fieldNames = new Set()
    const fields = block.fields.map((field) => normalizeField(field, fieldNames))
    const idProp = block.idProp || 'id'
    if (fieldNames.has(idProp)) reject('Block identity prop cannot also be an editable field.', 'INVALID_BLOCK_CONFIG')
    return Object.freeze({ ...block, idProp, fields, fieldsByName: new Map(fields.map((field) => [field.name, field])) })
  })
  if (new Set(types.map((block) => block.type)).size !== types.length ||
      new Set(types.map((block) => block.importSource)).size !== types.length ||
      new Set(types.map((block) => block.componentName)).size !== types.length) {
    reject('Block type, import source, and component names must be unique.', 'INVALID_BLOCK_CONFIG')
  }
  return types
}

function offset(source, position) {
  const value = position?.offset
  if (!Number.isInteger(value)) reject('Parser did not provide an exact MDX source position.')
  return value + (source.charCodeAt(0) === 0xfeff ? 1 : 0)
}

function parse(source) {
  if (typeof source !== 'string') reject('MDX source must be text.')
  try { return processor.parse(source) } catch { reject('The MDX source is unsupported.', 'UNSUPPORTED_SYNTAX') }
}

function staticValue(source, attribute, field) {
  const start = offset(source, attribute.position?.start), end = offset(source, attribute.position?.end)
  const raw = source.slice(start, end)
  const escapedName = String(attribute.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let value, literal, rangeStart, rangeEnd
  if (field.type === 'string' || field.type === 'enum') {
    const match = new RegExp(`^${escapedName}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")$`).exec(raw)
    if (match && typeof attribute.value === 'string') {
      // MDX has already decoded JSX character references in this static value.
      value = attribute.value
      literal = match[1]
      rangeStart = start + raw.lastIndexOf(literal)
      rangeEnd = rangeStart + literal.length
    } else {
      const expression = attribute.value?.data?.estree?.body
      const staticString = expression?.length === 1 && expression[0]?.type === 'ExpressionStatement'
        ? expression[0].expression
        : null
      const expressionMatch = new RegExp(`^${escapedName}\\s*=\\s*(\\{\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\s*\\})$`).exec(raw)
      if (!expressionMatch || staticString?.type !== 'Literal' || typeof staticString.value !== 'string') {
        reject(`Block prop ${attribute.name} must be a static string literal.`)
      }
      value = staticString.value
      literal = expressionMatch[1]
      rangeStart = start + raw.lastIndexOf(literal)
      rangeEnd = rangeStart + literal.length
    }
  } else {
    const match = new RegExp(`^${escapedName}\\s*=\\s*\\{(true|false|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\}$`).exec(raw)
    if (!match) reject(`Block prop ${attribute.name} must use a simple static scalar expression.`)
    literal = match[1]
    value = literal === 'true' ? true : literal === 'false' ? false : Number(literal)
    if (field.type === 'boolean' && typeof value !== 'boolean' || field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      reject(`Block prop ${attribute.name} has the wrong scalar type.`)
    }
    rangeStart = start + raw.indexOf('{')
    rangeEnd = start + raw.lastIndexOf('}') + 1
  }
  if (!validValue(field, value)) reject(`Block prop ${attribute.name} violates its trusted field constraints.`)
  return { value, range: { start: rangeStart, end: rangeEnd } }
}

function importedComponents(tree, types) {
  const imports = new Map()
  for (const node of tree.children || []) {
    if (node.type !== 'mdxjsEsm') continue
    for (const declaration of node.data?.estree?.body || []) {
      if (declaration.type !== 'ImportDeclaration') continue
      const type = types.find((item) => item.importSource === declaration.source.value)
      if (!type) continue
      if (declaration.importKind === 'type' || declaration.specifiers.length !== 1 || declaration.specifiers[0].type !== 'ImportDefaultSpecifier') {
        reject(`Block component ${type.type} must use one default-only static import.`)
      }
      const name = declaration.specifiers[0].local.name
      if (imports.has(type.type)) reject(`Block component ${type.type} has multiple imports.`)
      imports.set(type.type, name)
    }
  }
  return imports
}

function collectBlockNodes(tree, source, types, imports) {
  const byName = new Map([...imports].map(([type, name]) => [name, types.find((item) => item.type === type)]))
  const rootNodes = []
  const visit = (node, topLevel = false, parentBlock = null) => {
    if (!node || typeof node !== 'object') return
    let currentBlock = parentBlock
    if (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) && node.name && byName.has(node.name)) {
      const type = byName.get(node.name)
      if (!topLevel || node.type !== 'mdxJsxFlowElement' || parentBlock) reject(`This configured target contains a nested or inline ${type.label} call; the entire target is unsupported and remains read-only.`, 'UNSUPPORTED_BLOCK_PLACEMENT')
      currentBlock = type
      rootNodes.push({ node, type })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'position' || key === 'data') continue
      if (Array.isArray(value)) value.forEach((child) => visit(child, false, currentBlock))
      else if (value && typeof value === 'object') visit(value, false, currentBlock)
    }
  }
  for (const node of tree.children || []) visit(node, true)
  const ids = new Set()
  const records = rootNodes.map(({ node, type }) => {
    if (node.children?.length) reject(`Block ${type.type} has children/slots and remains read-only.`, 'UNSUPPORTED_BLOCK_SLOT')
    const attributes = node.attributes || []
    if (attributes.some((attribute) => attribute.type !== 'mdxJsxAttribute')) reject(`Block ${type.type} spread attributes remain read-only.`)
    const names = new Set()
    for (const attribute of attributes) {
      if (names.has(attribute.name)) reject(`Duplicate block attribute ${attribute.name} is ambiguous.`)
      names.add(attribute.name)
    }
    const idAttributes = attributes.filter((attribute) => attribute.name === type.idProp)
    if (idAttributes.length !== 1 || typeof idAttributes[0].value !== 'string' || !stableId.test(idAttributes[0].value)) {
      reject(`Block ${type.type} must have one stable static ${type.idProp} identity.`)
    }
    const id = idAttributes[0].value
    if (ids.has(id)) reject('Duplicate block identities are ambiguous.')
    ids.add(id)
    const props = {}
    const propRanges = new Map()
    for (const field of type.fields) {
      const matches = attributes.filter((attribute) => attribute.name === field.name)
      if (matches.length > 1) reject(`Duplicate block prop ${field.name} is ambiguous.`)
      if (!matches.length) {
        if (Object.hasOwn(field, 'default')) props[field.name] = field.default
        else if (field.required) reject(`Required block prop ${field.name} is missing.`)
        continue
      }
      const parsed = staticValue(source, matches[0], field)
      props[field.name] = parsed.value
      propRanges.set(field.name, parsed.range)
    }
    return {
      id,
      type: type.type,
      label: type.label,
      props,
      start: offset(source, node.position?.start),
      end: offset(source, node.position?.end),
      propRanges,
      typeConfig: type,
      componentName: node.name,
    }
  })
  return records
}

function encodeValue(field, value) {
  if (!validValue(field, value)) reject(`Value violates the trusted block field ${field.name}.`, 'UNSUPPORTED_VALUE')
  if (field.type === 'string' || field.type === 'enum') {
    // Simple strings stay readable as JSX attributes. Special characters use a
    // static JS string expression, which MDX parses without JSX quote ambiguity.
    return /["\\&<\r\n]/.test(value) ? `{${JSON.stringify(value)}}` : JSON.stringify(value)
  }
  return `{${String(value)}}`
}

function sourceHash(source) {
  return hashSource(source)
}

function frontmatterEnd(source) {
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const match = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)
  return match ? match[0].length : bom
}

function insertionPoint(source, tree, records) {
  const lastBlock = records.at(-1)
  if (lastBlock) return lastBlock.end
  const moduleNodes = (tree.children || []).filter((node) => node.type === 'mdxjsEsm')
  if (moduleNodes.length) return offset(source, moduleNodes.at(-1).position?.end)
  return frontmatterEnd(source)
}

function applyDiff(source, start, end, after) {
  const before = source.slice(start, end)
  const next = source.slice(0, start) + after + source.slice(end)
  return { source: next, diff: { start, end, before, after } }
}

function blockMarkup(type, id, values) {
  const attributes = [`${type.idProp}=${JSON.stringify(id)}`]
  for (const field of type.fields) {
    if (Object.hasOwn(values, field.name)) attributes.push(`${field.name}=${encodeValue(field, values[field.name])}`)
  }
  return `<${type.componentName} ${attributes.join(' ')} />`
}

export function createMdxBlocksAdapter({ blockTypes }) {
  const types = normalizeBlockTypes(blockTypes)
  const byType = new Map(types.map((type) => [type.type, type]))

  function inspect(source) {
    const tree = parse(source)
    const imports = importedComponents(tree, types)
    const records = collectBlockNodes(tree, source, types, imports)
    return {
      hash: sourceHash(source),
      types: types.map(({ fieldsByName, ...type }) => ({
        type: type.type,
        label: type.label,
        ...(type.description ? { description: type.description } : {}),
        fields: type.fields,
      })),
      blocks: records.map(({ id, type, label, props }) => ({ id, type, label, props })),
    }
  }

  function patch(source, operation, expectedHash, generatedId) {
    if (sourceHash(source) !== expectedHash) reject('MDX source changed since the block draft was loaded.', 'STALE_HASH')
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) reject('Invalid block operation.', 'INVALID_OPERATION')
    const tree = parse(source)
    const imports = importedComponents(tree, types)
    const records = collectBlockNodes(tree, source, types, imports)
    let applied

    if (operation.action === 'add') {
      if (Object.keys(operation).some((key) => !['action', 'blockType', 'values'].includes(key)) ||
          typeof operation.blockType !== 'string' || !operation.values || typeof operation.values !== 'object' || Array.isArray(operation.values)) reject('Invalid block-add operation.', 'INVALID_OPERATION')
      const type = byType.get(operation.blockType)
      if (!type) reject('Unknown trusted block type.', 'UNKNOWN_BLOCK_TYPE')
      const values = {}
      for (const field of type.fields) {
        if (Object.hasOwn(operation.values, field.name)) values[field.name] = operation.values[field.name]
        else if (Object.hasOwn(field, 'default')) values[field.name] = field.default
        else if (field.required) reject(`Required block prop ${field.name} is missing.`, 'MISSING_REQUIRED_FIELD')
      }
      if (Object.keys(operation.values).some((key) => !type.fieldsByName.has(key))) reject('Block-add operation contains an unknown prop.', 'UNKNOWN_BLOCK_PROP')
      if (typeof generatedId !== 'string' || !stableId.test(generatedId) || records.some((record) => record.id === generatedId)) reject('Server-generated block identity is invalid or duplicated.', 'INVALID_BLOCK_ID')
      const binding = imports.get(type.type)
      if (binding && binding !== type.componentName) reject('The trusted component is imported under an unsupported alias.', 'UNSUPPORTED_COMPONENT_ALIAS')
      if (!binding) {
        for (const node of tree.children || []) if (node.type === 'mdxjsEsm') {
          for (const declaration of node.data?.estree?.body || []) {
            if (declaration.type === 'ImportDeclaration' && declaration.specifiers?.some((specifier) => specifier.local?.name === type.componentName)) {
              reject('The trusted component local name is already bound to another import.', 'IMPORT_BINDING_COLLISION')
            }
          }
        }
      }
      const markup = blockMarkup(type, generatedId, values)
      const point = insertionPoint(source, tree, records)
      const newline = source.includes('\r\n') ? '\r\n' : '\n'
      const importLine = binding ? '' : `import ${type.componentName} from ${JSON.stringify(type.importSource)}${newline}${newline}`
      const before = source.slice(0, point)
      const after = source.slice(point)
      const prefix = point > 0 && !before.endsWith(newline)
        ? newline + newline
        : point > 0 && point === frontmatterEnd(source)
          ? newline
          : ''
      const suffix = !after
        ? newline
        : after.startsWith(newline + newline)
          ? ''
          : after.startsWith(newline)
            ? newline
            : newline + newline
      applied = applyDiff(source, point, point, `${prefix}${importLine}${markup}${suffix}`)
    } else if (operation.action === 'set') {
      if (Object.keys(operation).some((key) => !['action', 'blockId', 'prop', 'value'].includes(key)) ||
          typeof operation.blockId !== 'string' || typeof operation.prop !== 'string') reject('Invalid block-edit operation.', 'INVALID_OPERATION')
      const block = records.find((record) => record.id === operation.blockId)
      const field = block?.typeConfig.fieldsByName.get(operation.prop)
      const range = block?.propRanges.get(operation.prop)
      if (!block || !field) reject('Block or editable literal prop is unsupported.', 'UNSUPPORTED_BLOCK_PROP')
      if (!validValue(field, operation.value)) reject('Value violates the trusted block field.', 'UNSUPPORTED_VALUE')
      const after = encodeValue(field, operation.value)
      if (range) {
        applied = applyDiff(source, range.start, range.end, after)
      } else {
        const slash = source.lastIndexOf('/>', block.end)
        if (slash < block.start) reject('Block opening tag has no exact self-closing range.')
        let insertion = slash
        while (insertion > block.start && /\s/.test(source[insertion - 1])) insertion -= 1
        const spacing = source.slice(insertion, slash) || ' '
        applied = applyDiff(source, insertion, slash, ` ${field.name}=${after}${spacing}`)
      }
    } else if (operation.action === 'remove') {
      if (Object.keys(operation).some((key) => !['action', 'blockId'].includes(key)) || typeof operation.blockId !== 'string') reject('Invalid block-remove operation.', 'INVALID_OPERATION')
      const block = records.find((record) => record.id === operation.blockId)
      if (!block) reject('Block identity is absent or unsupported.', 'UNKNOWN_BLOCK_ID')
      applied = applyDiff(source, block.start, block.end, '')
    } else if (operation.action === 'move') {
      if (Object.keys(operation).some((key) => !['action', 'blockId', 'delta'].includes(key)) ||
          typeof operation.blockId !== 'string' || ![-1, 1].includes(operation.delta)) reject('Invalid block-move operation.', 'INVALID_OPERATION')
      const index = records.findIndex((record) => record.id === operation.blockId)
      const nextIndex = index + operation.delta
      if (index < 0 || nextIndex < 0 || nextIndex >= records.length) reject('Block cannot move beyond the supported block list.', 'BLOCK_MOVE_BOUNDARY')
      const [first, second] = operation.delta < 0 ? [records[nextIndex], records[index]] : [records[index], records[nextIndex]]
      const gap = source.slice(first.end, second.start)
      if (!/^\s*$/.test(gap)) reject('Blocks separated by other Markdown content cannot be reordered.', 'UNSUPPORTED_BLOCK_ORDER')
      const before = source.slice(first.start, second.end)
      const firstSource = source.slice(first.start, first.end)
      const secondSource = source.slice(second.start, second.end)
      applied = applyDiff(source, first.start, second.end, `${secondSource}${gap}${firstSource}`)
      if (before === applied.diff.after) applied.diff = null
    } else {
      reject('Unsupported block operation.', 'INVALID_OPERATION')
    }

    const nextState = inspect(applied.source)
    return {
      source: applied.source,
      hash: sourceHash(source),
      nextHash: nextState.hash,
      blocks: nextState.blocks,
      types: nextState.types,
      diff: applied.diff,
    }
  }

  return Object.freeze({ inspect, patch })
}
