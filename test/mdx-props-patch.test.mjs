import test from 'node:test'
import assert from 'node:assert/strict'
import { createMdxPropsAdapter } from '../src/lib/mdx-props-patch.mjs'

const adapter = createMdxPropsAdapter({ importSource: '../components/Card.astro', editableProps: ['title'] })
const source = `import Card from '../components/Card.astro'\n\n<Card id="one" title="Old" />\n`

test('patches only the selected literal range and preserves every other byte', () => {
  const { hash } = adapter.inspect(source)
  const result = adapter.patch(source, 'one', 'title', 'New', hash)
  assert.equal(result.source, source.replace('title="Old"', 'title="New"'))
  assert.equal(result.diff.before, '"Old"')
})

test('an identical literal value is a no-op', () => {
  const { hash } = adapter.inspect(source)
  const result = adapter.patch(source, 'one', 'title', 'Old', hash)
  assert.equal(result.source, source)
  assert.equal(result.diff, null)
})

test('parser ranges preserve CRLF and Unicode outside the quoted literal', () => {
  const sourceWithFormatting = `import Card from '../components/Card.astro'\r\n\r\n# 🌊 synthetic fixture\r\n\r\n<Card id="one" title="Old" />\r\n`
  const { hash } = adapter.inspect(sourceWithFormatting)
  const result = adapter.patch(sourceWithFormatting, 'one', 'title', 'New', hash)
  assert.equal(result.source, sourceWithFormatting.replace('title="Old"', 'title="New"'))
})

test('BOM and complex MDX no-op preserve exact source and supported edits target only the quoted literal', () => {
  const sourceWithBom = `\uFEFF---\r\n# retain frontmatter comment\r\ntitle: "Keep — 東京"\r\n---\r\n\r\nimport Card from "../components/Card.astro";\r\nimport Unknown from "../components/Unknown.astro"; // keep import note\r\n\r\n{/* retain MDX comment */}\r\n<Card id="hero" title="Old" className="keep" enabled={isReady} />\r\n\r\n<Unknown value={compute()}>\r\n  Opaque child — 保持\r\n</Unknown>\r\n`
  const configured = createMdxPropsAdapter({ importSource: '../components/Card.astro', idProp: 'id', editableProps: ['title'] })
  const state = configured.inspect(sourceWithBom)
  assert.equal(state.instances[0].props.title, 'Old')
  const noOp = configured.patch(sourceWithBom, 'hero', 'title', 'Old', state.hash)
  assert.equal(noOp.diff, null)
  assert.equal(noOp.source, sourceWithBom)
  const edited = configured.patch(sourceWithBom, 'hero', 'title', 'New', state.hash)
  assert.equal(edited.source, sourceWithBom.replace('title="Old"', 'title="New"'))
  assert.equal(edited.diff.before, '"Old"')
  assert.equal(edited.diff.after, '"New"')
})

test('trusted import identity and static safety failures fail closed', () => {
  assert.throws(() => adapter.inspect(source.replace('../components/Card.astro', '../evil/Card.astro')))
  for (const mdx of [
    `import Card from '../components/Card.astro'\n<Card id="one" title={value} />`,
    `import Card from '../components/Card.astro'\n<Card id="one" title="x" {...props} />`,
    `import Card from '../components/Card.astro'\n<Card id="one" title="x" /><Card id="one" title="y" />`,
    `import Card from '../components/Card.astro'\n<Card id="one" title="x" title="y" />`,
    `import type Card from '../components/Card.astro'\n<Card id="one" title="x" />`,
    `import Card, { helper } from '../components/Card.astro'\n<Card id="one" title="x" />`,
  ]) assert.throws(() => adapter.inspect(mdx))
})

test('the local JSX binding is taken from the trusted default-import alias', () => {
  const aliasSource = `import DisplayCard from '../components/Card.astro'\n\n<DisplayCard id="one" title="Old" />\n`
  const { hash, instances } = adapter.inspect(aliasSource)
  assert.deepEqual(instances, [{ id: 'one', props: { title: 'Old' } }])
  const result = adapter.patch(aliasSource, 'one', 'title', 'New', hash)
  assert.equal(result.source, aliasSource.replace('title="Old"', 'title="New"'))
})

test('rejects stale writes while preserving unconfigured component props unchanged', () => {
  const { hash } = adapter.inspect(source)
  assert.throws(() => adapter.patch(source, 'one', 'title', 'New', '0'.repeat(64)), { code: 'STALE_HASH' })
  const withOpaqueProps = source.replace('<Card id=', '<Card className="hero" active={isReady} id=')
  const opaqueState = adapter.inspect(withOpaqueProps)
  const result = adapter.patch(withOpaqueProps, 'one', 'title', 'New', opaqueState.hash)
  assert.equal(result.source, withOpaqueProps.replace('title="Old"', 'title="New"'))
  assert.throws(() => adapter.inspect(withOpaqueProps.replace(' active={isReady}', ' active={isReady} active={false}')))
  assert.equal(hash.length, 64)
})

test('typed static scalar fields patch only their literal and enforce trusted bounds and choices', () => {
  const typed = createMdxPropsAdapter({ importSource: '../components/Card.astro', fields: [
    { name: 'title', type: 'string', label: 'Title' },
    { name: 'rank', type: 'number', min: 1, max: 5, step: 1 },
    { name: 'enabled', type: 'boolean' },
    { name: 'tone', type: 'enum', values: ['quiet', 'loud'] },
  ] })
  const input = `import Card from '../components/Card.astro'\n\n<Card id="typed" title="Old" rank={2} enabled={true} tone="quiet" />\n`
  const original = typed.inspect(input)
  assert.deepEqual(original.instances[0].props, { title: 'Old', rank: 2, enabled: true, tone: 'quiet' })
  for (const [prop, value, before, after] of [
    ['title', 'New', '"Old"', '"New"'], ['rank', 4, '{2}', '{4}'], ['enabled', false, '{true}', '{false}'], ['tone', 'loud', '"quiet"', '"loud"'],
  ]) {
    const result = typed.patch(input, 'typed', prop, value, original.hash)
    assert.equal(result.source, input.replace(before, after))
    assert.equal(result.diff.before, before)
    assert.equal(input.slice(0, result.diff.start) + result.diff.after + input.slice(result.diff.end), result.source)
  }
  assert.throws(() => typed.patch(input, 'typed', 'rank', 6, original.hash), { code: 'UNSUPPORTED_VALUE' })
  assert.throws(() => typed.patch(input, 'typed', 'tone', 'wild', original.hash), { code: 'UNSUPPORTED_VALUE' })
  const decimal = createMdxPropsAdapter({ importSource: '../components/Card.astro', fields: [{ name: 'opacity', type: 'number', min: 0, max: 1, step: 0.1 }] })
  const decimalInput = `import Card from '../components/Card.astro'\n\n<Card id="decimal" opacity={0.2} />`
  const decimalState = decimal.inspect(decimalInput)
  assert.equal(decimal.patch(decimalInput, 'decimal', 'opacity', 0.3, decimalState.hash).source, decimalInput.replace('opacity={0.2}', 'opacity={0.3}'))
  assert.throws(() => createMdxPropsAdapter({ importSource: './Card.astro', fields: [{ name: 'n', type: 'number', min: 3, max: 1 }] }), { code: 'INVALID_ADAPTER_CONFIG' })
})
