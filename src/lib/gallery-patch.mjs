import { createHash } from 'node:crypto'
import { parse } from '@babel/parser'
import { createProcessor } from '@mdx-js/mdx'

// Keep the legacy export path while the parser itself remains slug-agnostic.
export { FIXTURE_IMAGE_SLUGS } from './demo-image-manifest.mjs'

const DEFAULT_GALLERY_IMPORT_SOURCE = '../components/Gallery.astro'
const mdxProcessor = createProcessor({ format: 'mdx' })

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function parseJavaScript(source, label, plugins) {
  try {
    const ast = parse(source, { sourceType: 'module', ...(plugins ? { plugins } : {}) })
    if (ast.comments.length > 0) {
      fail('UNSUPPORTED_COMMENT', `Comments are unsupported in the ${label}.`)
    }
    return ast
  } catch (error) {
    if (error.code) throw error
    fail('UNSUPPORTED_SYNTAX', `Could not parse the ${label} as static JavaScript.`)
  }
}

function parseMdx(source) {
  try {
    return mdxProcessor.parse(source)
  } catch {
    fail('UNSUPPORTED_SYNTAX', 'The fixture is not valid MDX syntax.')
  }
}

function configuredGalleryImportSource(options) {
  if (options === undefined) return DEFAULT_GALLERY_IMPORT_SOURCE
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'galleryImportSource')) {
    fail('INVALID_IMPORT_IDENTITY', 'Parser options may contain only a server-configured galleryImportSource.')
  }

  const source = options.galleryImportSource ?? DEFAULT_GALLERY_IMPORT_SOURCE
  if (typeof source !== 'string' || !/^(?:\.\/|\.\.\/)+(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(source)) {
    fail('INVALID_IMPORT_IDENTITY', 'galleryImportSource must be a relative module specifier, not a filesystem or client path.')
  }
  return source
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'position' || key === 'data') continue
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit)
    } else if (value && typeof value === 'object') {
      walk(value, visit)
    }
  }
}

function expressionAst(expression, label) {
  return parseJavaScript(`const __fixtureValue = (${expression});`, label, ['jsx'])
}

function expressionIdentifier(expression, expected, label) {
  const ast = expressionAst(expression, label)
  const initializer = ast.program.body[0]?.declarations?.[0]?.init
  if (initializer?.type !== 'Identifier' || initializer.name !== expected) {
    fail('UNSUPPORTED_DYNAMIC_VALUE', `${label} must be the literal identifier ${expected}.`)
  }
}

function identifierCount(root, name, ignoredNode) {
  let count = 0
  walk(root, (node) => {
    if (node.type === 'Identifier' && node.name === name && node !== ignoredNode) count += 1
  })
  return count
}

function jsxNameReferencesBinding(jsxName, bindingName) {
  return jsxName === bindingName || jsxName.startsWith(`${bindingName}.`)
}

function rejectDirectEval(root) {
  let found = false
  walk(root, (node) => {
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'eval') {
      found = true
    }
  })
  if (found) {
    fail('UNSUPPORTED_DYNAMIC_VALUE', 'Direct eval is unsupported while checking Gallery array references.')
  }
}

function sourceRange(source, esmNode, initializer) {
  const blockStart = esmNode.position?.start?.offset
  const blockEnd = esmNode.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) {
    fail('UNSUPPORTED_TARGET', 'The MDX parser did not provide source offsets for a gallery array.')
  }

  const block = source.slice(blockStart, blockEnd)
  const valueOffset = block.indexOf(esmNode.value)
  if (valueOffset < 0 || block.indexOf(esmNode.value, valueOffset + 1) >= 0) {
    fail('UNSUPPORTED_TARGET', 'Could not unambiguously map the export AST back to source bytes.')
  }

  const range = {
    start: blockStart + valueOffset + initializer.start,
    end: blockStart + valueOffset + initializer.end,
  }
  const raw = source.slice(range.start, range.end)
  const mapped = parseJavaScript(`const __fixtureArray = ${raw};`, 'mapped gallery array')
    .program.body[0]?.declarations?.[0]?.init
  if (mapped?.type !== 'ArrayExpression') {
    fail('UNSUPPORTED_TARGET', 'Could not map the gallery array AST back to the exact source range.')
  }
  return range
}

