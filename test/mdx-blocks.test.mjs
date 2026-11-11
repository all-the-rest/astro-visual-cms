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

test('a Markdown source is never parsed as MDX: only the generated block zone is trusted', async () => {
  const markdown = [
    '---',
    'title: Plain Markdown',
    '---',
    '',
    'import { writeFileSync } from "node:fs"',
    '',
    '# Prose',
    '',
    'A paragraph with {notAnExpression} and <Hero cmsId="untrusted" title="text" />.',
    '',
    '```js',
    "const value = { nested: true }",
    '</Hero>',
    '```',
    '',
    '<div data-html="kept">Raw HTML</div>',
    '',
  ].join('\n')
  const adapter = createMdxBlocksAdapter({ blockTypes, format: 'md' })
  const state = adapter.inspect(markdown)
  assert.deepEqual(state.blocks, [], 'pre-existing Markdown text must not become blocks')
  const described = adapter.describe(markdown)
  assert.deepEqual(described.blocks, [])
  const body = markdown.slice(described.bodyStart)
  assert.equal(body.startsWith('\nimport { writeFileSync }'), true)
  for (const fragment of ['A paragraph with {notAnExpression}', 'const value = { nested: true }', '<div data-html="kept">Raw HTML</div>']) {
    assert.ok(body.includes(fragment), `the Markdown body lost ${fragment}`)
  }

  // A text line that merely looks like a configured component is not executed
  // and does not make the document unparseable.
  const looksLikeJsx = '# Markdown\n\n<Hero cmsId="x" title={dynamic} />\n'
  assert.deepEqual(adapter.inspect(looksLikeJsx).blocks, [])
})

