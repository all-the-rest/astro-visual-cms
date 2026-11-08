import { parse } from '@babel/parser'
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'

function unsupported(reason) {
  return { supported: false, mode: 'read-only', reason }
}

function staticString(node) {
  return node?.type === 'StringLiteral' ? node.value : undefined
}

function property(object, name) {
  return object?.type === 'ObjectExpression'
    ? object.properties.find((item) => item.type === 'ObjectProperty' && !item.computed &&
      (item.key.name ?? item.key.value) === name)
    : undefined
}

function hasDuplicateKeys(object) {
  if (object?.type !== 'ObjectExpression') return false
  const keys = object.properties.map((item) => item.type === 'ObjectProperty' && !item.computed
    ? String(item.key.name ?? item.key.value)
    : null)
  return keys.some((key, index) => key === null || keys.indexOf(key) !== index)
}

function objectKeyName(propertyNode) {
  const key = propertyNode?.key
  const value = key?.name ?? key?.value
  return value === undefined ? undefined : String(value)
}

function literalValue(node) {
  if (node?.type === 'StringLiteral' || node?.type === 'NumericLiteral' || node?.type === 'BooleanLiteral') return node.value
  if (node?.type === 'NullLiteral') return null
  if (node?.type === 'UnaryExpression' && ['-', '+'].includes(node.operator) && node.argument?.type === 'NumericLiteral') {
    const value = node.operator === '-' ? -node.argument.value : node.argument.value
    return Number.isFinite(value) ? value : undefined
  }
  if (node?.type === 'ArrayExpression' && node.elements.every((item) => item && literalValue(item) !== undefined)) {
    return node.elements.map(literalValue)
  }
  return undefined
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.startsWith('\\') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') &&
    !value.split('/').some((segment) => segment === '..')
}

function readSchema(node, zBindings) {
  let optional = false
  let defaultValue
  let hasDefault = false
  let sawDefault = false
  let outerOptional = false
  while (node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed &&
      node.callee.object.type === 'CallExpression') {
    const method = node.callee.property.name
    if (method === 'optional' && node.arguments.length === 0) {
      if (!sawDefault) outerOptional = true
      optional = true
    }
    else if (method === 'default' && node.arguments.length === 1) {
      const literal = literalValue(node.arguments[0])
      if (literal === undefined) return { error: 'Non-literal Zod default.' }
      // The outermost .default() runs first and is the effective input fallback.
      if (!sawDefault) {
        defaultValue = literal
        hasDefault = !outerOptional
      }
      sawDefault = true
      optional = true
    } else return { error: `Unsupported Zod method .${method}().` }
    node = node.callee.object
  }

  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed ||
      node.callee.object.type !== 'Identifier' || !zBindings.has(node.callee.object.name)) {
    return { error: 'Schema is not a direct, statically understood Zod expression.' }
  }
  const kind = node.callee.property.name
  const args = node.arguments
  let fieldType
  let values
  if (['string', 'number', 'boolean', 'date'].includes(kind) && args.length === 0) fieldType = kind
  else if (kind === 'enum' && args.length === 1 && args[0].type === 'ArrayExpression' &&
      args[0].elements.length > 0 && args[0].elements.every((item) => staticString(item) !== undefined)) {
    fieldType = 'enum'
    values = args[0].elements.map((item) => item.value)
  } else if (kind === 'array' && args.length === 1) {
    const item = readSchema(args[0], zBindings)
    if (!item.error && !item.optional && item.type !== 'enum' && !item.type.startsWith('array<')) fieldType = `array<${item.type}>`
    else return { error: item.error || 'Unsupported array item schema.' }
  } else return { error: `Unsupported Zod constructor z.${kind}().` }

  if (hasDefault) {
    const compatible = (fieldType === 'string' && typeof defaultValue === 'string') ||
      (fieldType === 'number' && typeof defaultValue === 'number' && Number.isFinite(defaultValue)) ||
      (fieldType === 'boolean' && typeof defaultValue === 'boolean') ||
      (fieldType === 'enum' && typeof defaultValue === 'string' && values.includes(defaultValue))
    if (!compatible) return { error: 'Zod default is not a compatible literal for this field type.' }
  }

  return { type: fieldType, ...(values ? { values } : {}), optional, ...(hasDefault ? { default: defaultValue } : {}) }
}

