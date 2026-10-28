import type { InlineConfig } from 'vite'

export const STORE_WORKERS: readonly ('threadStoreWorker' | 'usageStoreWorker')[]

export function storeWorkerBuild(options: { root: string; outDir: string; extension?: 'js' | 'cjs'; logLevel?: 'warn' | 'silent'; worker?: 'threadStoreWorker' | 'usageStoreWorker' }): InlineConfig