function findGalleryArrays(source, mdast, galleryImportSource) {
  const esmNodes = []
  const galleryNodes = []
  const jsxNameReferences = []
  const expressionNodes = []

  walk(mdast, (node) => {
    if (node.type === 'mdxjsEsm') esmNodes.push(node)
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name) {
      galleryNodes.push(node)
      jsxNameReferences.push(node.name)
      for (const attribute of node.attributes || []) {
        if (attribute.type === 'mdxJsxAttribute' && attribute.value?.type === 'mdxJsxAttributeValueExpression') {
          expressionNodes.push(attribute.value.value)
        } else if (attribute.type === 'mdxJsxExpressionAttribute' && typeof attribute.value === 'string') {
          expressionNodes.push(attribute.value.replace(/^\.\.\./, '').trim())
        }
      }
    }
    if ((node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') && typeof node.value === 'string') {
      expressionNodes.push(node.value)
    }
    if (node.type === 'html' && typeof node.value === 'string' && node.value.includes('<!--')) {
      fail('UNSUPPORTED_COMMENT', 'Comments in the MDX fixture are unsupported by this patcher.')
    }
  })

  const programs = esmNodes.map((esmNode) => {
    const ast = parseJavaScript(esmNode.value, 'MDX ESM block')
    rejectDirectEval(ast)
    return { esmNode, ast }
  })
  const galleryImports = []
  const exportedBindings = new Map()

  for (const { esmNode, ast } of programs) {
    for (const statement of ast.program.body) {
      if (statement.type === 'ImportDeclaration' && statement.source.value === galleryImportSource) {
        const defaultImport = statement.specifiers.filter((specifier) => specifier.type === 'ImportDefaultSpecifier')
        if (defaultImport.length !== 1) {
          fail('UNSUPPORTED_TARGET', `The Gallery component must be the default import from ${galleryImportSource}.`)
        }
        galleryImports.push(defaultImport[0].local.name)
      }

      if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration') {
        for (const declaration of statement.declaration.declarations) {
          if (declaration.id.type !== 'Identifier') continue
          const entries = exportedBindings.get(declaration.id.name) || []
          entries.push({ statement, declaration, esmNode, ast })
          exportedBindings.set(declaration.id.name, entries)
        }
      }

      if (statement.type === 'ExportNamedDeclaration') {
        for (const specifier of statement.specifiers || []) {
          const exported = specifier.exported?.name || specifier.exported?.value
          if (typeof exported !== 'string') continue
          const entries = exportedBindings.get(exported) || []
          entries.push({ statement, declaration: null, esmNode, ast })
          exportedBindings.set(exported, entries)
        }
      }
    }
  }

  if (galleryImports.length !== 1) {
    fail('UNSUPPORTED_TARGET', `Expected exactly one default Gallery import from ${galleryImportSource}.`)
  }
  const galleryBinding = galleryImports[0]

  const targets = []
  for (const gallery of galleryNodes) {
    if (gallery.name !== galleryBinding) continue
    if (gallery.attributes.some((attribute) => attribute.type !== 'mdxJsxAttribute')) {
      fail('UNSUPPORTED_DYNAMIC_VALUE', 'Gallery spread attributes are unsupported.')
    }

    const ids = gallery.attributes.filter((attribute) => attribute.name === 'id')
    const sortedAttributes = gallery.attributes.filter((attribute) => attribute.name === 'sorted')
    if (ids.length > 1 || sortedAttributes.length !== 1 ||
        sortedAttributes[0].value?.type !== 'mdxJsxAttributeValueExpression') {
      fail('UNSUPPORTED_TARGET', 'Each Gallery must have exactly one `sorted={ARRAY}` attribute and at most one optional static id.')
    }
    if (gallery.attributes.some((attribute) => !['id', 'sorted'].includes(attribute.name))) {
      fail('UNSUPPORTED_TARGET', 'Only the optional static Gallery `id` and `sorted` attributes are supported.')
    }

    const bindingName = sortedAttributes[0].value.value.trim()
    expressionIdentifier(bindingName, bindingName, 'Gallery sorted attribute')
    if (ids.length === 1 && (typeof ids[0].value !== 'string' || ids[0].value !== bindingName)) {
      fail('UNSUPPORTED_TARGET', 'Optional Gallery `id` must be a static string matching its sorted array export name.')
    }
    targets.push({ id: bindingName })
  }

  if (targets.length === 0) {
    fail('UNSUPPORTED_TARGET', 'Expected at least one Gallery imported from the fixture Gallery component.')
  }

  const targetIds = new Set()
  for (const target of targets) {
    if (targetIds.has(target.id)) {
      fail('UNSUPPORTED_TARGET', `The exported array ${target.id} is used by more than one Gallery.`)
    }
    targetIds.add(target.id)
  }

  const expressionPrograms = []
  for (const expression of expressionNodes) {
    if (typeof expression !== 'string') continue
    try {
      const ast = expressionAst(expression, 'MDX expression')
      rejectDirectEval(ast)
      expressionPrograms.push(ast)
    } catch (error) {
      if (error.code === 'UNSUPPORTED_COMMENT' || error.code === 'UNSUPPORTED_DYNAMIC_VALUE') throw error
      // Other MDX expressions are outside the patch target and are not evaluated.
    }
  }

  const galleries = targets.map((target) => {
    const declarations = exportedBindings.get(target.id) || []
    if (declarations.length !== 1 || !declarations[0].declaration) {
      fail('UNSUPPORTED_TARGET', `Expected exactly one direct exported const array named ${target.id}.`)
    }

    const entry = declarations[0]
    const { statement, declaration, esmNode } = entry
    if (statement.declaration.kind !== 'const' || statement.declaration.declarations.length !== 1) {
      fail('UNSUPPORTED_TARGET', `${target.id} must be the only declarator in an exported const statement.`)
    }
    if (declaration.init?.type !== 'ArrayExpression' || declaration.init.elements.length === 0 ||
        declaration.init.elements.some((element) => element?.type !== 'StringLiteral')) {
      fail('UNSUPPORTED_DYNAMIC_VALUE', `${target.id} must be a non-empty literal string array; spreads and expressions are unsupported.`)
    }

    const order = declaration.init.elements.map((element) => element.value)
    if (new Set(order).size !== order.length || order.some((slug) => slug.length === 0)) {
      fail('UNSUPPORTED_VALUE', `${target.id} may contain only unique non-empty string slugs.`)
    }

    const esmReferences = programs.reduce((sum, program) => sum + identifierCount(program.ast, target.id, declaration.id), 0)
    const mdxReferences = expressionPrograms.reduce((sum, expression) => sum + identifierCount(expression, target.id), 0)
    const jsxReferences = jsxNameReferences.filter((name) => jsxNameReferencesBinding(name, target.id)).length
    if (esmReferences !== 0 || mdxReferences !== 1 || jsxReferences !== 0) {
      fail('UNSUPPORTED_TARGET', `${target.id} must be used exactly once, only as its Gallery sorted array.`)
    }

    return {
      id: target.id,
      order,
      range: sourceRange(source, esmNode, declaration.init),
    }
  })

  return galleries
}

