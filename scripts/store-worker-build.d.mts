import type { InlineConfig } from 'vite'

export function storeWorkerBuild(options: { root: string; outDir: string; extension?: 'js' | 'cjs'; logLevel?: 'warn' | 'silent' }): InlineConfig