function readGlob(loader, globBindings) {
  if (loader?.type !== 'CallExpression' || loader.arguments.length !== 1 || loader.callee.type !== 'Identifier' || !globBindings.has(loader.callee.name)) {
    return unsupported('Loader is not a statically imported Astro glob() loader.')
  }
  const options = loader.arguments[0]
  if (!options || options.type !== 'ObjectExpression' || hasDuplicateKeys(options)) {
    return unsupported('glob() options must be a literal object without spreads or computed properties.')
  }
  if (options.properties.some((item) => !['base', 'pattern'].includes(item.key.name ?? item.key.value))) {
    return unsupported('Only glob() base and pattern options are supported.')
  }
  const base = staticString(property(options, 'base')?.value)
  const patternsNode = property(options, 'pattern')?.value
  const patterns = patternsNode?.type === 'ArrayExpression'
    ? patternsNode.elements.map(staticString)
    : [staticString(patternsNode)]
  if (!safeRelativePath(base) || !patterns.length || patterns.some((item) => !safeRelativePath(item))) {
    return unsupported('glob() requires a literal relative pattern and a literal base directory.')
  }
  return { supported: true, loader: 'glob', base, patterns }
}

/** Analyze, but never evaluate, the deliberately small Astro content-config subset. */
export function discoverContentCollections(source) {
  let ast
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  } catch {
    return { supported: false, collections: [], reason: 'Content config has invalid or unsupported syntax.' }
  }
  const imports = new Map()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    for (const specifier of statement.specifiers) {
      if (specifier.importKind === 'type') continue
      imports.set(specifier.local.name, { imported: specifier.imported?.name ?? 'default', from: statement.source.value })
    }
  }
  const defineBindings = new Set([...imports].filter(([, item]) => item.imported === 'defineCollection' && item.from === 'astro:content').map(([name]) => name))
  const globBindings = new Set([...imports].filter(([, item]) => item.imported === 'glob' && ['astro/loaders', 'astro:content'].includes(item.from)).map(([name]) => name))
  const zBindings = new Set([...imports].filter(([, item]) => item.imported === 'z' && item.from === 'astro:content').map(([name]) => name))
  const declaration = ast.program.body.find((item) => item.type === 'ExportNamedDeclaration' &&
    item.declaration?.type === 'VariableDeclaration' && item.declaration.declarations.some((decl) => decl.id.name === 'collections'))
  const collectionsDeclaration = declaration?.declaration.declarations.find((decl) => decl.id.name === 'collections')
  let otherBindingReference = false
  const findOtherReferences = (node) => {
    if (!node || typeof node !== 'object' || otherBindingReference) return
    if (node.type === 'Identifier' && node.name === 'collections' && node !== collectionsDeclaration?.id) {
      otherBindingReference = true
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(findOtherReferences)
      else if (value && typeof value === 'object') findOtherReferences(value)
    }
  }
  findOtherReferences(ast.program)
  const collectionsNode = collectionsDeclaration?.init
  if (declaration?.declaration.kind !== 'const' || declaration.declaration.declarations.length !== 1 || otherBindingReference ||
      collectionsNode?.type !== 'ObjectExpression' || hasDuplicateKeys(collectionsNode) ||
      collectionsNode.properties.some((item) => objectKeyName(item) === '__proto__')) {
    return { supported: false, collections: [], reason: 'Expected one exported literal collections object; dynamic configuration is read-only.' }
  }

  const collections = collectionsNode.properties.map((entry) => {
    const name = objectKeyName(entry)
    const call = entry.value
    if (call?.type !== 'CallExpression' || call.arguments.length !== 1 || call.callee.type !== 'Identifier' || !defineBindings.has(call.callee.name)) {
      return { name, ...unsupported('Collection is not a direct defineCollection() call.') }
    }
    const config = call.arguments[0]
    if (config?.type !== 'ObjectExpression' || hasDuplicateKeys(config)) {
      return { name, ...unsupported('Collection options must be a literal object.') }
    }
    if (config.properties.some((item) => !['loader', 'schema'].includes(objectKeyName(item)))) {
      return { name, ...unsupported('Only loader and schema collection options are supported.') }
    }
    const loaderProp = property(config, 'loader')
    const loader = loaderProp ? readGlob(loaderProp.value, globBindings) :
      unsupported('Only static glob() content collections are supported; legacy and file() loaders are read-only.')
    if (!loader.supported) return { name, ...loader }
    const schema = property(config, 'schema')?.value
    if (!schema) return { name, ...loader, supported: true, mode: 'read-only', fields: [], reason: 'Collection has no statically declared schema.' }
    if (schema.type !== 'CallExpression' || schema.callee.type !== 'MemberExpression' || schema.callee.object.type !== 'Identifier' ||
        !zBindings.has(schema.callee.object.name) || schema.callee.property.name !== 'object' || schema.arguments.length !== 1 ||
        schema.arguments[0]?.type !== 'ObjectExpression' || hasDuplicateKeys(schema.arguments[0])) {
      return { name, ...loader, ...unsupported('Schema must be a direct z.object({...}); imported/shared schemas are read-only.') }
    }
    const fields = []
    for (const field of schema.arguments[0].properties) {
      if (field.type !== 'ObjectProperty' || field.computed) return { name, ...loader, ...unsupported('Schema spreads and computed field names are read-only.') }
      const fieldName = objectKeyName(field)
      if (fieldName === '__proto__') return { name, ...loader, ...unsupported('The __proto__ schema key is not supported.') }
      const result = readSchema(field.value, zBindings)
      if (result.error) return { name, ...loader, ...unsupported(`Field ${fieldName}: ${result.error}`) }
      fields.push({ name: fieldName, ...result, required: !result.optional })
    }
    return { name, ...loader, supported: true, mode: 'static-fields-read-only', fields }
  })
  return { supported: true, collections }
}

