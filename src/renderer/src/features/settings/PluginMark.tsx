import React, { type ReactNode } from 'react'
import type { ListedPluginId } from '../../../../shared/plugins'

// Each plugin's row shows the service's own mark (ADR-0205), drawn in one colour from the theme as provider marks are
// (agents/ProviderMark.tsx). GitHub's is its Invertocat as Primer's Octicons draw it (primer/octicons, MIT,
// mark-github-16), checked November 11, 2026. Vercel's is its triangle as Simple Icons draws it (simple-icons vercel.svg,
// CC0), checked November 12, 2026.
// The marks identify each service; the trademarks belong to their owners.
const MARKS: Readonly<Record<ListedPluginId, { readonly viewBox: string; readonly path: string }>> = {
  github: {
    viewBox: '0 0 16 16',
    path: 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z',
  },
  vercel: { viewBox: '0 0 24 24', path: 'm12 1.608 12 20.784H0Z' },
}

/** A plugin's own mark. Decorative: the row names the plugin in text. */
export function PluginMark({ plugin, size = 20 }: { readonly plugin: ListedPluginId; readonly size?: number }): ReactNode {
  const mark = MARKS[plugin]
  return <svg className="plugin-mark" data-plugin={plugin} width={size} height={size} viewBox={mark.viewBox} aria-hidden="true" focusable="false"><path d={mark.path} /></svg>
}