test('a Markdown draft keeps generated blocks in an explicitly marked zone and edits only them', async () => {
  const source = '# Markdown\n\nA paragraph that survives — 東京.\n'
  const adapter = createMdxBlocksAdapter({ blockTypes, format: 'md' })
  const added = adapter.patch(source, { action: 'add', blockType: 'hero', values: { title: 'Trusted' } }, adapter.inspect(source).hash, 'hero-one')
  assert.match(added.source, /^<!-- astro-visual-cms:blocks:start -->\n<Hero cmsId="hero-one" title="Trusted" tone="light" \/>\n<!-- astro-visual-cms:blocks:end -->\n# Markdown/)
  assert.ok(added.source.endsWith('A paragraph that survives — 東京.\n'))
  const described = adapter.describe(added.source)
  assert.deepEqual(described.blocks, [{
    id: 'hero-one', type: 'hero', label: 'Hero', componentName: 'Hero', importSource: '../components/Hero.astro',
    markup: '<Hero cmsId="hero-one" title="Trusted" tone="light" />',
  }])
  assert.equal(added.source.slice(described.bodyStart), '# Markdown\n\nA paragraph that survives — 東京.\n')

  const set = adapter.patch(added.source, { action: 'set', blockId: 'hero-one', prop: 'title', value: 'Edited' }, adapter.inspect(added.source).hash)
  assert.match(set.source, /<Hero cmsId="hero-one" title="Edited" tone="light" \/>/)
  assert.ok(set.source.endsWith('A paragraph that survives — 東京.\n'))

  const second = adapter.patch(set.source, { action: 'add', blockType: 'callout', values: {} }, adapter.inspect(set.source).hash, 'callout-one')
  assert.deepEqual(adapter.inspect(second.source).blocks.map(({ id }) => id), ['hero-one', 'callout-one'])
  const moved = adapter.patch(second.source, { action: 'move', blockId: 'callout-one', delta: -1 }, adapter.inspect(second.source).hash)
  assert.deepEqual(adapter.inspect(moved.source).blocks.map(({ id }) => id), ['callout-one', 'hero-one'])
  const removed = adapter.patch(moved.source, { action: 'remove', blockId: 'callout-one' }, adapter.inspect(moved.source).hash)
  assert.deepEqual(adapter.inspect(removed.source).blocks.map(({ id }) => id), ['hero-one'])
  // The Markdown body stays byte-identical through every block operation.
  assert.equal(removed.source.slice(adapter.describe(removed.source).bodyStart), '# Markdown\n\nA paragraph that survives — 東京.\n')
})

test('the editor marker is the only Markdown ownership signal, not a leading JSX-looking line', () => {
  const adapter = createMdxBlocksAdapter({ blockTypes, format: 'md' })
  // This is raw HTML in a saved `.md` page: it must not become a component and
  // must not become an editable block merely because the name is configured.
  const source = [
    '---',
    'title: Leading HTML',
    '---',
    '',
    '<Hero cmsId="user-authored" title="Literal HTML" tone="light" />',
    '',
    '# Body',
    '',
  ].join('\n')
  const described = adapter.describe(source)
  assert.deepEqual(described.blocks, [])
  assert.deepEqual(adapter.inspect(source).blocks, [])
  assert.equal(source.slice(described.bodyStart), '\n<Hero cmsId="user-authored" title="Literal HTML" tone="light" />\n\n# Body\n')

  const added = adapter.patch(source, { action: 'add', blockType: 'hero', values: { title: 'Editor-owned' } }, adapter.inspect(source).hash, 'editor-one')
  assert.match(added.source, /<!-- astro-visual-cms:blocks:start -->/)
  assert.ok(added.source.includes('<Hero cmsId="user-authored" title="Literal HTML" tone="light" />'), 'pre-existing raw HTML must be preserved')
  assert.deepEqual(adapter.inspect(added.source).blocks.map(({ id }) => id), ['editor-one'])
  assert.ok(adapter.describe(added.source).bodyStart <= added.source.indexOf('<Hero cmsId="user-authored"'))
})

test('ambiguous content inside or a missing end marker fails the Markdown target closed', () => {
  const adapter = createMdxBlocksAdapter({ blockTypes, format: 'md' })
  const source = '<!-- astro-visual-cms:blocks:start -->\nimport Hero from "../components/Hero.astro"\n\n<Hero cmsId="one" title="Valid" />\n\n<Hero cmsId="two" title={notStatic} />\n<!-- astro-visual-cms:blocks:end -->\n\n# Body\n'
  assert.throws(() => adapter.inspect(source), { code: 'UNSUPPORTED_MARKDOWN_BLOCK_ZONE' })
  const unclosed = '<!-- astro-visual-cms:blocks:start -->\nimport Hero from "../components/Hero.astro"\n\n<Hero cmsId="one" title="Valid" />\n\n# Body\n'
  assert.throws(() => adapter.inspect(unclosed), { code: 'UNSUPPORTED_MARKDOWN_BLOCK_ZONE' })
  const misplaced = '# Body first\n\n<!-- astro-visual-cms:blocks:start -->\n<Hero cmsId="one" title="Valid" />\n<!-- astro-visual-cms:blocks:end -->\n'
  assert.throws(() => adapter.inspect(misplaced), { code: 'UNSUPPORTED_MARKDOWN_BLOCK_ZONE' })
  // Once the invalid line is outside the marker, it is ordinary Markdown again.
  const outside = '<!-- astro-visual-cms:blocks:start -->\n<Hero cmsId="one" title="Valid" />\n<!-- astro-visual-cms:blocks:end -->\n\n<Hero cmsId="two" title={notStatic} />\n'
  assert.deepEqual(adapter.inspect(outside).blocks.map(({ id }) => id), ['one'])
})

test('a Markdown candidate with props outside the catalog stays ordinary Markdown', () => {
  const md = createMdxBlocksAdapter({ blockTypes, format: 'md' })
  for (const line of [
    '<Hero cmsId="one" title="A" className="extra" />',
    '<Hero cmsId="one" title="A" onClick={run()} />',
    '<Hero cmsId="one" title="A" dangerouslySetInnerHTML={{ __html: "<b>x</b>" }} />',
  ]) {
    const source = `import Hero from "../components/Hero.astro"\n\n${line}\n\n# Body\n`
    assert.deepEqual(md.inspect(source).blocks, [], `unexpected block for ${line}`)
    assert.ok(md.describe(source).bodyStart <= source.indexOf(line), 'the unvalidated call must stay in the Markdown body')
  }
  const generated = md.patch('# Body\n', { action: 'add', blockType: 'hero', values: { title: 'Catalog only' } }, md.inspect('# Body\n').hash, 'hero-ok')
  assert.deepEqual(md.inspect(generated.source).blocks.map(({ id }) => id), ['hero-ok'])
})
