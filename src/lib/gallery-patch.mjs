import { createHash } from 'node:crypto'
import { parse } from '@babel/parser'
import { createProcessor } from '@mdx-js/mdx'

export const FIXTURE_IMAGE_SLUGS = Object.freeze([
  'noise-fixture-01',
  'noise-fixture-02',
  'noise-fixture-03',
])

const mdxProcessor = createProcessor({ format: 'mdx' })

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function parseJavaScript(source, label) {
  try {
    const ast = parse(source, { sourceType: 'module' })
    if (ast.comments.length > 0) {
      fail('UNSUPPORTED_COMMENT', `Comments are unsupported in the ${label}.`)
    }
    return ast
  } catch (error) {
    if (error.code) throw error
    fail('UNSUPPORTED_SYNTAX', `Could not parse the ${label} as static JavaScript.`)
  }
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

function expressionIdentifier(expression, expected, label) {
  const ast = parseJavaScript(`const __fixtureValue = (${expression});`, label)
  const initializer = ast.program.body[0]?.declarations?.[0]?.init
  if (initializer?.type !== 'Identifier' || initializer.name !== expected) {
    fail('UNSUPPORTED_DYNAMIC_VALUE', `${label} must be the literal identifier ${expected}.`)
  }
}

function findSortingArray(source, mdast) {
  const esmNodes = []
  const galleryNodes = []
  const expressionComments = []

  walk(mdast, (node) => {
    if (node.type === 'mdxjsEsm') esmNodes.push(node)
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'Gallery') {
      galleryNodes.push(node)
    }
    if (node.type === 'html' && typeof node.value === 'string' && node.value.includes('<!--')) {
      expressionComments.push('HTML comment')
    }
    if ((node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') && typeof node.value === 'string') {
      try {
        const parsed = parse(`(${node.value})`, { sourceType: 'module' })
        if (parsed.comments.length > 0) expressionComments.push('MDX expression comment')
      } catch {
        // Non-comment MDX expressions outside the patch target are not evaluated by the spike.
      }
    }
  })

  if (expressionComments.length > 0) {
    fail('UNSUPPORTED_COMMENT', 'Comments in the MDX fixture are unsupported by this patcher.')
  }
  if (galleryNodes.length !== 1) {
    fail('UNSUPPORTED_TARGET', 'The fixture must contain exactly one Gallery component.')
  }

  const declarations = []
  let sortingSourceNode
  let sortingProgram
  for (const esmNode of esmNodes) {
    const program = parseJavaScript(esmNode.value, 'MDX ESM block')
    for (const statement of program.program.body) {
      if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration') {
        for (const declaration of statement.declaration.declarations) {
          if (declaration.id.type === 'Identifier' && declaration.id.name === 'SORTING') {
            declarations.push({ statement, declaration, esmNode, program })
          }
        }
      }
      if (statement.type === 'ExportNamedDeclaration' && statement.specifiers?.some((spec) => spec.exported?.name === 'SORTING')) {
        declarations.push({ statement, declaration: null, esmNode, program })
      }
    }
  }

  if (declarations.length !== 1 || !declarations[0].declaration) {
    fail('UNSUPPORTED_TARGET', 'Expected exactly one `export const SORTING = [...]` declaration.')
  }

  const { statement, declaration, esmNode, program } = declarations[0]
  if (statement.declaration.kind !== 'const' || statement.declaration.declarations.length !== 1) {
    fail('UNSUPPORTED_TARGET', 'SORTING must be the only declarator in an exported const statement.')
  }
  if (declaration.init?.type !== 'ArrayExpression') {
    fail('UNSUPPORTED_DYNAMIC_VALUE', 'SORTING must be a literal string array.')
  }
  if (declaration.init.elements.some((element) => element?.type !== 'StringLiteral')) {
    fail('UNSUPPORTED_DYNAMIC_VALUE', 'SORTING may contain only string literals; spreads and expressions are unsupported.')
  }

  const order = declaration.init.elements.map((element) => element.value)
  if (new Set(order).size !== order.length || order.length !== FIXTURE_IMAGE_SLUGS.length ||
      FIXTURE_IMAGE_SLUGS.some((slug) => !order.includes(slug))) {
    fail('UNSUPPORTED_VALUE', 'SORTING must contain each known local noise-fixture slug exactly once.')
  }

  const gallery = galleryNodes[0]
  if (gallery.attributes.some((attribute) => attribute.type !== 'mdxJsxAttribute')) {
    fail('UNSUPPORTED_DYNAMIC_VALUE', 'Gallery spread attributes are unsupported.')
  }
  const sortedAttributes = gallery.attributes.filter((attribute) => attribute.name === 'sorted')
  if (sortedAttributes.length !== 1 || sortedAttributes[0].value?.type !== 'mdxJsxAttributeValueExpression') {
    fail('UNSUPPORTED_TARGET', 'Gallery must have exactly one `sorted={SORTING}` attribute.')
  }
  expressionIdentifier(sortedAttributes[0].value.value, 'SORTING', 'Gallery sorted attribute')

  const blockStart = esmNode.position?.start?.offset
  const blockEnd = esmNode.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) {
    fail('UNSUPPORTED_TARGET', 'The MDX parser did not provide source offsets for SORTING.')
  }
  const block = source.slice(blockStart, blockEnd)
  const valueOffset = block.indexOf(esmNode.value)
  if (valueOffset < 0 || block.indexOf(esmNode.value, valueOffset + 1) >= 0) {
    fail('UNSUPPORTED_TARGET', 'Could not unambiguously map the export AST back to source bytes.')
  }
  sortingSourceNode = esmNode
  sortingProgram = program
  const absoluteStart = blockStart + valueOffset + declaration.init.start
  const absoluteEnd = blockStart + valueOffset + declaration.init.end

  return {
    order,
    range: { start: absoluteStart, end: absoluteEnd },
    sourceNode: sortingSourceNode,
    program: sortingProgram,
  }
}

export function hashSource(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function inspectFixture(source) {
  let mdast
  try {
    mdast = mdxProcessor.parse(source)
  } catch {
    fail('UNSUPPORTED_SYNTAX', 'The fixture is not valid MDX syntax.')
  }
  const { order } = findSortingArray(source, mdast)
  return { order, hash: hashSource(source) }
}

export function patchFixtureSource(source, requestedOrder, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || hashSource(source) !== expectedHash) {
    fail('STALE_HASH', 'The fixture changed since it was loaded. Reload before editing.')
  }
  const mdast = mdxProcessor.parse(source)
  const { order, range } = findSortingArray(source, mdast)
  if (!Array.isArray(requestedOrder) || requestedOrder.length !== order.length ||
      requestedOrder.some((item) => typeof item !== 'string') ||
      new Set(requestedOrder).size !== requestedOrder.length ||
      order.some((item) => !requestedOrder.includes(item))) {
    fail('UNSUPPORTED_VALUE', 'Only reordering the existing fixture image strings is allowed.')
  }

  const replacement = JSON.stringify(requestedOrder)
  const updatedSource = source.slice(0, range.start) + replacement + source.slice(range.end)
  return { source: updatedSource, order: requestedOrder, hash: hashSource(updatedSource) }
}
