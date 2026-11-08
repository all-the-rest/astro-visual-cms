/**
 * Dev-only explicit marker bridge for the local editor preview.
 */
export function createLoopbackDevIntegration({ editorPort = process.env.EDITOR_PORT || '4322' } = {}) {
  const port = Number(editorPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('EDITOR_PORT must be a valid TCP port.')
  return {
    name: 'astro-visual-cms-loopback-dev-boundary',
    hooks: {
      'astro:config:setup'({ command, updateConfig, injectScript }) {
        if (command !== 'dev') return
        updateConfig({ server: { host: '127.0.0.1' } })
        injectScript('page', `(()=>{const editorOrigin=${JSON.stringify(`http://127.0.0.1:${port}`)};let nonce='';const valid=s=>typeof s==='string'&&s.length>0&&s.length<=128;addEventListener('message',e=>{const d=e.data;if(e.source!==parent||e.origin!==editorOrigin||!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).sort().join(',')!=='nonce,type'||d.type!=='avcms:challenge'||!valid(d.nonce))return;nonce=d.nonce});addEventListener('click',e=>{if(!nonce)return;const el=e.target instanceof Element&&e.target.closest('[data-astro-visual-cms-target][data-astro-visual-cms-instance]');if(!el)return;const targetId=el.getAttribute('data-astro-visual-cms-target'),instanceId=el.getAttribute('data-astro-visual-cms-instance');if(!valid(targetId)||!valid(instanceId))return;parent.postMessage({type:'avcms:selection',nonce,targetId,instanceId},editorOrigin)},true)})();`)
      },
    },
  }
}