function frontmatterFail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function checkYamlNode(node) {
  if (!node) return
  if ((typeof node.anchor === 'string' && node.anchor) || (typeof node.tag === 'string' && node.tag) ||
      node.constructor?.name === 'Alias') {
    frontmatterFail('UNSUPPORTED_FRONTMATTER', 'YAML anchors, aliases, and tags are unsupported.')
  }
  if (Array.isArray(node.items)) for (const item of node.items) {
    if (item?.constructor?.name === 'Pair') {
      checkYamlNode(item.key)
      checkYamlNode(item.value)
    } else checkYamlNode(item)
  }
}

function scalarMatchesField(value, field) {
  if (field.type === 'enum') return typeof value === 'string' && field.values.includes(value)
  if (field.type === 'string') return typeof value === 'string'
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (field.type === 'boolean') return typeof value === 'boolean'
  return false
}

function planFail(message) {
  const error = new Error(message)
  error.code = 'UNSUPPORTED_COLLECTION_EDIT'
  throw error
}

function sourceHash(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function fieldExpression(field, zName) {
  if (!field || typeof field.name !== 'string' || field.name === '__proto__' ||
      !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(field.name)) {
    planFail('Field name must be a simple static identifier.')
  }
  const primitives = new Set(['string', 'number', 'boolean', 'date'])
  let expression
  if (primitives.has(field.type)) expression = `${zName}.${field.type}()`
  else if (field.type === 'enum' && Array.isArray(field.values) && field.values.length > 0 &&
      field.values.every((value) => typeof value === 'string')) {
    expression = `${zName}.enum(${JSON.stringify(field.values)})`
  } else if (typeof field.type === 'string' && field.type.startsWith('array<') && field.type.endsWith('>') &&
      primitives.has(field.type.slice(6, -1))) {
    expression = `${zName}.array(${zName}.${field.type.slice(6, -1)}())`
  } else planFail('Only the documented primitive, enum, and primitive-array fields can be planned.')
  if (field.optional) expression += '.optional()'
  if (Object.hasOwn(field, 'default')) {
    const defaultType = typeof field.default
    if (!['string', 'number', 'boolean'].includes(defaultType) ||
        (field.type === 'string' && defaultType !== 'string') ||
        (field.type === 'number' && (defaultType !== 'number' || !Number.isFinite(field.default))) ||
        (field.type === 'boolean' && defaultType !== 'boolean') ||
        (field.type === 'enum' && (!field.values.includes(field.default) || defaultType !== 'string')) ||
        !['string', 'number', 'boolean', 'enum'].includes(field.type)) {
      planFail('Default must be a compatible JSON scalar literal.')
    }
    expression += `.default(${JSON.stringify(field.default)})`
  }
  return `${JSON.stringify(field.name)}: ${expression}`
}

function planningContext(source, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || sourceHash(source) !== expectedHash) {
    planFail('Source hash is invalid or stale.')
  }
  const discovered = discoverContentCollections(source)
  if (!discovered.supported || discovered.collections.some((collection) => !collection.supported && collection.mode !== 'read-only')) {
    planFail('Content config is not a supported static collections object.')
  }
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const declaration = ast.program.body.find((item) => item.type === 'ExportNamedDeclaration' &&
    item.declaration?.type === 'VariableDeclaration' && item.declaration.declarations.some((decl) => decl.id.name === 'collections'))
  const collectionsNode = declaration?.declaration.declarations.find((decl) => decl.id.name === 'collections')?.init
  const imported = new Map()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    for (const specifier of statement.specifiers) {
      if (specifier.importKind === 'type') continue
      imported.set(`${statement.source.value}:${specifier.imported?.name ?? 'default'}`, specifier.local.name)
    }
  }
  return { discovered, collectionsNode, imported }
}

