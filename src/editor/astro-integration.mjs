import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createMarkdownDraftMarkerPlugin, createMarkdownParagraphMarkerPlugin } from '../lib/markdown-paragraph-map.mjs'
import { createMdxBlockPreviewPlugin } from './mdx-block-preview.mjs'

/**
 * Dev-only explicit marker bridge for the local editor preview.
 */
export function createLoopbackDevIntegration({ editorPort = process.env.EDITOR_PORT || '4322', markdownParagraphTargets = [], markdownDraftTargets = [], mdxBlockTargets = [], previewRoutes = [] } = {}) {
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
  if (!Array.isArray(mdxBlockTargets) || mdxBlockTargets.length > 8) throw new TypeError('mdxBlockTargets must be a bounded trusted target list.')
  const blockTargets = mdxBlockTargets.map((target) => {
    if (!target || typeof target !== 'object' || Object.keys(target).some((key) => !['id', 'projectRoot', 'filePath', 'previewRouteId', 'blockTypes'].includes(key)) ||
        !['id', 'projectRoot', 'filePath', 'previewRouteId', 'blockTypes'].every((key) => Object.hasOwn(target, key)) ||
        typeof target.id !== 'string' || !/^[A-Za-z_$][\w$-]{0,63}$/.test(target.id) ||
        typeof target.projectRoot !== 'string' || !path.isAbsolute(target.projectRoot) ||
        typeof target.filePath !== 'string' || !path.isAbsolute(target.filePath) || !['.md', '.mdx'].includes(path.extname(target.filePath)) ||
        !path.resolve(target.filePath).startsWith(`${path.resolve(target.projectRoot)}${path.sep}`) ||
        typeof target.previewRouteId !== 'string' || !/^[A-Za-z_$][\w$-]{0,63}$/.test(target.previewRouteId) ||
        !Array.isArray(target.blockTypes)) throw new TypeError('Invalid trusted MDX block target.')
    return { ...target, projectRoot: path.resolve(target.projectRoot), filePath: path.resolve(target.filePath) }
  })
  if (new Set(blockTargets.map(({ id }) => id)).size !== blockTargets.length ||
      new Set([...paragraphTargets, ...draftTargets, ...blockTargets].map(({ id }) => id)).size !== paragraphTargets.length + draftTargets.length + blockTargets.length) {
    throw new TypeError('Markdown and MDX target ids must be unique.')
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
  for (const target of blockTargets) if (!routes.some((route) => route.id === target.previewRouteId)) throw new TypeError('MDX block targets must use a configured preview route.')
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
        const blockPreviewToken = blockTargets.length ? randomBytes(32).toString('hex') : ''
        const blockPreviewPlugin = blockTargets.length
          ? createMdxBlockPreviewPlugin({
            targets: blockTargets.map((target) => {
              const route = routes.find((candidate) => candidate.id === target.previewRouteId)
              return {
                ...target,
                previewPath: `${String(config.base || '/').replace(/\/$/, '')}${route.path}` || '/',
                // Astro dev may mount the base path and expose the stripped path
                // to Vite middlewares, so track both forms for render failures.
                requestPath: route.path,
              }
            }),
            token: blockPreviewToken,
            // The dev CSS collector is keyed by the route path relative to the
            // Astro root, which is not necessarily the editor's projectRoot.
            astroRoot: config.root ? fileURLToPath(config.root) : undefined,
            // Plain `.md` drafts are rendered by the project's own Markdown
            // pipeline, never by MDX. This keeps saved Markdown semantics
            // (including raw HTML) untouched and makes only the catalog-
            // generated component calls executable.
            markdown: config.markdown,
            image: config.image,
            siteOrigin: (server) => {
              const address = server.httpServer?.address?.()
              const actualPort = address && typeof address === 'object'
                ? address.port
                : Number(config.server?.port || process.env.ASTRO_PORT || 4321)
              return `http://127.0.0.1:${actualPort}`
            },
          })
          : null
        updateConfig({
          server: { host: '127.0.0.1' },
          ...(blockPreviewPlugin ? { vite: { plugins: [blockPreviewPlugin] } } : {}),
        })
        const toolbarEntrypoint = new URL('./toolbar-app.mjs', import.meta.url)
        toolbarEntrypoint.searchParams.set('port', String(port))
        toolbarEntrypoint.searchParams.set('routes', JSON.stringify(routes))
        addDevToolbarApp?.({ id: 'astro-visual-cms-editor', name: 'Seite bearbeiten', entrypoint: toolbarEntrypoint })
        const bridge = `(()=>{
          const editorOrigin=${JSON.stringify(`http://127.0.0.1:${port}`)};
          const blockPreviewToken=${JSON.stringify(blockPreviewToken)};
          const blockTargetIds=new Set(${JSON.stringify(blockTargets.map(({ id }) => id))});
          const blockPreviewReloads=new Map();
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
            if(blockTargetIds.size&&d.type==='avcms:mdx-block-preview-ack'&&keys==='nonce,requestId,type'&&d.nonce===nonce&&valid(d.requestId)){
              const timer=blockPreviewReloads.get(d.requestId);
              if(timer){clearTimeout(timer);blockPreviewReloads.delete(d.requestId);window.setTimeout(()=>location.reload(),80);}
              return;
            }
            if(blockTargetIds.size&&d.type==='avcms:mdx-block-preview'&&keys==='hash,nonce,operations,requestId,targetId,type'&&d.nonce===nonce&&
                valid(d.requestId)&&validDraftId(d.targetId,64)&&blockTargetIds.has(d.targetId)&&typeof d.hash==='string'&&/^[a-f0-9]{64}$/.test(d.hash)&&
                Array.isArray(d.operations)&&d.operations.length>0&&d.operations.length<=32&&d.operations.every(operation=>operation&&typeof operation==='object'&&!Array.isArray(operation))){
              fetch('/__avcms/mdx-block-preview',{method:'POST',headers:{'content-type':'application/json','x-avcms-token':blockPreviewToken},
                body:JSON.stringify({targetId:d.targetId,requestId:d.requestId,hash:d.hash,operations:d.operations})}).then(async response=>({response,data:await response.json()})).then(({response,data})=>{
                  parent.postMessage({type:'avcms:mdx-block-preview-result',nonce,requestId:d.requestId,targetId:d.targetId,ok:response.ok,code:data.code||'',error:data.error||'',hash:data.hash||''},editorOrigin);
                  if(response.ok)blockPreviewReloads.set(d.requestId,window.setTimeout(()=>{blockPreviewReloads.delete(d.requestId);location.reload();},3000));
                }).catch(()=>parent.postMessage({type:'avcms:mdx-block-preview-result',nonce,requestId:d.requestId,targetId:d.targetId,ok:false,code:'PREVIEW_FAILED',error:'The Astro preview could not render this block draft.',hash:''},editorOrigin));
              return;
            }
            if(blockTargetIds.size&&d.type==='avcms:mdx-block-rendered'&&keys==='nonce,requestId,targetId,type'&&d.nonce===nonce&&
                valid(d.requestId)&&validDraftId(d.targetId,64)&&blockTargetIds.has(d.targetId)){
              fetch('/__avcms/mdx-block-preview',{method:'POST',headers:{'content-type':'application/json','x-avcms-token':blockPreviewToken},
                body:JSON.stringify({targetId:d.targetId,requestId:d.requestId,rendered:true})}).then(async response=>({response,data:await response.json()})).then(({response,data})=>{
                  parent.postMessage({type:'avcms:mdx-block-rendered-result',nonce,requestId:d.requestId,targetId:d.targetId,ok:response.ok,error:data.error||''},editorOrigin);
                }).catch(()=>parent.postMessage({type:'avcms:mdx-block-rendered-result',nonce,requestId:d.requestId,targetId:d.targetId,ok:false,error:'The Astro preview render could not be confirmed.'},editorOrigin));
              return;
            }
            if(blockTargetIds.size&&d.type==='avcms:mdx-block-reset'&&keys==='nonce,requestId,targetId,type'&&d.nonce===nonce&&valid(d.requestId)&&validDraftId(d.targetId,64)&&blockTargetIds.has(d.targetId)){
              fetch('/__avcms/mdx-block-preview',{method:'POST',headers:{'content-type':'application/json','x-avcms-token':blockPreviewToken},
                body:JSON.stringify({targetId:d.targetId,requestId:d.requestId,reset:true})}).then(async response=>({response,data:await response.json()})).then(({response,data})=>{
                  const changed=response.ok&&data.changed===true;
                  parent.postMessage({type:'avcms:mdx-block-reset-result',nonce,requestId:d.requestId,targetId:d.targetId,ok:response.ok,changed,error:data.error||''},editorOrigin);
                  if(changed)blockPreviewReloads.set(d.requestId,window.setTimeout(()=>{blockPreviewReloads.delete(d.requestId);location.reload();},3000));
                }).catch(()=>parent.postMessage({type:'avcms:mdx-block-reset-result',nonce,requestId:d.requestId,targetId:d.targetId,ok:false,changed:false,error:'The Astro preview could not reset this draft.'},editorOrigin));
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
