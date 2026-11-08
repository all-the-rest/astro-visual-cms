import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  discoverContentCollections,
  patchFrontmatterField,
  planCollectionCreation,
  planCollectionFieldExtension,
} from '../src/editor/collection-discovery.mjs'

const fixture = `
import { defineCollection as define } from 'astro:content'
import { glob as files } from 'astro/loaders'
import { z } from 'astro:content'
const runtimeMustNotRun = () => { throw new Error('evaluated config') }
export const collections = {
  posts: define({ loader: files({ base: './src/content/posts', pattern: '**/*.md' }), schema: z.object({
    title: z.string(), count: z.number().optional(), published: z.boolean().default(false),
    category: z.enum(['news', 'notes']), tags: z.array(z.string()), created: z.date(),
  }) }),
  oldPosts: define({ type: 'content' }),
  remote: define({ loader: createRemoteLoader() }),
  shared: define({ loader: files({ base: './content', pattern: '**/*.md' }), schema: importedSchema }),
}
`

test('discovers static glob collections and a bounded literal Zod field subset without evaluating source', () => {
  const result = discoverContentCollections(fixture)
  assert.equal(result.supported, true)
  const posts = result.collections.find((item) => item.name === 'posts')
  assert.deepEqual({ loader: posts.loader, base: posts.base, patterns: posts.patterns }, {
    loader: 'glob', base: './src/content/posts', patterns: ['**/*.md'],
  })
  assert.deepEqual(posts.fields.map(({ name, type, required, default: value, values }) => ({ name, type, required, default: value, values })), [
    { name: 'title', type: 'string', required: true, default: undefined, values: undefined },
    { name: 'count', type: 'number', required: false, default: undefined, values: undefined },
    { name: 'published', type: 'boolean', required: false, default: false, values: undefined },
    { name: 'category', type: 'enum', required: true, default: undefined, values: ['news', 'notes'] },
    { name: 'tags', type: 'array<string>', required: true, default: undefined, values: undefined },
    { name: 'created', type: 'date', required: true, default: undefined, values: undefined },
  ])
  assert.equal(result.collections.find((item) => item.name === 'oldPosts').mode, 'read-only')
  for (const name of ['remote', 'shared']) {
    assert.equal(result.collections.find((item) => item.name === name).supported, false)
    assert.equal(result.collections.find((item) => item.name === name).mode, 'read-only')
  }
})

