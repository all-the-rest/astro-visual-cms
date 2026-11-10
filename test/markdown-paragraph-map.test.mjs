import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarkdownDraftMarkerPlugin, createMarkdownParagraphAdapter, createMarkdownParagraphMarkerPlugin, mapConfiguredMarkdownDraft, mapSinglePlainParagraph, patchConfiguredMarkdownDraft, patchSinglePlainParagraph } from '../src/lib/markdown-paragraph-map.mjs'

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

test('configured visual draft maps one root prose node among opaque MDX and produces a text-only exact diff', () => {
  const target = 'One configured fictional sentence.'
  const source = `---\ntitle: "Opaque frontmatter"\n---\nimport Chip from './Chip.astro'\n\n<Chip value={opaqueExpression} />\n\nOther unselected prose.\n\n${target}\n\n<Chip slot="note">Nested text</Chip>\n`
  const mapping = mapConfiguredMarkdownDraft(source, target)
  assert.equal(source.slice(mapping.start, mapping.end), target)
  const result = patchConfiguredMarkdownDraft(source, target, 'A revised fictional sentence.', mapping.hash)
  assert.deepEqual(result.diff, { start: mapping.start, end: mapping.end, before: target, after: 'A revised fictional sentence.' })
  assert.equal(result.nextHash.length, 64)
  assert.equal(result.hash, mapping.hash)
  assert.equal(result.source, undefined)
  assert.equal(source.slice(0, mapping.start), source.slice(0, mapping.start))
  assert.equal(source.slice(0, mapping.start) + result.diff.after + source.slice(mapping.end),
    source.replace(target, result.diff.after))
  assert.deepEqual(patchConfiguredMarkdownDraft(source, target, target, mapping.hash), { hash: mapping.hash, diff: null })
})

test('configured visual draft fails closed for duplicate, formatted, multiline, or transformed targets and stale hashes', () => {
  const target = 'One configured sentence.'
  for (const source of [
    `${target}\n\n${target}\n`,
    `**${target}**\n`,
    'One configured\nsentence.\n',
    '<Chip />\n',
  ]) assert.throws(() => mapConfiguredMarkdownDraft(source, target), { code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
  const source = `${target}\n`
  assert.throws(() => patchConfiguredMarkdownDraft(source, target, 'Changed sentence.', '0'.repeat(64)), { code: 'STALE_HASH' })
  assert.throws(() => patchConfiguredMarkdownDraft(source, target, '<img src=x>', mapConfiguredMarkdownDraft(source, target).hash), { code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
})

test('visual draft marker is limited to its exact file and unique root-level prose target', () => {
  const target = 'One configured sentence.'
  const source = `${target}\n`
  const factory = createMarkdownDraftMarkerPlugin({
    filePath: '/project/page.mdx', targetId: 'draft-target', instanceId: 'draft-instance', text: target,
  })
  assert.equal(factory({ sourceFormat: 'mdx', fileURL: new URL('file:///other/page.mdx'), source }), null)
  const plugin = factory({ sourceFormat: 'mdx', fileURL: new URL('file:///project/page.mdx'), source })
  const node = { type: 'paragraph', position: { start: { offset: 0 }, end: { offset: target.length } }, data: {} }
  let result
  plugin.paragraph(node, { setField(targetNode, key, value) { result = { targetNode, key, value } } })
  assert.equal(result.targetNode, node)
  assert.equal(result.key, 'data')
  assert.deepEqual(result.value.hProperties, {
    'data-astro-visual-cms-draft-target': 'draft-target',
    'data-astro-visual-cms-draft-instance': 'draft-instance',
    tabindex: '0',
    role: 'button',
    'aria-label': 'Select this visual Markdown draft paragraph',
  })
  assert.equal(factory({ sourceFormat: 'mdx', fileURL: new URL('file:///project/page.mdx'), source: `${source}\n${target}\n` }), null)
})
