import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createMdxBlocksAdapter } from '../src/lib/mdx-blocks.mjs'
import { assertMarkdownPreviewSource, buildMarkdownPreviewModule, splitMarkdownFrontmatter } from '../src/editor/markdown-preview.mjs'
import { devCssModuleId } from '../src/editor/mdx-block-preview.mjs'

const blockTypes = [{
  type: 'card', label: 'Card', componentName: 'Card', importSource: '../components/Card.astro', idProp: 'id',
  fields: [{ name: 'title', type: 'string', required: true }],
}]

function adapter() {
  return createMdxBlocksAdapter({ blockTypes, format: 'md' })
}

test('frontmatter is parsed, normalized and validated without reusing its YAML source', () => {
  const { value, bodyStart } = splitMarkdownFrontmatter('---\ntitle: "Dash --- inside"\nlayout: ../layouts/Post.astro\n---\n\n# Body\n')
  assert.deepEqual(value, { title: 'Dash --- inside', layout: '../layouts/Post.astro' })
  assert.equal('---\ntitle: "Dash --- inside"\nlayout: ../layouts/Post.astro\n---\n\n# Body\n'.slice(bodyStart), '\n# Body\n')

  assert.deepEqual(splitMarkdownFrontmatter('# No frontmatter\n'), { value: {}, bodyStart: 0 })
  assert.deepEqual(splitMarkdownFrontmatter('---\n---\n\nBody\n').value, {})
  assert.throws(() => splitMarkdownFrontmatter('---\ntitle: [unclosed\n---\n'), { code: 'UNSUPPORTED_FRONTMATTER' })
  assert.throws(() => splitMarkdownFrontmatter('---\n- a\n- b\n---\n'), { code: 'UNSUPPORTED_FRONTMATTER' })
  assert.throws(() => splitMarkdownFrontmatter('---\nlayout: 12\n---\n'), { code: 'UNSUPPORTED_FRONTMATTER' })
})

