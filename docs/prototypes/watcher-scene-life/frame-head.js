// PROTOTYPE, throwaway. Puts the theme's root on the frame before it paints: the attributes the app's root had in that
// mode, read from the real app (data.js). The page switches mode in place, so the scene never goes blank.
(function () {
  const q = new URLSearchParams(location.search)
  window.protoTheme = function (mode) {
    const attrs = window.PROTO_DATA.themes[mode] || window.PROTO_DATA.themes.dark
    const root = document.documentElement
    for (const a of [...root.attributes]) if (a.name !== 'lang' && !a.name.startsWith('data-proto')) root.removeAttribute(a.name)
    for (const [k, v] of Object.entries(attrs)) if (k !== 'lang') root.setAttribute(k, v)
  }
  window.protoTheme(q.get('mode') || 'dark')
  document.documentElement.setAttribute('data-proto-controls', q.get('controls') || '1')
})()
