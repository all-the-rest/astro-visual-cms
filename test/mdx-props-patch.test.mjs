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

test('rejects stale hashes and unknown props', () => {
  const { hash } = adapter.inspect(source)
  assert.throws(() => adapter.patch(source, 'one', 'title', 'New', '0'.repeat(64)), { code: 'STALE_HASH' })
  assert.throws(() => adapter.inspect(source.replace(' title="Old"', ' other="x"')))
  assert.equal(hash.length, 64)
})
