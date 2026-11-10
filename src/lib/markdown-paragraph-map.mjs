import { createProcessor } from '@mdx-js/mdx'
import { fileURLToPath } from 'node:url'
import { hashSource } from './gallery-patch.mjs'

const processor = createProcessor({ format: 'mdx' })

function unsupported(message) {
  const error = new Error(message)
  error.code = 'UNSUPPORTED_MARKDOWN_MAPPING'
  throw error
}

/** Return a source map only when the entire MDX document is one plain-text paragraph. */
export function mapSinglePlainParagraph(source) {
  if (typeof source !== 'string') unsupported('Source must be text.')
  let tree
  try { tree = processor.parse(source) } catch { unsupported('MDX syntax is unsupported.') }
  if (tree.children.length !== 1) unsupported('Expected exactly one Markdown node.')
  const paragraph = tree.children[0]
  if (paragraph.type !== 'paragraph' || paragraph.children.length !== 1 || paragraph.children[0].type !== 'text') {
    unsupported('Only one plain-text paragraph is supported.')
  }
  const text = paragraph.children[0]
  const { start, end } = text.position || {}
  if (!Number.isInteger(start?.offset) || !Number.isInteger(end?.offset) || start.offset >= end.offset ||
      source.slice(start.offset, end.offset) !== text.value || /[\r\n]/.test(text.value)) {
    unsupported('The parser did not provide an exact unambiguous paragraph text range.')
  }
  return Object.freeze({ text: text.value, start: start.offset, end: end.offset, hash: hashSource(source) })
}

export function patchSinglePlainParagraph(source, nextText, expectedHash) {
  const mapping = mapSinglePlainParagraph(source)
  if (mapping.hash !== expectedHash) {
    const error = new Error('Source changed since preview.')
    error.code = 'STALE_HASH'
    throw error
  }
  if (typeof nextText !== 'string' || !nextText.trim() || /[\r\n]/.test(nextText)) unsupported('Replacement must be one non-empty line of plain text.')
  const updated = source.slice(0, mapping.start) + nextText + source.slice(mapping.end)
  const checked = mapSinglePlainParagraph(updated)
  return { source: updated, hash: checked.hash, diff: { start: mapping.start, end: mapping.end, before: mapping.text, after: nextText } }
}

export function createMarkdownParagraphAdapter({ instanceId = 'paragraph' } = {}) {
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
    unsupported('Invalid trusted Markdown paragraph identity.')
  }
  return Object.freeze({
    inspect(source) {
      const mapping = mapSinglePlainParagraph(source)
      return { instances: [{ id: instanceId, props: { text: mapping.text } }], hash: mapping.hash }
    },
    patch(source, targetId, prop, value, expectedHash) {
      if (targetId !== instanceId || prop !== 'text') unsupported('Unknown Markdown paragraph target or field.')
      return patchSinglePlainParagraph(source, value, expectedHash)
    },
  })
}

/** Satteri MDX plugin factory; only the exact configured file and plain paragraph get markers. */
export function createMarkdownParagraphMarkerPlugin({ filePath, targetId, instanceId = 'paragraph' }) {
  if (typeof filePath !== 'string' || !filePath || typeof targetId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(targetId) || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
    unsupported('Invalid trusted Markdown marker configuration.')
  }
  return (document) => {
    if (document.sourceFormat !== 'mdx' || !document.fileURL ||
        pathFromFileUrl(document.fileURL) !== filePath || typeof document.source !== 'string') return null
    let mapping
    try { mapping = mapSinglePlainParagraph(document.source) } catch { return null }
    return {
      name: `astro-visual-cms-markdown-${targetId}`,
      options: { position: true },
      paragraph(node, context) {
        if (node.position?.start?.offset !== mapping.start || node.position?.end?.offset !== mapping.end) return
        const hProperties = { ...(node.data?.hProperties || {}),
          'data-astro-visual-cms-target': targetId,
          'data-astro-visual-cms-instance': instanceId,
        }
        context.setField(node, 'data', { ...node.data, hProperties })
      },
    }
  }
}

