import React, { type ReactNode } from 'react'
import type { PluginId } from '../../../../shared/plugins'

// Each plugin's row shows the service's own mark (ADR-0205), drawn in one colour from the theme as provider marks are
// (agents/ProviderMark.tsx). GitHub's is its Invertocat as Primer's Octicons draw it (primer/octicons, MIT,
// mark-github-16), checked November 11, 2026. Vercel's is its triangle as Simple Icons draws it (simple-icons vercel.svg,
// CC0), checked November 12, 2026. Gmail's is its envelope as Simple Icons draws it (simple-icons gmail.svg, CC0),
// checked November 13, 2026. Proton Mail's is its envelope as Simple Icons draws it (simple-icons protonmail.svg, CC0),
// checked November 14, 2026.
// The marks identify each service; the trademarks belong to their owners.
const MARKS: Readonly<Record<PluginId, { readonly viewBox: string; readonly path: string }>> = {
  github: {
    viewBox: '0 0 16 16',
    path: 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z',
  },
  vercel: { viewBox: '0 0 24 24', path: 'm12 1.608 12 20.784H0Z' },
  'proton-mail': {
    viewBox: '0 0 24 24',
    path: 'm15.24 8.998 3.656-3.073v15.81H2.482C1.11 21.735 0 20.609 0 19.223V6.944l7.58 6.38a2.186 2.186 0 0 0 2.871-.042l4.792-4.284h-.003zm-5.456 3.538 1.809-1.616a2.438 2.438 0 0 1-1.178-.533L.905 2.395A.552.552 0 0 0 0 2.826v2.811l8.226 6.923a1.186 1.186 0 0 0 1.558-.024zM23.871 2.463a.551.551 0 0 0-.776-.068l-3.199 2.688v16.653h1.623c1.371 0 2.481-1.127 2.481-2.513V2.824a.551.551 0 0 0-.129-.36z',
  },
  gmail: {
    viewBox: '0 0 24 24',
    path: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  },
}

/** A plugin's own mark. Decorative: the row names the plugin in text. */
export function PluginMark({ plugin, size = 20 }: { readonly plugin: PluginId; readonly size?: number }): ReactNode {
  const mark = MARKS[plugin]
  return <svg className="plugin-mark" data-plugin={plugin} width={size} height={size} viewBox={mark.viewBox} aria-hidden="true" focusable="false"><path d={mark.path} /></svg>
}
