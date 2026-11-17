import type { WgifManifest, WgifFiles } from './types.js';
/** Explicit, opt-in schema migration hook; it MUST NOT mutate a signed original. */
export interface MigrationContext {
  readonly from: '0.1';
  readonly to: '0.2';
  readonly manifest: Readonly<WgifManifest>;
  readonly files: Readonly<WgifFiles>;
}
export interface MigrationResult { manifest: WgifManifest; files: WgifFiles; warnings: string[] }
export type MigrationHook = (input: MigrationContext) => Promise<MigrationResult>;
/** No 0.2 migration is registered until its spec exists; never auto-upgrade on open. */
export const MIGRATION_01_TO_02: MigrationHook | undefined = undefined;