function insertAtObjectEnd(source, object, insertion) {
  const close = object.end - 1
  const lastProperty = object.properties.at(-1)
  if (lastProperty) {
    const tailStart = lastProperty.end
    const tail = source.slice(tailStart, close)
    const lineComment = /^([ \t]*)(,?)([ \t]*)(\/\/[^\r\n]*)((?:\r?\n[ \t]*)+)$/.exec(tail)
    if (lineComment) {
      const [, leading, comma, commentSpacing, comment, whitespace] = lineComment
      const finalLineBreak = whitespace.lastIndexOf('\n')
      const blankLines = whitespace.slice(0, finalLineBreak + 1)
      const indentation = whitespace.slice(finalLineBreak + 1)
      const newline = whitespace.match(/\r?\n/)?.[0] ?? '\n'
      const inserted = `${comma || ','}${leading}${commentSpacing}${comment}${blankLines}${indentation}${insertion}${newline}${indentation}`
      return { position: tailStart, end: close, after: inserted }
    }
  }
  const beforeClose = source.slice(object.start + 1, close)
  const trimmed = beforeClose.trimEnd()
  const position = object.start + 1 + trimmed.length
  const separator = trimmed.length === 0 ? '\n  ' : trimmed.endsWith(',') ? '\n  ' : ',\n  '
  const after = `${separator}${insertion}\n`
  return { position, end: position, after }
}

function finishPlan(source, position, end, inserted, expectedHash) {
  const updated = source.slice(0, position) + inserted + source.slice(end)
  return {
    source: updated,
    hash: sourceHash(updated),
    diff: { start: position, end, before: source.slice(position, end), after: inserted },
    expectedHash,
  }
}

/** Return a diff-only plan for adding one safe schema field; never writes a file. */
export function planCollectionFieldExtension(source, { collection, field, expectedHash }) {
  const context = planningContext(source, expectedHash)
  const discovered = context.discovered.collections.find((item) => item.name === collection)
  if (!discovered?.supported || discovered.fields.some((item) => item.name === field?.name)) {
    planFail('Target collection must be supported and the field must not already exist.')
  }
  const defineName = context.imported.get('astro:content:defineCollection')
  const zName = context.imported.get('astro:content:z')
  if (!defineName || !zName) planFail('Required Astro and Zod imports must be explicit imports.')
  const declaration = context.collectionsNode.properties.find((item) => objectKeyName(item) === collection)
  const config = declaration?.value.arguments[0]
  const schema = property(config, 'schema')?.value
  const schemaObject = schema?.arguments[0]
  if (schemaObject?.type !== 'ObjectExpression') planFail('Target schema is not a supported literal object.')
  const { position, end, after } = insertAtObjectEnd(source, schemaObject, fieldExpression(field, zName))
  const plan = finishPlan(source, position, end, after, expectedHash)
  const updated = discoverContentCollections(plan.source).collections.find((item) => item.name === collection)
  if (!updated?.supported || !updated.fields.some((item) => item.name === field.name)) planFail('Generated schema did not validate.')
  return plan
}