test('resolves immutable top-level defineCollection bindings and patches their schema safely', () => {
  const source = `import { defineCollection as define } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
const shows = define({ loader: glob({ base: './src/content/shows', pattern: '**/*.md' }), schema: z.object({ title: z.string(), order: z.number() }) });
const referenzen = define({ loader: glob({ base: './src/content/referenzen', pattern: '**/*.md' }), schema: z.object({ event: z.string(), year: z.number() }) });
export const collections = { shows, referenzen };
`
  const result = discoverContentCollections(source)
  assert.equal(result.supported, true)
  assert.deepEqual(result.collections.map(({ name, supported, mode, fields }) => ({ name, supported, mode, fields: fields.map(({ name, type }) => ({ name, type })) })), [
    { name: 'shows', supported: true, mode: 'static-fields-read-only', fields: [{ name: 'title', type: 'string' }, { name: 'order', type: 'number' }] },
    { name: 'referenzen', supported: true, mode: 'static-fields-read-only', fields: [{ name: 'event', type: 'string' }, { name: 'year', type: 'number' }] },
  ])

  const expectedHash = createHash('sha256').update(source).digest('hex')
  const plan = planCollectionFieldExtension(source, {
    collection: 'referenzen', field: { name: 'land', type: 'string' }, expectedHash,
  })
  assert.match(plan.source, /const referenzen = define\([\s\S]*?land.*z\.string\(\)/)
  assert.deepEqual(discoverContentCollections(plan.source).collections.find(({ name }) => name === 'referenzen').fields.map(({ name }) => name), ['event', 'year', 'land'])

  for (const unsafe of [
    source.replace('const referenzen =', 'let referenzen ='),
    source.replace('const referenzen = define', 'export const referenzen = define'),
    source.replace('export const collections', 'referenzen.schema = makeSchema();\nexport const collections'),
    source.replace('export const collections = { shows, referenzen }', 'export const collections = { shows, referenzen, duplicate: referenzen }'),
  ]) {
    const unsupportedCollection = discoverContentCollections(unsafe).collections.find(({ name }) => name === 'referenzen')
    assert.equal(unsupportedCollection.supported, false)
    assert.equal(unsupportedCollection.mode, 'read-only')
  }
})

test('reports dynamic glob/schema, refinements, spreads, and invalid config as read-only', () => {
  const source = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
    const root = './content'; export const collections = {
      dynamic: defineCollection({ loader: glob({ base: root, pattern: '**/*.md' }), schema: z.object({ title: z.string() }) }),
      refined: defineCollection({ loader: glob({ base: './content', pattern: '**/*.md' }), schema: z.object({ title: z.string().transform(x => x) }) }),
      spread: defineCollection({ loader: glob({ ...options }), schema: z.object({ title: z.string() }) }),
      traversal: defineCollection({ loader: glob({ base: '../private', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) }),
    }`
  const result = discoverContentCollections(source)
  assert.equal(result.collections.length, 4)
  assert.ok(result.collections.every((item) => item.supported === false && item.mode === 'read-only' && item.reason))
  assert.deepEqual(discoverContentCollections('export const collections = makeCollections()'), {
    supported: false, collections: [], reason: 'Expected one exported literal collections object; dynamic configuration is read-only.',
  })
})

test('rejects Windows absolute bases, prototype keys, extra config behavior, nested arrays, and mismatched defaults', () => {
  const source = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export const collections = {
    windows: defineCollection({ loader: glob({ base: 'C:/private', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) }),
    extra: defineCollection({ loader: glob({ base: './content', pattern: '**/*.md' }), schema: z.object({ title: z.string() }), extra: sideEffect() }),
    args: defineCollection({ loader: glob({ base: './content', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) }, sideEffect()),
    nested: defineCollection({ loader: glob({ base: './content', pattern: '**/*.md' }), schema: z.object({ title: z.array(z.array(z.string())) }) }),
    badDefault: defineCollection({ loader: glob({ base: './content', pattern: '**/*.md' }), schema: z.object({ title: z.number().default('oops') }) }),
  }`
  const result = discoverContentCollections(source)
  assert.equal(result.collections.length, 5)
  assert.ok(result.collections.every((item) => item.supported === false && item.mode === 'read-only'))
  assert.equal(discoverContentCollections(`import { defineCollection } from 'astro:content'; export const collections = { '__proto__': defineCollection({ loader: 1 }) }`).supported, false)
  assert.equal(discoverContentCollections(`import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content'; export const collections = { x: defineCollection({ loader: glob({ base:'./x',pattern:'*.md' }), schema:z.object({ '__proto__': z.string() }) }) }`).collections[0].supported, false)
})

test('requires an immutable, unreferenced collections binding and normalizes numeric field keys', () => {
  const mutable = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export let collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({ title: z.string() }) }) };
  collections = { remote: makeCollection() }`
  assert.equal(discoverContentCollections(mutable).supported, false)
  const referenced = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export const collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({ 1: z.string() }) }) };
  inspect(collections)`
  const result = discoverContentCollections(referenced)
  assert.equal(result.supported, false)
  const numericField = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export const collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({ 1: z.string() }) }) }`
  assert.equal(discoverContentCollections(numericField).collections[0].fields[0].name, '1')
})

test('ignores type-only imports, keeps the outermost Zod default, and accepts finite negative literals', () => {
  const typeOnly = `import type { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export const collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({ title: z.string() }) }) }`
  assert.equal(discoverContentCollections(typeOnly).collections[0].supported, false)
  const source = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export const collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({
    title: z.string().default('inner').default('outer'), count: z.number().default(-1), optionalDefault: z.string().default('hidden').optional(),
  }) }) }`
  const fields = discoverContentCollections(source).collections[0].fields
  assert.deepEqual(fields.map(({ name, default: value }) => [name, value]), [['title', 'outer'], ['count', -1], ['optionalDefault', undefined]])
  const expectedHash = createHash('sha256').update(source).digest('hex')
  const created = planCollectionCreation(source, {
    name: 'notes', base: './notes', pattern: '*.md', fields: [{ name: 'count', type: 'number', default: -1 }], expectedHash,
  })
  assert.equal(discoverContentCollections(created.source).collections.find((item) => item.name === 'notes').fields[0].default, -1)
})

