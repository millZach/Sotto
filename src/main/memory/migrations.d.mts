import type { DatabaseSync } from 'node:sqlite'

export const migrations: readonly { readonly version: number; readonly sql: string }[]
export const memoryInsertSql: string
export const policyInsertSql: string

export function migrateDatabase(db: DatabaseSync): number[]
