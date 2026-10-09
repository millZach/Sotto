/** electron-vite emits the image under out/ and returns its absolute runtime path. */
declare module '*.png?asset' {
  const path: string
  export default path
}