/** Map one explicitly configured, root-level, single-line prose paragraph. */
export function mapConfiguredMarkdownDraft(source, configuredText) {
  if (typeof source !== 'string' || typeof configuredText !== 'string' || !configuredText || /[\r\n]/.test(configuredText)) {
    unsupported('The configured Markdown draft target must be one non-empty line of text.')
  }
  let tree
  try { tree = processor.parse(source) } catch { unsupported('MDX syntax is unsupported for visual Markdown drafts.') }

  const matches = []
  for (const node of tree.children) {
    if (node.type !== 'paragraph' || node.children.length !== 1 || node.children[0].type !== 'text') continue
    const text = node.children[0]
    const { start, end } = text.position || {}
    if (text.value !== configuredText || !Number.isInteger(start?.offset) || !Number.isInteger(end?.offset) ||
        start.offset >= end.offset || source.slice(start.offset, end.offset) !== text.value || /[\r\n]/.test(text.value)) continue
    matches.push({ text: text.value, start: start.offset, end: end.offset })
  }
  if (matches.length !== 1) {
    unsupported(matches.length > 1
      ? 'The configured Markdown draft paragraph is duplicated and remains read-only.'
      : 'The configured Markdown draft paragraph is missing or is not an exact plain-text node.')
  }
  return Object.freeze({ ...matches[0], hash: hashSource(source) })
}

/** Build a text-only draft diff. The caller owns no write capability. */
export function patchConfiguredMarkdownDraft(source, configuredText, nextText, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || hashSource(source) !== expectedHash) {
    const error = new Error('Source changed since the visual draft was loaded.')
    error.code = 'STALE_HASH'
    throw error
  }
  const mapping = mapConfiguredMarkdownDraft(source, configuredText)
  if (typeof nextText !== 'string' || !nextText.trim() || nextText.length > 512 || /[\r\n]/.test(nextText)) {
    unsupported('A visual draft replacement must be one non-empty line of plain text (up to 512 characters).')
  }
  if (nextText === mapping.text) return { hash: mapping.hash, diff: null }

  const updated = source.slice(0, mapping.start) + nextText + source.slice(mapping.end)
  const checked = mapConfiguredMarkdownDraft(updated, nextText)
  return {
    hash: mapping.hash,
    nextHash: checked.hash,
    diff: { start: mapping.start, end: mapping.end, before: mapping.text, after: nextText },
  }
}

/** Dev-only marker factory for the separate read-only visual-draft workflow. */
export function createMarkdownDraftMarkerPlugin({ filePath, targetId, instanceId, text }) {
  if (typeof filePath !== 'string' || !filePath || typeof targetId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(targetId) || typeof instanceId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId) || typeof text !== 'string' || !text || /[\r\n]/.test(text)) {
    unsupported('Invalid trusted Markdown draft marker configuration.')
  }
  return (document) => {
    if (document.sourceFormat !== 'mdx' || !document.fileURL ||
        pathFromFileUrl(document.fileURL) !== filePath || typeof document.source !== 'string') return null
    let mapping
    try { mapping = mapConfiguredMarkdownDraft(document.source, text) } catch { return null }
    return {
      name: `astro-visual-cms-markdown-draft-${targetId}`,
      options: { position: true },
      paragraph(node, context) {
        if (node.position?.start?.offset !== mapping.start || node.position?.end?.offset !== mapping.end) return
        const hProperties = {
          ...(node.data?.hProperties || {}),
          'data-astro-visual-cms-draft-target': targetId,
          'data-astro-visual-cms-draft-instance': instanceId,
          tabindex: '0',
          role: 'button',
          'aria-label': 'Select this visual Markdown draft paragraph',
        }
        context.setField(node, 'data', { ...node.data, hProperties })
      },
    }
  }
}

function pathFromFileUrl(value) {
  try { const url = value instanceof URL ? value : new URL(value); return url.protocol === 'file:' ? fileURLToPath(url) : '' } catch { return '' }
}