test('diff planners keep trailing line comments and blank lines outside inserted syntax', () => {
  const schemaComment = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
export const collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({ title: z.string() // keep schema note

}) }) }
`
  const schemaWithWhitespaceBlank = schemaComment.replace('schema note\n\n})', 'schema note\n  \n})')
  const schemaHash = createHash('sha256').update(schemaWithWhitespaceBlank).digest('hex')
  const extension = planCollectionFieldExtension(schemaWithWhitespaceBlank, {
    collection: 'posts', field: { name: 'published', type: 'boolean' }, expectedHash: schemaHash,
  })
  assert.ok(extension.source.includes('title: z.string(), // keep schema note'))
  assert.ok(extension.source.includes('"published": z.boolean()'))
  assert.match(discoverContentCollections(extension.source).collections[0].fields.map((field) => field.name).join(','), /title,published/)

  const collectionComment = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
export const collections = { posts: defineCollection({ loader: glob({ base: './posts', pattern: '*.md' }), schema: z.object({ title: z.string() }) }) // keep collection note

}
`
  const collectionWithWhitespaceBlank = collectionComment.replace('collection note\n\n}', 'collection note\n  \n}')
  const collectionHash = createHash('sha256').update(collectionWithWhitespaceBlank).digest('hex')
  const creation = planCollectionCreation(collectionWithWhitespaceBlank, {
    name: 'notes', base: './notes', pattern: '*.md', fields: [{ name: 'title', type: 'string' }], expectedHash: collectionHash,
  })
  assert.ok(creation.source.includes('}) }), // keep collection note'))
  assert.ok(creation.source.includes('"notes": defineCollection'))
  assert.equal(discoverContentCollections(creation.source).collections.find((item) => item.name === 'notes').supported, true)
})

test('frontmatter patch changes only one supported scalar and preserves comments, CRLF, BOM, and Unicode', () => {
  const source = '\uFEFF---\r\ntitle: "Café" # keep this comment\r\ntags: [one, two]\r\n---\r\n正文\r\n'
  const hash = createHash('sha256').update(source).digest('hex')
  const result = patchFrontmatterField(source, { name: 'title', type: 'string' }, 'Résumé', hash)
  assert.equal(result.source, source.replace('"Café"', '"Résumé"'))
  assert.deepEqual(result.diff, { start: source.indexOf('"Café"'), end: source.indexOf('"Café"') + 6, before: '"Café"', after: '"Résumé"' })
  assert.equal(createHash('sha256').update(result.source).digest('hex'), result.hash)
  const noop = patchFrontmatterField(source, { name: 'title', type: 'string' }, 'Café', hash)
  assert.equal(noop.source, source)
  assert.equal(noop.hash, hash)
  assert.equal(noop.diff, null)
})