export function hashSource(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function inspectFixture(source, options) {
  const galleryImportSource = configuredGalleryImportSource(options)
  const galleries = findGalleryArrays(source, parseMdx(source), galleryImportSource)
    .map(({ id, order }) => ({ id, order }))
  return { galleries, hash: hashSource(source) }
}

export function patchFixtureSource(source, galleryId, requestedOrder, expectedHash, options) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || hashSource(source) !== expectedHash) {
    fail('STALE_HASH', 'The fixture changed since it was loaded. Reload before editing.')
  }

  const galleryImportSource = configuredGalleryImportSource(options)
  const galleries = findGalleryArrays(source, parseMdx(source), galleryImportSource)
  const gallery = galleries.find((item) => item.id === galleryId)
  if (!gallery) fail('UNSUPPORTED_TARGET', 'The requested Gallery id is not part of the fixed demo fixture.')
  if (!Array.isArray(requestedOrder) || requestedOrder.length !== gallery.order.length ||
      requestedOrder.some((item) => typeof item !== 'string') ||
      new Set(requestedOrder).size !== requestedOrder.length ||
      gallery.order.some((item) => !requestedOrder.includes(item))) {
    fail('UNSUPPORTED_VALUE', 'Only reordering the selected Gallery’s existing image slugs is allowed.')
  }

  const replacement = JSON.stringify(requestedOrder)
  const updatedSource = source.slice(0, gallery.range.start) + replacement + source.slice(gallery.range.end)
  return { source: updatedSource, ...inspectFixture(updatedSource, { galleryImportSource }) }
}
