import path from 'node:path'
import { createMarkdownDraftMarkerPlugin, createMarkdownParagraphMarkerPlugin } from '../lib/markdown-paragraph-map.mjs'

/**
 * Dev-only explicit marker bridge for the local editor preview.
 */
export function createLoopbackDevIntegration({ editorPort = process.env.EDITOR_PORT || '4322', markdownParagraphTargets = [], markdownDraftTargets = [], previewRoutes = [] } = {}) {
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
  if (!Array.isArray(markdownDraftTargets) || markdownDraftTargets.length > 8) throw new TypeError('markdownDraftTargets must be a bounded trusted target list.')
  const draftTargets = markdownDraftTargets.map((target) => {
    if (!target || typeof target !== 'object' || Object.keys(target).some((key) => !['id', 'filePath', 'instanceId', 'text', 'projectRoot'].includes(key)) ||
        typeof target.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(target.id) ||
        typeof target.filePath !== 'string' || !path.isAbsolute(target.filePath) ||
        (target.projectRoot !== undefined && (typeof target.projectRoot !== 'string' || !path.isAbsolute(target.projectRoot))) ||
        typeof target.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target.instanceId) ||
        typeof target.text !== 'string' || !target.text || target.text.length > 512 || /[\r\n]/.test(target.text)) {
      throw new TypeError('Invalid trusted Markdown draft target.')
    }
    return { ...target, filePath: path.resolve(target.filePath) }
  })
  if (new Set(draftTargets.map(({ id }) => id)).size !== draftTargets.length ||
      new Set(draftTargets.map(({ instanceId }) => instanceId)).size !== draftTargets.length) {
    throw new TypeError('Markdown draft target and instance ids must be unique.')
  }
  if (!Array.isArray(previewRoutes) || previewRoutes.length > 32) throw new TypeError('previewRoutes must be a bounded trusted list.')
  const routes = previewRoutes.map((route) => {
    let segments
    try { segments = typeof route?.path === 'string' ? route.path.split('/').map((part) => decodeURIComponent(part)) : [] } catch { segments = null }
    if (!route || typeof route !== 'object' || Object.keys(route).some((key) => !['id', 'path', 'label'].includes(key)) ||
        typeof route.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(route.id) ||
        typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.startsWith('//') || /[?#\\\\\u0000-\u001f\u007f]/.test(route.path) || /%25/i.test(route.path) || !segments || segments.some((part) => part === '.' || part === '..' || /[\\/\u0000-\u001f\u007f]/.test(part)) ||
        (route.label !== undefined && (typeof route.label !== 'string' || !route.label.trim() || route.label.length > 80 || /[\u0000-\u001f\u007f]/.test(route.label)))) throw new TypeError('Invalid trusted toolbar preview route.')
    return { id: route.id, path: route.path, label: typeof route.label === 'string' ? route.label.slice(0, 80) : route.id }
  })
  if (new Set(routes.map(({ id }) => id)).size !== routes.length || new Set(routes.map(({ path }) => path)).size !== routes.length) throw new TypeError('Toolbar preview routes must be unique.')
  return {
    name: 'astro-visual-cms-loopback-dev-boundary',
    hooks: {
      'astro:config:setup'({ command, updateConfig, injectScript, addDevToolbarApp, config, logger }) {
        if (command !== 'dev') return
        if (paragraphTargets.length > 0 || draftTargets.length > 0) {
          const processor = config.markdown?.processor
          const plugins = processor?.options?.mdastPlugins
          if (processor?.name !== 'satteri' || !Array.isArray(plugins)) {
          logger?.error?.('Configured Markdown targets require the supported Satteri MDX plugin pipeline; refusing to start dev with mapped targets.')
            throw new TypeError('Configured Markdown targets cannot be mapped by the active Astro processor.')
          }
          for (const target of paragraphTargets) plugins.push(createMarkdownParagraphMarkerPlugin({ ...target, targetId: target.id }))
          for (const target of draftTargets) plugins.push(createMarkdownDraftMarkerPlugin({ ...target, targetId: target.id }))
        }
        updateConfig({ server: { host: '127.0.0.1' } })
        const toolbarEntrypoint = new URL('./toolbar-app.mjs', import.meta.url)
        toolbarEntrypoint.searchParams.set('port', String(port))
        toolbarEntrypoint.searchParams.set('routes', JSON.stringify(routes))
        addDevToolbarApp?.({ id: 'astro-visual-cms-editor', name: 'Seite bearbeiten', entrypoint: toolbarEntrypoint })
        const bridge = `(()=>{
          const editorOrigin=${JSON.stringify(`http://127.0.0.1:${port}`)};
          let nonce='';
          const valid=s=>typeof s==='string'&&s.length>0&&s.length<=128;
          const validDraftId=(s,max)=>typeof s==='string'&&s.length>0&&s.length<=max&&/^[A-Za-z0-9_-]+$/.test(s);
          const isSingleTextNode=el=>el.childNodes.length===1&&el.firstChild.nodeType===Node.TEXT_NODE;
          const draftSelector=(target,instance)=>'[data-astro-visual-cms-draft-target="'+target+'"][data-astro-visual-cms-draft-instance="'+instance+'"]';
          const draftSelection=el=>{
            if(!nonce||!el)return;
            const targetId=el.getAttribute('data-astro-visual-cms-draft-target');
            const instanceId=el.getAttribute('data-astro-visual-cms-draft-instance');
            if(!validDraftId(targetId,64)||!validDraftId(instanceId,128))return;
            const matches=document.querySelectorAll(draftSelector(targetId,instanceId));
            if(matches.length!==1){parent.postMessage({type:'avcms:draft-readonly',nonce,targetId,instanceId,markerCount:matches.length},editorOrigin);return}
            const target=matches[0];
            if(!isSingleTextNode(target)){parent.postMessage({type:'avcms:draft-readonly',nonce,targetId,instanceId,markerCount:1},editorOrigin);return}
            const renderedText=target.firstChild.nodeValue||'';
            if(renderedText.length>512){parent.postMessage({type:'avcms:draft-readonly',nonce,targetId,instanceId,markerCount:1},editorOrigin);return}
            parent.postMessage({type:'avcms:draft-selection',nonce,targetId,instanceId,markerCount:1,renderedText},editorOrigin);
          };
          addEventListener('message',e=>{
            const d=e.data;
            if(e.source!==parent||e.origin!==editorOrigin||!d||typeof d!=='object'||Array.isArray(d))return;
            const keys=Object.keys(d).sort().join(',');
            if(keys==='nonce,type'&&d.type==='avcms:challenge'&&valid(d.nonce)){
              nonce=d.nonce;
              parent.postMessage({type:'avcms:ready',nonce,href:location.href},editorOrigin);
              return;
            }
            if(keys!=='expectedText,instanceId,nonce,requestId,targetId,type,value'||d.type!=='avcms:draft-update'||d.nonce!==nonce||
                !validDraftId(d.targetId,64)||!validDraftId(d.instanceId,128)||!valid(d.requestId)||
                typeof d.expectedText!=='string'||d.expectedText.length>512||typeof d.value!=='string'||d.value.length>512||/[\\r\\n]/.test(d.value))return;
             const matches=document.querySelectorAll(draftSelector(d.targetId,d.instanceId));
             const target=matches.length===1?matches[0]:null;
             const ok=Boolean(target&&isSingleTextNode(target)&&(target.firstChild.nodeValue||'')===d.expectedText);
             if(ok)target.firstChild.nodeValue=d.value;
             parent.postMessage({type:'avcms:draft-update-result',nonce,requestId:d.requestId,targetId:d.targetId,instanceId:d.instanceId,markerCount:matches.length,ok},editorOrigin);
          });
          addEventListener('click',e=>{
            if(!nonce)return;
            const draft=e.target instanceof Element&&e.target.closest('[data-astro-visual-cms-draft-target][data-astro-visual-cms-draft-instance]');
            if(draft)draftSelection(draft);
            const el=e.target instanceof Element&&e.target.closest('[data-astro-visual-cms-target][data-astro-visual-cms-instance]');
            if(!el)return;
            const targetId=el.getAttribute('data-astro-visual-cms-target'),instanceId=el.getAttribute('data-astro-visual-cms-instance');
            if(!valid(targetId)||!valid(instanceId))return;
            parent.postMessage({type:'avcms:selection',nonce,targetId,instanceId},editorOrigin);
          },true);
          addEventListener('keydown',e=>{
            if(!nonce||e.repeat||!(e.key==='Enter'||e.key===' '))return;
            const el=e.target instanceof Element&&e.target.closest('[data-astro-visual-cms-draft-target][data-astro-visual-cms-draft-instance]');
            if(!el)return;
            e.preventDefault();
            draftSelection(el);
          },true);
        })()`
        injectScript('page', bridge)
      },
    },
  }
}
