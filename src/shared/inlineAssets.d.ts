// Vite inlines an asset imported with `?inline` as a data URL, in main as in the renderer.
declare module '*.woff2?inline' {
  const dataUrl: string
  export default dataUrl
}
