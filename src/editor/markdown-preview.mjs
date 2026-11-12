import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

/**
 * Safe preview representation for a plain Markdown block target.
 *
 * A `.md` page is *ordinary Markdown* in Astro: braces, JSX-looking text,
 * `import`/`export` lines and raw HTML are content, not executable syntax.
 * The block preview therefore never hands the saved Markdown to MDX. It splits
 * the draft into
 *
 *   1. the catalog-generated component calls at the top (regenerated from
 *      validated props, never copied from source), and
 *   2. the untouched Markdown body,
 *
 * renders (2) with the project's own Markdown renderer, and emits a virtual
 * `.astro` page that renders (1) as trusted Astro components and (2) as the
 * renderer's HTML. A target without a layout also emits the same default charset
 * and `maybeRenderHead()` instruction as Astro's own `.md` page, so the
 * preview's collected project styles and page scripts match the saved page.
 * Pre-existing content thus keeps exactly the semantics it has in production,
 * including raw HTML; only the editor's own blocks become components. Anything
 * that cannot be represented this way fails closed.
 *
 * Trust boundary: the local project content is trusted. This module is not a
 * sandbox. Explicitly authored MDX (`.mdx` targets) and raw HTML in Markdown are
 * allowed to do what they normally do. What it prevents is *accidental*
 * reinterpretation: a paragraph such as `{name}` or `<div>` in a `.md` file must
 * not silently become a server-side MDX expression or JSX element merely
 * because the editor is previewing it.
 */

const MAX_PREVIEW_MODULE_BYTES = 8 * 1024 * 1024
const IMAGE_PLACEHOLDER = /__ASTRO_IMAGE_="([^"]*)"/g
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function fail(message, code = 'UNSUPPORTED_SYNTAX') {
  throw Object.assign(new Error(message), { code })
}

function decodeImageAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function validateFrontmatterValue(value, code = 'UNSUPPORTED_FRONTMATTER') {
  if (value === null || value === undefined) value = {}
  if (typeof value !== 'object' || Array.isArray(value)) fail('The Markdown frontmatter must be a YAML mapping.', code)
  let normalized
  try {
    normalized = JSON.parse(JSON.stringify(value))
  } catch {
    fail('The Markdown frontmatter is not serializable.', code)
  }
  if (Object.hasOwn(normalized, 'layout') &&
      (typeof normalized.layout !== 'string' || !normalized.layout || normalized.layout.length > 512 || CONTROL_CHARACTERS.test(normalized.layout))) {
    fail('The Markdown frontmatter layout must be a plain trusted import specifier.', code)
  }
  return normalized
}

/**
 * Split Astro-style frontmatter from the Markdown body. The value is parsed as
 * YAML and immediately normalized through JSON, because that is what Astro does
 * for `.md` pages; it is later embedded as plain data and never as YAML source.
 */
export function splitMarkdownFrontmatter(source) {
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match) return { value: {}, bodyStart: bom }
  let parsed
  try {
    parsed = parseYaml(match[1])
  } catch (error) {
    fail(`The Markdown frontmatter is not valid YAML: ${error.message}`, 'UNSUPPORTED_FRONTMATTER')
  }
  return { value: validateFrontmatterValue(parsed), bodyStart: match[0].length }
}

/**
 * Structural validation shared by the editor server (which has no Markdown
 * renderer process) and the dev overlay. It only reads data and never
 * interprets the saved Markdown as MDX.
 */
export function assertMarkdownPreviewSource(source, { adapter }) {
  const { value } = splitMarkdownFrontmatter(source)
  if (typeof adapter?.describe !== 'function') fail('This block target cannot be previewed as Markdown.', 'UNSUPPORTED_FORMAT')
  const described = adapter.describe(source)
  return { frontmatter: value, bodyStart: described.bodyStart, blocks: described.blocks }
}

