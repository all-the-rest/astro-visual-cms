import { createHash } from 'node:crypto'
import { parse } from '@babel/parser'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
export const hashAstroGallerySource = (source) => createHash('sha256').update(source, 'utf8').digest('hex')

// A deliberately narrow adapter: only the configured top-level const array in
// the first Astro frontmatter block is considered; project code is never run.
export function createAstroGalleryAdapter({ variableName, identityProperty = 'name', labelProperty = 'alt' }) {
  if (![variableName, identityProperty, labelProperty].every((v) => typeof v === 'string' && /^[A-Za-z_$][\w$]*$/.test(v))) throw new TypeError('Invalid Astro gallery adapter configuration.')
  function inspect(source) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) fail('UNSUPPORTED_TARGET', 'Expected Astro frontmatter.')
    const start = match.index + match[0].indexOf(match[1])
    let ast
    try { ast = parse(match[1], { sourceType: 'module', plugins: ['typescript'] }) } catch { fail('UNSUPPORTED_SYNTAX', 'Astro frontmatter is not supported static JavaScript/TypeScript.') }
    if (ast.comments.length) fail('UNSUPPORTED_COMMENT', 'Comments in Astro frontmatter are unsupported.')
    const declarations = ast.program.body.flatMap((s) => s.type === 'VariableDeclaration' ? s.declarations.filter((d) => d.id.type === 'Identifier' && d.id.name === variableName).map((d) => ({ s, d })) : [])
    if (declarations.length !== 1) fail('UNSUPPORTED_TARGET', 'Expected exactly one configured top-level array declaration.')
    const { s, d } = declarations[0]
    if (s.kind !== 'const' || s.declarations.length !== 1 || d.init?.type !== 'ArrayExpression' || !d.init.elements.length) fail('UNSUPPORTED_DYNAMIC_VALUE', 'Configured value must be a non-empty const object array.')
    const entries = d.init.elements.map((object) => {
      if (object?.type !== 'ObjectExpression' || object.properties.some((p) => p.type !== 'ObjectProperty' || p.computed || p.method || p.shorthand || p.key.type !== 'Identifier')) fail('UNSUPPORTED_DYNAMIC_VALUE', 'Only plain object literals with static keys are supported.')
      const get = (key) => object.properties.filter((p) => p.key.name === key)
      const identity = get(identityProperty), label = get(labelProperty)
      if (identity.length !== 1 || label.length !== 1 || identity[0].value.type !== 'StringLiteral' || label[0].value.type !== 'StringLiteral') fail('UNSUPPORTED_DYNAMIC_VALUE', 'Identity and display label must be unique string literals.')
      const id = identity[0].value.value, display = label[0].value.value
      if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || !display.trim() || display.length > 512 || /[\u0000-\u001f\u007f]/.test(display)) fail('UNSUPPORTED_VALUE', 'Identity and label strings exceed safe bounds.')
      return { id, label: display, range: { start: start + object.start, end: start + object.end } }
    })
    if (entries.length > 100) fail('UNSUPPORTED_TARGET', 'Configured gallery arrays are limited to 100 entries.')
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && node.left.name === variableName ||
          node.type === 'UpdateExpression' && node.argument?.type === 'Identifier' && node.argument.name === variableName ||
          node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier' && node.callee.object.name === variableName && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill'].includes(node.callee.property?.name)) fail('UNSUPPORTED_DYNAMIC_VALUE', 'Mutation of the configured gallery array is unsupported.')
      for (const [key, value] of Object.entries(node)) if (key !== 'loc' && key !== 'start' && key !== 'end') Array.isArray(value) ? value.forEach(visit) : visit(value)
    }
    visit(ast.program)
    if (entries.some((e) => !e.id) || new Set(entries.map((e) => e.id)).size !== entries.length) fail('UNSUPPORTED_VALUE', 'Gallery identities must be unique non-empty strings.')
    return { entries, hash: hashAstroGallerySource(source), arrayRange: { start: start + d.init.start, end: start + d.init.end }, elementRanges: d.init.elements.map((e) => ({ start: start + e.start, end: start + e.end })) }
  }
  return Object.freeze({ inspect(source) { const state = inspect(source); return { entries: state.entries.map(({ id, label }) => ({ id, label })), order: state.entries.map((e) => e.id), hash: state.hash } }, patch(source, requestedOrder, expectedHash) {
    if (hashAstroGallerySource(source) !== expectedHash) fail('STALE_HASH', 'Source changed since it was loaded.')
    const state = inspect(source), ids = state.entries.map((e) => e.id)
    if (!Array.isArray(requestedOrder) || requestedOrder.length !== ids.length || new Set(requestedOrder).size !== ids.length || requestedOrder.some((id) => !ids.includes(id))) fail('UNSUPPORTED_VALUE', 'Only reordering existing identities is allowed.')
    if (requestedOrder.every((id, i) => id === ids[i])) return { source, hash: expectedHash, diff: null }
    const byId = new Map(state.entries.map((e) => [e.id, e]))
    const ranges = state.elementRanges
    const gaps = ranges.slice(0, -1).map((r, i) => source.slice(r.end, ranges[i + 1].start))
    const prefix = source.slice(state.arrayRange.start, ranges[0].start)
    const suffix = source.slice(ranges.at(-1).end, state.arrayRange.end)
    const replacement = prefix + requestedOrder.map((id, i) => source.slice(byId.get(id).range.start, byId.get(id).range.end) + (gaps[i] ?? '')).join('') + suffix
    const before = source.slice(state.arrayRange.start, state.arrayRange.end)
    const updated = source.slice(0, state.arrayRange.start) + replacement + source.slice(state.arrayRange.end)
    const checked = inspect(updated)
    if (checked.entries.map((e) => e.id).join('\0') !== requestedOrder.join('\0')) fail('UNSUPPORTED_OUTPUT', 'Patched source failed validation.')
    return { source: updated, hash: checked.hash, diff: { start: state.arrayRange.start, end: state.arrayRange.end, before, after: replacement } }
  } })
}
