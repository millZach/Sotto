/**
 * Source for the top of a fixture script that ends itself once `stopFile` exists or its own file has gone, checked
 * every 20 ms and wherever the script calls `stopIfTold()`. A test holds no handle to a process its scripts start, so
 * it cleans one up by writing `stopFile`, never by signalling its PID: by then that PID may belong to another process,
 * such as a Git the other test worker is running (#1002).
 */
export const stopsWhenTold = (stopFile: string): string =>
  `const stopIfTold = () => { const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(stopFile)}) || !fs.existsSync(__filename)) process.exit() }; setInterval(stopIfTold, 20);`