function replaceImagePlaceholders(html) {
  const nonce = randomBytes(8).toString('hex')
  const images = []
  const tokenized = html.replace(IMAGE_PLACEHOLDER, (placeholder, encoded) => {
    let props
    try {
      props = JSON.parse(decodeImageAttribute(encoded))
    } catch {
      fail('A Markdown image could not be read.', 'UNSUPPORTED_MARKDOWN')
    }
    if (!props || typeof props !== 'object' || Array.isArray(props) || typeof props.src !== 'string' || !props.src) {
      fail('A Markdown image has no usable source.', 'UNSUPPORTED_MARKDOWN')
    }
    const token = `__avcms_image_${nonce}_${images.length}__`
    images.push({ token, props })
    return token
  })
  return { html: tokenized, images }
}

function imageOptions(props) {
  const { index: _index, ...options } = props
  return options
}

function imageImportSource(src) {
  // Remote URLs are passed to getImage directly; every other marked image is a
  // local asset resolved relative to the Markdown file (the generated module
  // lives in the same directory, so the specifier keeps its meaning).
  return URL.canParse(src) ? null : src
}

function buildGeneratedModule({ filePath, url, frontmatter, headings, body, html, images, blocks }) {
  const { layout, ...content } = frontmatter
  const lines = ['---']
  const usedTypes = new Set()
  for (const block of blocks) {
    if (usedTypes.has(block.type)) continue
    usedTypes.add(block.type)
    lines.push(`import ${block.componentName} from ${JSON.stringify(block.importSource)}`)
  }
  if (layout) lines.push(`import AvcmsLayout from ${JSON.stringify(layout)}`)
  lines.push('import { getImage } from "astro:assets"')
  lines.push('import { maybeRenderHead, spreadAttributes } from "astro/runtime/server/index.js"')
  const imports = []
  const resolved = []
  const imageStatements = []
  images.forEach((image, index) => {
    const options = imageOptions(image.props)
    const importSource = imageImportSource(options.src)
    const sourceCode = importSource === null ? JSON.stringify(options.src) : `__avcmsImageImport${index}`
    if (importSource !== null) imports.push(`import __avcmsImageImport${index} from ${JSON.stringify(importSource)}`)
    const optionsCode = Object.entries({ ...options, src: undefined })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(', ')
    imageStatements.push(`const __avcmsImage${index} = await getImage({ src: ${sourceCode}${optionsCode ? `, ${optionsCode}` : ''} })`)
    imageStatements.push(`const __avcmsImageAttrs${index} = spreadAttributes({ src: __avcmsImage${index}.src, ...__avcmsImage${index}.attributes, ...(__avcmsImage${index}.srcSet.values.length ? { srcset: __avcmsImage${index}.srcSet.attribute } : {}) })`)
    resolved.push(`  .replace(${JSON.stringify(image.token)}, () => __avcmsImageAttrs${index})`)
  })
  for (const line of imports) lines.push(line)
  for (const line of imageStatements) lines.push(line)
  lines.push(`export const frontmatter = ${JSON.stringify(frontmatter)}`)
  lines.push(`const file = ${JSON.stringify(filePath)}`)
  lines.push(`const url = ${JSON.stringify(url)}`)
  lines.push(`const __avcmsContent = ${JSON.stringify({ ...content, file: filePath, url })}`)
  lines.push(`const __avcmsHeadings = ${JSON.stringify(headings)}`)
  lines.push(`const __avcmsHtml = ${JSON.stringify(html)}${resolved.length ? `\n${resolved.join('\n')}` : ''}`)
  // Astro hoists exported functions to module scope, where component-scope
  // consts are not visible. Inline plain data and repeat the (trusted) image
  // resolution inside `compiledContent` so it never exposes placeholder tokens.
  lines.push(`export function rawContent() { return ${JSON.stringify(body)} }`)
  lines.push('export async function compiledContent() {')
  for (const line of imageStatements) lines.push(`  ${line}`)
  lines.push(`  return ${JSON.stringify(html)}${resolved.length ? `\n${resolved.map((line) => `  ${line}`).join('\n')}` : ''}`)
  lines.push('}')
  lines.push(`export function getHeadings() { return ${JSON.stringify(headings)} }`)
  lines.push('---')
  const contentMarkup = [
    ...blocks.map((block) => block.markup),
    '<Fragment set:html={__avcmsHtml} />',
  ].join('\n')
  if (layout) {
    lines.push(`<AvcmsLayout file={file} url={url} content={__avcmsContent} frontmatter={__avcmsContent} headings={__avcmsHeadings} rawContent={rawContent} compiledContent={compiledContent}>`)
    lines.push(contentMarkup)
    lines.push('</AvcmsLayout>')
  } else {
    // Mirror Astro's own layout-less `.md` page exactly: it renders the default
    // charset, then `maybeRenderHead()` (collected styles, links, and page
    // scripts), then the rendered Markdown HTML.
    lines.push('<meta charset="utf-8" />')
    lines.push('{maybeRenderHead()}')
    lines.push(contentMarkup)
  }
  const module = `${lines.join('\n')}\n`
  if (Buffer.byteLength(module, 'utf8') > MAX_PREVIEW_MODULE_BYTES) fail('The generated Markdown preview exceeds the safe size limit.', 'PREVIEW_LIMIT')
  return module
}

