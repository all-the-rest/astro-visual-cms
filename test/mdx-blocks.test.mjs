import test from 'node:test'
import assert from 'node:assert/strict'
import { compile } from '@mdx-js/mdx'
import { createMdxBlocksAdapter } from '../src/lib/mdx-blocks.mjs'

const blockTypes = [
  {
    type: 'hero', label: 'Hero', importSource: '../components/Hero.astro', componentName: 'Hero', idProp: 'cmsId',
    fields: [
      { name: 'title', type: 'string', label: 'Title', required: true },
      { name: 'tone', type: 'enum', values: ['light', 'dark'], default: 'light' },
    ],
  },
  {
    type: 'callout', label: 'Callout', importSource: '../components/Callout.astro', componentName: 'Callout', idProp: 'cmsId',
    fields: [{ name: 'visible', type: 'boolean', default: true }, { name: 'rank', type: 'number', min: 1, max: 5, default: 2 }],
  },
]

const adapter = createMdxBlocksAdapter({ blockTypes })

test('adds a trusted MDX component invocation directly to source and applies trusted defaults', async () => {
  const source = `---\r\ntitle: Keep this entry\r\n---\r\n\r\n# Existing prose — 東京\r\n`
  const state = adapter.inspect(source)
  const result = adapter.patch(source, { action: 'add', blockType: 'hero', values: { title: 'Welcome' } }, state.hash, 'block-one')

  assert.match(result.source, /import Hero from "\.\.\/components\/Hero\.astro"/)
  assert.match(result.source, /<Hero cmsId="block-one" title="Welcome" tone="light" \/>/)
  assert.match(result.source, /# Existing prose — 東京/)
  assert.deepEqual(adapter.inspect(result.source).blocks, [
    { id: 'block-one', type: 'hero', label: 'Hero', props: { title: 'Welcome', tone: 'light' } },
  ])
  assert.equal(source.slice(0, result.diff.start) + result.diff.after + source.slice(result.diff.end), result.source)
  await compile(result.source)
})

test('encodes quotes, backslashes, and newlines as static MDX string expressions', async () => {
  const source = `import Hero from '../components/Hero.astro'\n\n<Hero cmsId="hero-one" title="Before" />\n`
  const value = 'Quote: "welcome" \\docs\\cms\nsecond line'
  const result = adapter.patch(source, { action: 'set', blockId: 'hero-one', prop: 'title', value }, adapter.inspect(source).hash)

  assert.ok(result.source.includes(`title={${JSON.stringify(value)}}`))
  await compile(result.source)
  assert.equal(adapter.inspect(result.source).blocks[0].props.title, value)

  const added = adapter.patch(`# Existing prose\n`, { action: 'add', blockType: 'hero', values: { title: value } }, adapter.inspect(`# Existing prose\n`).hash, 'hero-added')
  assert.ok(added.source.includes(`title={${JSON.stringify(value)}}`))
  await compile(added.source)
  assert.equal(adapter.inspect(added.source).blocks[0].props.title, value)
})

test('first insertion keeps one blank line between frontmatter, imports, block, and prose', async () => {
  const source = `---\ntitle: Synthetic\n---\n\n# Existing prose\n`
  const result = adapter.patch(source, { action: 'add', blockType: 'hero', values: { title: 'First' } }, adapter.inspect(source).hash, 'hero-first')
  assert.equal(result.source, `---\ntitle: Synthetic\n---\n\nimport Hero from "../components/Hero.astro"\n\n<Hero cmsId="hero-first" title="First" tone="light" />\n\n# Existing prose\n`)
  await compile(result.source)
})

test('adds a second type using its trusted import and supports aliases already present in source', () => {
  const source = `import DisplayHero from '../components/Hero.astro'\n\n<DisplayHero cmsId="hero-one" title="One" />\n`
  const state = adapter.inspect(source)
  const result = adapter.patch(source, { action: 'add', blockType: 'callout', values: {} }, state.hash, 'callout-one')

  assert.equal((result.source.match(/import DisplayHero/g) || []).length, 1)
  assert.match(result.source, /import Callout from "\.\.\/components\/Callout\.astro"/)
  assert.match(result.source, /<Callout cmsId="callout-one" visible=\{true\} rank=\{2\} \/>/)
  assert.deepEqual(result.blocks.map(({ id, type }) => [id, type]), [['hero-one', 'hero'], ['callout-one', 'callout']])
})

test('edits only the supported static literal and rejects dynamic values', () => {
  const source = `import Hero from '../components/Hero.astro'\n\n<Hero cmsId="hero-one" title="Old" tone="light" className={dynamic} />\n`
  const state = adapter.inspect(source)
  const result = adapter.patch(source, { action: 'set', blockId: 'hero-one', prop: 'title', value: 'New' }, state.hash)
  assert.equal(result.source, source.replace('title="Old"', 'title="New"'))
  assert.equal(result.diff.before, '"Old"')
  assert.throws(() => adapter.patch(source, { action: 'set', blockId: 'hero-one', prop: 'tone', value: 'loud' }, state.hash), { code: 'UNSUPPORTED_VALUE' })
  assert.throws(() => adapter.patch(source, { action: 'set', blockId: 'hero-one', prop: 'className', value: 'unsafe' }, state.hash), { code: 'UNSUPPORTED_BLOCK_PROP' })
})

test('adds a missing optional scalar prop without serializing or rewriting the rest of the JSX tag', () => {
  const source = `import Hero from '../components/Hero.astro'\n\n<Hero cmsId="hero-one" title="Existing" />\n`
  const state = adapter.inspect(source)
  const result = adapter.patch(source, { action: 'set', blockId: 'hero-one', prop: 'tone', value: 'dark' }, state.hash)
  assert.match(result.source, /title="Existing" tone="dark"\s*\/>/)
  assert.match(result.source, /import Hero from '\.\.\/components\/Hero\.astro'/)
  assert.deepEqual(adapter.inspect(result.source).blocks[0].props, { title: 'Existing', tone: 'dark' })
})

test('remove changes only the selected component invocation', () => {
  const source = `import Hero from '../components/Hero.astro'\n\n# Before\n\n<Hero cmsId="hero-one" title="One" />\n\n# After\n`
  const state = adapter.inspect(source)
  const result = adapter.patch(source, { action: 'remove', blockId: 'hero-one' }, state.hash)
  assert.equal(result.source, source.replace('<Hero cmsId="hero-one" title="One" />', ''))
  assert.match(result.source, /# Before[\s\S]*# After/)
})

test('reorders only adjacent top-level blocks separated by whitespace', () => {
  const source = `import Hero from '../components/Hero.astro'\n\n<Hero cmsId="one" title="One" />\n\n<Hero cmsId="two" title="Two" />\n`
  const state = adapter.inspect(source)
  const result = adapter.patch(source, { action: 'move', blockId: 'two', delta: -1 }, state.hash)
  assert.ok(result.source.indexOf('cmsId="two"') < result.source.indexOf('cmsId="one"'))
  assert.equal(adapter.inspect(result.source).blocks[0].id, 'two')

  const separated = `import Hero from '../components/Hero.astro'\n\n<Hero cmsId="one" title="One" />\n\nText between\n\n<Hero cmsId="two" title="Two" />\n`
  assert.throws(() => adapter.patch(separated, { action: 'move', blockId: 'two', delta: -1 }, adapter.inspect(separated).hash), { code: 'UNSUPPORTED_BLOCK_ORDER' })
})

test('preserves BOM/CRLF/Unicode and rejects stale, duplicate, nested, slotted, and spread blocks', () => {
  const source = `\uFEFFimport Hero from "../components/Hero.astro";\r\n\r\n<Hero cmsId="one" title="🌊 東京" />\r\n`
  const state = adapter.inspect(source)
  const edited = adapter.patch(source, { action: 'set', blockId: 'one', prop: 'title', value: 'Keep me — 東京' }, state.hash)
  assert.equal(edited.source, source.replace('title="🌊 東京"', 'title="Keep me — 東京"'))
  assert.throws(() => adapter.patch(source, { action: 'remove', blockId: 'one' }, '0'.repeat(64)), { code: 'STALE_HASH' })

  for (const invalid of [
    `import Hero from '../components/Hero.astro'\n<Hero cmsId="one" title="A" /><Hero cmsId="one" title="B" />`,
    `import Hero from '../components/Hero.astro'\n<Other><Hero cmsId="one" title="A" /></Other>`,
    `import Hero from '../components/Hero.astro'\n<Hero cmsId="one" title="A">child</Hero>`,
    `import Hero from '../components/Hero.astro'\n<Hero cmsId="one" title="A" {...props} />`,
  ]) assert.throws(() => adapter.inspect(invalid))
})

test('rejects invalid metadata, missing required values, import collisions, and malformed operations', () => {
  assert.throws(() => createMdxBlocksAdapter({ blockTypes: [{ ...blockTypes[0], fields: [{ name: 'x', type: 'number', min: 5, max: 1 }] }] }), { code: 'INVALID_BLOCK_CONFIG' })
  const empty = `# Start\n`
  assert.throws(() => adapter.patch(empty, { action: 'add', blockType: 'hero', values: {} }, adapter.inspect(empty).hash, 'one'), { code: 'MISSING_REQUIRED_FIELD' })
  const collision = `import Hero from '../other/Hero.astro'\n\n# Start\n`
  assert.throws(() => adapter.patch(collision, { action: 'add', blockType: 'hero', values: { title: 'A' } }, adapter.inspect(collision).hash, 'one'), { code: 'IMPORT_BINDING_COLLISION' })
  assert.throws(() => adapter.patch(empty, { action: 'add', blockType: 'hero', values: { title: 'A', other: 'x' } }, adapter.inspect(empty).hash, 'one'), { code: 'UNKNOWN_BLOCK_PROP' })
  assert.throws(() => adapter.patch(empty, { action: 'unknown' }, adapter.inspect(empty).hash), { code: 'INVALID_OPERATION' })
})
