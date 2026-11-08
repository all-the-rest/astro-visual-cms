import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planCollectionCreation } from '../src/editor/collection-discovery.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ASTRO_CLI = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url))
const TSC_CLI = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const ASTRO_PACKAGE = JSON.parse(await readFile(new URL('../node_modules/astro/package.json', import.meta.url), 'utf8'))
assert.equal(ASTRO_PACKAGE.version, '7.4.7', 'This acceptance gate is pinned to the verified Astro version.')
const TYPESCRIPT_PACKAGE = JSON.parse(await readFile(new URL('../node_modules/typescript/package.json', import.meta.url), 'utf8'))
assert.equal(TYPESCRIPT_PACKAGE.version, '6.0.3', 'This acceptance gate uses its pinned TypeScript compiler.')
const ORIGINAL_CONFIG = `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = {};
`
const hash = createHash('sha256').update(ORIGINAL_CONFIG).digest('hex')
const planned = planCollectionCreation(ORIGINAL_CONFIG, {
  name: 'acceptanceNotes', base: './src/content/acceptanceNotes', pattern: '**/*.md',
  fields: [
    { name: 'title', type: 'string' },
    { name: 'kind', type: 'enum', values: ['guide', 'reference'] },
    { name: 'published', type: 'boolean', optional: true, default: true },
  ], expectedHash: hash,
})

assert.throws(() => planCollectionCreation(ORIGINAL_CONFIG, {
  name: 'invalidNotes', base: './src/content/invalidNotes', pattern: '**/*.md',
  fields: [{ name: 'count', type: 'number', default: 'not-a-number' }], expectedHash: hash,
}), { code: 'UNSUPPORTED_COLLECTION_EDIT' })

const appRoot = await mkdtemp(path.join(os.tmpdir(), 'astro-collection-sync-'))
try {
  await mkdir(path.join(appRoot, 'src/content/acceptanceNotes'), { recursive: true })
  await mkdir(path.join(appRoot, 'src/pages'), { recursive: true })
  await symlink(path.join(REPOSITORY_ROOT, 'node_modules'), path.join(appRoot, 'node_modules'), 'dir')
  await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(path.join(appRoot, 'astro.config.mjs'), `import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n`)
  await writeFile(path.join(appRoot, 'src/pages/index.astro'), `---
import { getCollection } from 'astro:content';
const [entry] = await getCollection('acceptanceNotes');
if (!entry || typeof entry.data.title !== 'string' || !['guide', 'reference'].includes(entry.data.kind) || entry.data.published !== true) {
  throw new Error('Astro returned invalid inferred collection data.');
}
---
<html><body><p data-title={entry.data.title} data-kind={entry.data.kind} data-published={String(entry.data.published)}>{entry.data.title}</p></body></html>
`)
  await writeFile(path.join(appRoot, 'src/content.config.ts'), planned.source)
  await writeFile(path.join(appRoot, 'src/content/acceptanceNotes/example.md'), `---\ntitle: Synthetic entry\nkind: guide\n---\nContent Sync acceptance fixture.\n`)

  const result = spawnSync(process.execPath, [ASTRO_CLI, 'sync'], {
    cwd: appRoot, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Astro Content Sync exited with ${result.status ?? 'unknown'}.`)
  const generated = await readFile(path.join(appRoot, '.astro/content.d.ts'), 'utf8')
  assert.match(generated, /acceptanceNotes/, 'Generated Astro content types must include the planned collection key.')
  assert.match(generated, /InferEntrySchema<"acceptanceNotes">/, 'Generated content declarations must infer entry data from the generated config.')
  await writeFile(path.join(appRoot, 'src/content-type-check.ts'), `
import type { CollectionEntry } from 'astro:content';
declare const entry: CollectionEntry<'acceptanceNotes'>;
const title: string = entry.data.title;
const kind: 'guide' | 'reference' = entry.data.kind;
const published: boolean = entry.data.published;
// @ts-expect-error the generated schema must reject non-string titles
const wrongTitle: number = entry.data.title;
// @ts-expect-error the enum must remain the declared literal union
const wrongKind: 'other' = entry.data.kind;
// @ts-expect-error the defaulted boolean must not be inferred as a string
const wrongPublished: string = entry.data.published;
void [title, kind, published, wrongTitle, wrongKind, wrongPublished];
`)
  const typecheck = spawnSync(process.execPath, [TSC_CLI, '--noEmit', '--strict', '--skipLibCheck', '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'esnext', '--lib', 'esnext,dom', 'src/content-type-check.ts', '.astro/types.d.ts', '.astro/content.d.ts'], {
    cwd: appRoot, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  })
  if (typecheck.stdout) process.stdout.write(typecheck.stdout)
  if (typecheck.stderr) process.stderr.write(typecheck.stderr)
  if (typecheck.error) throw typecheck.error
  assert.equal(typecheck.status, 0, `Generated collection TypeScript checks exited with ${typecheck.status ?? 'unknown'}.`)
  const build = spawnSync(process.execPath, [ASTRO_CLI, 'build'], {
    cwd: appRoot, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  })
  if (build.stdout) process.stdout.write(build.stdout)
  if (build.stderr) process.stderr.write(build.stderr)
  if (build.error) throw build.error
  assert.equal(build.status, 0, `Astro build exited with ${build.status ?? 'unknown'}.`)
  const html = await readFile(path.join(appRoot, 'dist/index.html'), 'utf8')
  assert.match(html, /data-title="Synthetic entry"/)
  assert.match(html, /data-kind="guide"/)
  assert.match(html, /data-published="true"/, 'Astro must apply the configured default to missing frontmatter.')
  console.log('Verified planner-generated static collection with Astro 7.4.7 Content Sync, generated field types and build.')
} finally {
  await rm(appRoot, { recursive: true, force: true })
}
