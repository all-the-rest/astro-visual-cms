import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarkdownParagraphAdapter, createMarkdownParagraphMarkerPlugin, mapSinglePlainParagraph, patchSinglePlainParagraph } from '../src/lib/markdown-paragraph-map.mjs'

test('maps and patches only a single exact-source plain paragraph', () => {
  const source = 'Synthetic paragraph text.\n'
  const map = mapSinglePlainParagraph(source)
  assert.equal(source.slice(map.start, map.end), map.text)
  const result = patchSinglePlainParagraph(source, 'Edited synthetic text.', map.hash)
  assert.equal(result.source, 'Edited synthetic text.\n')
  assert.deepEqual(result.diff, { start: 0, end: 25, before: 'Synthetic paragraph text.', after: 'Edited synthetic text.' })
})

test('fails closed for duplicate, formatted, linked, multiline, JSX, and transformed ambiguity', () => {
  for (const source of [
    'one\n\ntwo\n', '**formatted**\n', '[linked](https://example.test)\n', 'one\ntwo\n',
    '<Chip />\n', '{value}\n', 'one `code`\n',
  ]) assert.throws(() => mapSinglePlainParagraph(source), { code: 'UNSUPPORTED_MARKDOWN_MAPPING' }, source)
})

test('rejects stale hashes and line-breaking replacements without a source result', () => {
  const source = 'Synthetic text.\n'
  const { hash } = mapSinglePlainParagraph(source)
  assert.throws(() => patchSinglePlainParagraph(source, 'changed', '0'.repeat(64)), { code: 'STALE_HASH' })
  assert.throws(() => patchSinglePlainParagraph(source, 'two\nlines', hash), { code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
  assert.equal(source, 'Synthetic text.\n')
})

test('paragraph adapter exposes only its trusted text field and fails closed on formatted output', () => {
  const adapter = createMarkdownParagraphAdapter({ instanceId: 'paragraph-one' })
  const source = 'Synthetic paragraph.\n'
  const state = adapter.inspect(source)
  assert.deepEqual(state.instances, [{ id: 'paragraph-one', props: { text: 'Synthetic paragraph.' } }])
  assert.throws(() => adapter.patch(source, 'other', 'text', 'changed', state.hash), { code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
  assert.throws(() => adapter.patch(source, 'paragraph-one', 'text', '**changed**', state.hash), { code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
})

test('remark marker factory marks only the exact trusted MDX file and source paragraph', () => {
  const source = 'Synthetic paragraph.\n'
  const factory = createMarkdownParagraphMarkerPlugin({ filePath: '/project/page.mdx', targetId: 'markdown-note', instanceId: 'paragraph-one' })
  assert.equal(factory({ sourceFormat: 'md', fileURL: new URL('file:///project/page.mdx'), source }), null)
  assert.equal(factory({ sourceFormat: 'mdx', fileURL: new URL('file:///elsewhere/page.mdx'), source }), null)
  const plugin = factory({ sourceFormat: 'mdx', fileURL: new URL('file:///project/page.mdx'), source })
  assert.deepEqual(plugin.options, { position: true })
  const node = { type: 'paragraph', position: { start: { offset: 0 }, end: { offset: 20 } }, data: {} }
  let result
  plugin.paragraph(node, { setField(target, key, value) { result = { target, key, value } } })
  assert.equal(result.target, node)
  assert.equal(result.key, 'data')
  assert.deepEqual(result.value.hProperties, {
    'data-astro-visual-cms-target': 'markdown-note',
    'data-astro-visual-cms-instance': 'paragraph-one',
  })
})
