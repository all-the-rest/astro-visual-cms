import { defineToolbarApp } from 'astro/toolbar'

export default defineToolbarApp({
  init(canvas, app) {
    const params = new URL(import.meta.url).searchParams
    let routes = []
    try { routes = JSON.parse(params.get('routes') || '[]') } catch {}
    const port = Number(params.get('port'))
    app.onToggled(({ state }) => {
      if (!state) return
      const route = routes.find((item) => item.path === location.pathname)
      const editorOrigin = `http://127.0.0.1:${port}`
      const showMessage = (message, level = 'info') => {
        canvas.replaceChildren()
        const paragraph = document.createElement('p')
        paragraph.textContent = message
        canvas.append(paragraph)
        app.toggleNotification({ state: true, level })
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) return showMessage('Ungültiger Editor-Port konfiguriert.', 'error')
      const url = new URL('/', editorOrigin)
      if (route) url.searchParams.set('route', route.id)
      // Create the tab synchronously inside the user gesture, then perform the health probe.
      const opened = window.open('about:blank', '_blank')
      if (!opened) return showMessage('Editor konnte nicht geöffnet werden. Bitte Pop-ups für diese lokale Seite erlauben.', 'warning')
      try { opened.opener = null } catch {}
      fetch(`${editorOrigin}/api/health`, { mode: 'cors', cache: 'no-store' }).then((response) => {
        if (response.status !== 204) throw new Error('unavailable')
        opened.location.replace(url.href)
        showMessage(route ? `Editor für „${route.label}“ geöffnet.` : 'Route nicht konfiguriert; Editor öffnet die Standardseite.')
      }).catch(() => {
        try { opened.close() } catch {}
        showMessage(`Editor nicht erreichbar. Bitte den lokalen Editor auf Port ${port} starten.`, 'error')
      })
    })
  },
})