/**
 * Build the virtual `.astro` module for a Markdown draft. `renderMarkdown` is
 * the project's configured Markdown renderer (`processor.createRenderer`), so
 * the body is rendered exactly like a saved `.md` page.
 */
export async function buildMarkdownPreviewModule({ source, adapter, filePath, url, renderMarkdown }) {
  const { value: sourceFrontmatter } = splitMarkdownFrontmatter(source)
  if (typeof adapter?.describe !== 'function') fail('This block target cannot be previewed as Markdown.', 'UNSUPPORTED_FORMAT')
  const described = adapter.describe(source)
  const body = source.slice(described.bodyStart)
  let rendered
  try {
    rendered = await renderMarkdown(body, { fileURL: pathToFileURL(filePath), frontmatter: sourceFrontmatter })
  } catch (error) {
    fail(`The Markdown body could not be rendered: ${error?.message || 'unknown renderer failure'}`, 'UNSUPPORTED_MARKDOWN')
  }
  if (!rendered || typeof rendered.code !== 'string') fail('The Markdown renderer returned no HTML.', 'UNSUPPORTED_MARKDOWN')
  // Astro's own `.md` pipeline uses `renderResult.metadata.frontmatter`, not the
  // raw YAML, because remark/Satteri plugins may replace or derive metadata
  // (titles, computed flags, defaults). Using the original frontmatter here
  // would let a preview silently disagree with the saved page's layout. Carry
  // the renderer's final value verbatim, or fail closed if the processor does
  // not expose it.
  if (!rendered.metadata || !Object.hasOwn(rendered.metadata, 'frontmatter') ||
      rendered.metadata.frontmatter === null || rendered.metadata.frontmatter === undefined) {
    fail('The active Markdown processor did not return final frontmatter metadata, so a faithful preview cannot be guaranteed.', 'UNSUPPORTED_MARKDOWN_METADATA')
  }
  const frontmatter = validateFrontmatterValue(rendered.metadata.frontmatter, 'UNSUPPORTED_MARKDOWN_METADATA')
  const { html, images } = replaceImagePlaceholders(rendered.code)
  for (const image of images) {
    const count = html.split(image.token).length - 1
    if (count !== 1) fail('A Markdown image placeholder was ambiguous.', 'UNSUPPORTED_MARKDOWN')
  }
  const headings = Array.isArray(rendered.metadata?.headings) ? rendered.metadata.headings : []
  return buildGeneratedModule({ filePath, url, frontmatter, headings, body, html, images, blocks: described.blocks })
}