test('frontmatter edits reject stale hashes, type mismatches, duplicates, aliases, collections, and missing fields', () => {
  const patch = (source, field = { name: 'title', type: 'string' }, value = 'new') =>
    patchFrontmatterField(source, field, value, createHash('sha256').update(source).digest('hex'))
  assert.throws(() => patchFrontmatterField('---\ntitle: old\n---\n', { name: 'title', type: 'string' }, 'new', '0'.repeat(64)), { code: 'STALE_HASH' })
  assert.throws(() => patch('---\ntitle: old\n---\n', { name: 'title', type: 'number' }, 'bad'), { code: 'INVALID_FIELD_VALUE' })
  assert.throws(() => patch('---\ntitle: old\n---\n', { name: 'title', type: 'date' }, '2026-01-01'), { code: 'UNSUPPORTED_FIELD_TYPE' })
  assert.throws(() => patch('---\ntitle: old\n---\n', { name: 'published', type: 'date' }, '2026-01-01'), { code: 'UNSUPPORTED_FIELD_TYPE' })
  for (const source of [
    '---\ntitle: one\ntitle: two\n---\n',
    '---\ntitle: &value one\nother: *value\n---\n',
    '---\ntitle: !custom value\n---\n',
    '---\ntitle: valid\ntags: [&a one, *a]\n---\n',
    '---\ntitle: valid\ntags: [!custom one]\n---\n',
    '---\ntitle:\n  nested: value\n---\n',
    '---\ntitle: |\n  multiline\n---\n',
    '---\nother: value\n---\n',
  ]) assert.throws(() => patch(source), { code: 'UNSUPPORTED_FRONTMATTER' })
})

test('duplicate static collection, loader, and schema keys are explicitly unsupported', () => {
  const source = `import { defineCollection } from 'astro:content'; import { glob } from 'astro/loaders'; import { z } from 'astro:content';
  export const collections = { posts: defineCollection({ loader: glob({ base: './a', base: './b', pattern: '**/*.md' }), schema: z.object({ title: z.string(), title: z.number() }) }) }`
  const result = discoverContentCollections(source)
  assert.equal(result.collections[0].supported, false)
  assert.match(result.collections[0].reason, /literal object/)
})

test('collection creation and schema extension produce validated diff-only plans', () => {
  const source = `import { defineCollection as dc, z as schema } from 'astro:content';
import { glob as files } from 'astro/loaders';
export const collections = { posts: dc({ loader: files({ base: './content', pattern: '**/*.md' }), schema: schema.object({ title: schema.string() }) }) }
`
  const expectedHash = createHash('sha256').update(source).digest('hex')
  const extension = planCollectionFieldExtension(source, {
    collection: 'posts', field: { name: 'published', type: 'boolean', default: false }, expectedHash,
  })
  assert.equal(extension.expectedHash, expectedHash)
  assert.equal(extension.diff.before, '')
  assert.match(extension.diff.after, /published.*schema\.boolean\(\)\.default\(false\)/)
  assert.equal(discoverContentCollections(extension.source).collections[0].fields.length, 2)

  const creation = planCollectionCreation(source, {
    name: 'notes', base: './content/notes', pattern: '**/*.md', fields: [
      { name: 'title', type: 'string' }, { name: 'kind', type: 'enum', values: ['one', 'two'], optional: true },
    ], expectedHash,
  })
  const created = discoverContentCollections(creation.source).collections.find((item) => item.name === 'notes')
  assert.equal(created.supported, true)
  assert.deepEqual(created.fields.map(({ name, type }) => ({ name, type })), [
    { name: 'title', type: 'string' }, { name: 'kind', type: 'enum' },
  ])
  assert.throws(() => planCollectionCreation(source, {
    name: 'bad', base: '../outside', pattern: '**/*.md', fields: [{ name: 'title', type: 'string' }], expectedHash,
  }), { code: 'UNSUPPORTED_COLLECTION_EDIT' })
  for (const bad of [
    { name: '__proto__', base: './content', pattern: '*.md', fields: [{ name: 'title', type: 'string' }] },
    { name: 'badPath', base: 'C:/private', pattern: '*.md', fields: [{ name: 'title', type: 'string' }] },
    { name: 'badField', base: './content', pattern: '*.md', fields: [{ name: '__proto__', type: 'string' }] },
    { name: 'badDefault', base: './content', pattern: '*.md', fields: [{ name: 'count', type: 'number', default: 'oops' }] },
  ]) assert.throws(() => planCollectionCreation(source, { ...bad, expectedHash }), { code: 'UNSUPPORTED_COLLECTION_EDIT' })
})