/** Return a diff-only plan for a new static glob collection; never writes a file. */
export function planCollectionCreation(source, { name, base, pattern, fields, expectedHash }) {
  const context = planningContext(source, expectedHash)
  if (typeof name !== 'string' || name === '__proto__' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(name) ||
      context.discovered.collections.some((item) => item.name === name)) planFail('Collection name must be unique and static.')
  if (!safeRelativePath(base) || !safeRelativePath(pattern)) {
    planFail('Collection base and glob pattern must be safe relative paths.')
  }
  if (!Array.isArray(fields) || fields.length === 0 || new Set(fields.map((field) => field.name)).size !== fields.length) {
    planFail('A new collection requires unique static fields.')
  }
  const defineName = context.imported.get('astro:content:defineCollection')
  const globName = context.imported.get('astro/loaders:glob') ?? context.imported.get('astro:content:glob')
  const zName = context.imported.get('astro:content:z')
  if (!defineName || !globName || !zName) planFail('Required defineCollection, glob, and z imports must already exist.')
  const renderedFields = fields.map((field) => `    ${fieldExpression(field, zName)}`).join(',\n')
  const snippet = `${JSON.stringify(name)}: ${defineName}({ loader: ${globName}({ base: ${JSON.stringify(base)}, pattern: ${JSON.stringify(pattern)} }), schema: ${zName}.object({\n${renderedFields},\n  }) })`
  const { position, end, after } = insertAtObjectEnd(source, context.collectionsNode, snippet)
  const plan = finishPlan(source, position, end, after, expectedHash)
  const created = discoverContentCollections(plan.source).collections.find((item) => item.name === name)
  if (!created?.supported) planFail('Generated collection did not validate as a supported static collection.')
  return plan
}

/** Patch one existing top-level scalar in YAML frontmatter; never serializes the document. */
export function patchFrontmatterField(source, field, value, expectedHash) {
  if (typeof source !== 'string' || !field || typeof field.name !== 'string' ||
      typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) ||
      createHash('sha256').update(source, 'utf8').digest('hex') !== expectedHash) {
    frontmatterFail('STALE_HASH', 'The entry source or expected hash is invalid or stale.')
  }
  if (field.type === 'date' || (typeof field.type === 'string' && field.type.startsWith('array<'))) {
    frontmatterFail('UNSUPPORTED_FIELD_TYPE', `Frontmatter editing for ${field.type} fields is unsupported.`)
  }
  if (!scalarMatchesField(value, field)) {
    frontmatterFail('INVALID_FIELD_VALUE', `Value does not match supported field ${field.name}.`)
  }
  const opening = /^(\uFEFF?---\r?\n)/.exec(source)
  const closing = /\r?\n---(?=\r?\n|$)/g
  if (!opening) frontmatterFail('UNSUPPORTED_FRONTMATTER', 'Expected a leading YAML frontmatter block.')
  closing.lastIndex = opening[0].length
  const end = closing.exec(source)
  if (!end) frontmatterFail('UNSUPPORTED_FRONTMATTER', 'Could not find the closing frontmatter delimiter.')
  const bodyStart = opening[0].length
  const bodyEnd = end.index
  const body = source.slice(bodyStart, bodyEnd)
  const document = parseDocument(body, { uniqueKeys: true, keepSourceTokens: true })
  if (document.errors.length || !document.contents || document.contents.constructor?.name !== 'YAMLMap') {
    frontmatterFail('UNSUPPORTED_FRONTMATTER', 'Frontmatter must be a valid top-level YAML mapping without duplicate keys.')
  }
  checkYamlNode(document.contents)
  const pairs = document.contents.items.filter((pair) => pair.key?.value === field.name)
  if (pairs.length !== 1) frontmatterFail('UNSUPPORTED_FRONTMATTER', `Field ${field.name} must already exist exactly once.`)
  const node = pairs[0].value
  if (!node || !Array.isArray(node.range) || !['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE'].includes(node.type) ||
      node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED' || typeof node.value === 'object') {
    frontmatterFail('UNSUPPORTED_FRONTMATTER', `Field ${field.name} is not a supported scalar value.`)
  }
  if (node.value === value) {
    return { source, hash: expectedHash, diff: null }
  }
  const start = bodyStart + node.range[0]
  const finish = bodyStart + node.range[1]
  const replacement = JSON.stringify(value)
  const updated = source.slice(0, start) + replacement + source.slice(finish)
  const updatedEnd = end.index + replacement.length - (finish - start)
  const updatedBody = updated.slice(bodyStart, updatedEnd)
  const validated = parseDocument(updatedBody, { uniqueKeys: true })
  if (validated.errors.length) frontmatterFail('INVALID_FIELD_VALUE', 'Updated frontmatter did not validate as YAML.')
  const updatedPairs = validated.contents.items.filter((pair) => pair.key?.value === field.name)
  if (updatedPairs.length !== 1 || updatedPairs[0].value.value !== value) {
    frontmatterFail('INVALID_FIELD_VALUE', 'Updated field did not round-trip through the YAML parser.')
  }
  return {
    source: updated,
    hash: createHash('sha256').update(updated, 'utf8').digest('hex'),
    diff: { start, end: finish, before: source.slice(start, finish), after: replacement },
  }
}
