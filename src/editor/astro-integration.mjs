import path from 'node:path'
import { createMarkdownParagraphMarkerPlugin } from '../lib/markdown-paragraph-map.mjs'

/**
 * Dev-only explicit marker bridge for the local editor preview.
 */
export function createLoopbackDevIntegration({ editorPort = process.env.EDITOR_PORT || '4322', markdownParagraphTargets = [] } = {}) {
  const port = Number(editorPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('EDITOR_PORT must be a valid TCP port.')
  if (!Array.isArray(markdownParagraphTargets) || markdownParagraphTargets.length > 32) throw new TypeError('markdownParagraphTargets must be a bounded trusted target list.')
  const paragraphTargets = markdownParagraphTargets.map((target) => {
    if (!target || typeof target !== 'object' || Object.keys(target).some((key) => !['id', 'filePath', 'instanceId'].includes(key)) ||
        typeof target.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(target.id) ||
        typeof target.filePath !== 'string' || !path.isAbsolute(target.filePath) ||
        (target.instanceId !== undefined && (typeof target.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target.instanceId)))) {
      throw new TypeError('Invalid trusted Markdown paragraph target.')
    }
    return { id: target.id, filePath: path.resolve(target.filePath), instanceId: target.instanceId || 'paragraph' }
  })
  if (new Set(paragraphTargets.map(({ id }) => id)).size !== paragraphTargets.length) throw new TypeError('Markdown paragraph target ids must be unique.')
  return {
    name: 'astro-visual-cms-loopback-dev-boundary',
    hooks: {
      'astro:config:setup'({ command, updateConfig, injectScript, config, logger }) {
        if (command !== 'dev') return
        if (paragraphTargets.length > 0) {
          const processor = config.markdown?.processor
          const plugins = processor?.options?.mdastPlugins
          if (processor?.name !== 'satteri' || !Array.isArray(plugins)) {
            logger?.error?.('Markdown paragraph targets require the supported Satteri MDX plugin pipeline; refusing to start dev with editable targets.')
            throw new TypeError('Configured Markdown paragraph targets cannot be mapped by the active Astro processor.')
          }
          for (const target of paragraphTargets) plugins.push(createMarkdownParagraphMarkerPlugin({ ...target, targetId: target.id }))
        }
        updateConfig({ server: { host: '127.0.0.1' } })
        injectScript('page', `(()=>{const editorOrigin=${JSON.stringify(`http://127.0.0.1:${port}`)};let nonce='';const valid=s=>typeof s==='string'&&s.length>0&&s.length<=128;addEventListener('message',e=>{const d=e.data;if(e.source!==parent||e.origin!==editorOrigin||!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).sort().join(',')!=='nonce,type'||d.type!=='avcms:challenge'||!valid(d.nonce))return;nonce=d.nonce;parent.postMessage({type:'avcms:ready',nonce},editorOrigin)});addEventListener('click',e=>{if(!nonce)return;const el=e.target instanceof Element&&e.target.closest('[data-astro-visual-cms-target][data-astro-visual-cms-instance]');if(!el)return;const targetId=el.getAttribute('data-astro-visual-cms-target'),instanceId=el.getAttribute('data-astro-visual-cms-instance');if(!valid(targetId)||!valid(instanceId))return;parent.postMessage({type:'avcms:selection',nonce,targetId,instanceId},editorOrigin)},true)})();`)
      },
    },
  }
}