test('a Markdown draft is rendered by the Markdown renderer and only catalog blocks become components', async () => {
  const markdownAdapter = adapter()
  const source = [
    '---',
    'title: "Review — 東京"',
    'layout: ../layouts/Post.astro',
    '---',
    '',
    '<!-- astro-visual-cms:blocks:start -->',
    'import Card from "../components/Card.astro"',
    '',
    '<Card id="draft" title="Trusted title" />',
    '<!-- astro-visual-cms:blocks:end -->',
    '',
    'import { writeFileSync } from "node:fs"',
    '',
    '# Heading',
    '',
    'A {writeFileSync("/tmp/never", "expression")} and <Card id="untrusted" /> stay text.',
    '',
    'export const pwned = writeFileSync("/tmp/never", "esm")',
    '',
    '<div data-html="kept">Raw HTML</div>',
    '',
    '```js',
    'const literal = { nested: true }',
    '```',
    '',
  ].join('\n')
  const described = markdownAdapter.describe(source)
  assert.deepEqual(described.blocks.map(({ id }) => id), ['draft'])
  const body = source.slice(described.bodyStart)
  let receivedBody = null
  let receivedFrontmatter = null
  const generated = await buildMarkdownPreviewModule({
    source,
    adapter: markdownAdapter,
    filePath: '/project/src/pages/blocks.md',
    url: '/blocks/',
    renderMarkdown: async (content, options) => {
      receivedBody = content
      receivedFrontmatter = options.frontmatter
      return {
        code: `<h1 id="heading">Heading</h1><p>${content.length} bytes</p>`,
        metadata: {
          headings: [{ depth: 1, slug: 'heading', text: 'Heading' }],
          // A plugin may replace page metadata after the raw YAML was read.
          frontmatter: { ...options.frontmatter, title: 'Transformed by plugin', readingTime: 3 },
        },
      }
    },
  })
  assert.equal(receivedBody, body, 'the renderer receives the untouched Markdown body, not the generated block zone')
  assert.ok(receivedBody.includes('{writeFileSync("/tmp/never", "expression")}'))
  assert.ok(receivedBody.includes('export const pwned = writeFileSync'))
  assert.deepEqual(receivedFrontmatter, { title: 'Review — 東京', layout: '../layouts/Post.astro' })

  assert.match(generated, /^---\nimport Card from "\.\.\/components\/Card\.astro"\nimport AvcmsLayout from "\.\.\/layouts\/Post\.astro"/)
  assert.match(generated, /export const frontmatter = \{"title":"Transformed by plugin","layout":"\.\.\/layouts\/Post\.astro","readingTime":3\}/)
  assert.match(generated, /"readingTime":3,"file":/)
  assert.match(generated, /const __avcmsContent = \{"title":"Transformed by plugin","readingTime":3,"file":/)
  assert.match(generated, /<Card id="draft" title="Trusted title" \/>/)
  assert.match(generated, /<Fragment set:html=\{__avcmsHtml\} \/>/)
  assert.match(generated, /<AvcmsLayout /)
  // The untrusted Markdown only appears inside serialized data strings, never as
  // module statements of its own.
  assert.doesNotMatch(generated, /^import \{ writeFileSync \}/m)
  assert.doesNotMatch(generated, /^export const pwned/m)
  assert.doesNotMatch(generated, /^<div data-html/m)
  assert.ok(generated.includes('export const pwned = writeFileSync'), 'the body stays byte-identical inside the serialized HTML/body strings')
})

test('a layout-less Markdown preview emits the same head as Astro’s own .md page', async () => {
  const generated = await buildMarkdownPreviewModule({
    source: '# Markdown\n\nBody paragraph.\n',
    adapter: adapter(),
    filePath: '/project/src/pages/blocks.md',
    url: '/blocks/',
    renderMarkdown: async () => ({ code: '<h1>Markdown</h1>', metadata: { headings: [], frontmatter: {} } }),
  })
  assert.match(generated, /import \{ maybeRenderHead, spreadAttributes \} from "astro\/runtime\/server\/index\.js"/)
  assert.match(generated, /<meta charset="utf-8" \/>\n\{maybeRenderHead\(\)\}\n<Fragment set:html=\{__avcmsHtml\} \/>/)
  assert.doesNotMatch(generated, /<AvcmsLayout /)
})

test('a targeted Markdown image keeps its Astro image semantics through the generated module', async () => {
  const markdownAdapter = adapter()
  const source = '# Image\n\n![pixel](../assets/pixel.png)\n\n![remote](https://example.com/pixel.png)\n'
  const generated = await buildMarkdownPreviewModule({
    source,
    adapter: markdownAdapter,
    filePath: '/project/src/pages/blocks.md',
    url: '/blocks/',
    renderMarkdown: async () => ({
      code: '<p><img __ASTRO_IMAGE_="{&quot;alt&quot;:&quot;pixel&quot;,&quot;src&quot;:&quot;../assets/pixel.png&quot;,&quot;index&quot;:0}">'
        + '<img __ASTRO_IMAGE_="{&quot;alt&quot;:&quot;remote&quot;,&quot;src&quot;:&quot;https://example.com/pixel.png&quot;,&quot;inferSize&quot;:true,&quot;index&quot;:0}"></p>',
      metadata: { headings: [], frontmatter: {} },
    }),
  })
  assert.match(generated, /import __avcmsImageImport0 from "\.\.\/assets\/pixel\.png"/)
  assert.match(generated, /getImage\(\{ src: __avcmsImageImport0/)
  assert.match(generated, /getImage\(\{ src: "https:\/\/example\.com\/pixel\.png", "alt": "remote", "inferSize": true/)
  assert.match(generated, /spreadAttributes\(\{ src: __avcmsImage0\.src/)
  assert.match(generated, /\.replace\("__avcms_image_[a-f0-9]+_0__", \(\) => __avcmsImageAttrs0\)/)
  assert.doesNotMatch(generated, /__ASTRO_IMAGE_/)
  assert.match(generated, /export async function compiledContent\(\)/)
  assert.match(generated, /const __avcmsImage0 = await getImage/)
})

test('unsafe or unrepresentable Markdown previews fail closed', async () => {
  const markdownAdapter = adapter()
  assert.throws(() => assertMarkdownPreviewSource('# Markdown\n', { adapter: {} }), { code: 'UNSUPPORTED_FORMAT' })
  const source = '# Markdown\n'
  await assert.rejects(buildMarkdownPreviewModule({
    source, adapter: markdownAdapter, filePath: '/project/src/pages/blocks.md', url: '/blocks/',
    renderMarkdown: async () => { throw new Error('renderer exploded') },
  }), { code: 'UNSUPPORTED_MARKDOWN' })
  await assert.rejects(buildMarkdownPreviewModule({
    source, adapter: markdownAdapter, filePath: '/project/src/pages/blocks.md', url: '/blocks/',
    renderMarkdown: async () => ({ code: '<img __ASTRO_IMAGE_="{not json}">', metadata: { frontmatter: {} } }),
  }), { code: 'UNSUPPORTED_MARKDOWN' })
  await assert.rejects(buildMarkdownPreviewModule({
    source, adapter: markdownAdapter, filePath: '/project/src/pages/blocks.md', url: '/blocks/',
    renderMarkdown: async () => ({ code: '<img __ASTRO_IMAGE_="{&quot;alt&quot;:&quot;no source&quot;,&quot;index&quot;:0}">', metadata: { frontmatter: {} } }),
  }), { code: 'UNSUPPORTED_MARKDOWN' })
})

test('a Markdown processor that omits final metadata fails the preview closed', async () => {
  const markdownAdapter = adapter()
  const source = '# Markdown\n'
  await assert.rejects(buildMarkdownPreviewModule({
    source, adapter: markdownAdapter, filePath: '/project/src/pages/blocks.md', url: '/blocks/',
    renderMarkdown: async () => ({ code: '<h1>Markdown</h1>', metadata: { headings: [] } }),
  }), { code: 'UNSUPPORTED_MARKDOWN_METADATA' })
  await assert.rejects(buildMarkdownPreviewModule({
    source, adapter: markdownAdapter, filePath: '/project/src/pages/blocks.md', url: '/blocks/',
    renderMarkdown: async () => ({ code: '<h1>Markdown</h1>', metadata: { headings: [], frontmatter: { layout: 12 } } }),
  }), { code: 'UNSUPPORTED_MARKDOWN_METADATA' })
  await assert.rejects(buildMarkdownPreviewModule({
    source, adapter: markdownAdapter, filePath: '/project/src/pages/blocks.md', url: '/blocks/',
    renderMarkdown: async () => ({ code: '<h1>Markdown</h1>', metadata: { headings: [], frontmatter: undefined } }),
  }), { code: 'UNSUPPORTED_MARKDOWN_METADATA' })
})

test('the dev CSS collector id tracks the route component path', () => {
  assert.equal(
    devCssModuleId('/project', '/project/src/pages/blocks.md'),
    '\0virtual:astro:dev-css:src/pages/blocks@_@md',
  )
  assert.equal(
    devCssModuleId('/project', '/project/src/pages/blocks.mdx'),
    '\0virtual:astro:dev-css:src/pages/blocks@_@mdx',
  )
  assert.equal(devCssModuleId('/project', '/project/src/pages/plain'), null)
  assert.equal(devCssModuleId(path.sep ? '/project' : '', `/project${path.sep}src${path.sep}pages${path.sep}blocks.md`), '\0virtual:astro:dev-css:src/pages/blocks@_@md')
})
