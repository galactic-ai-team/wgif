#!/usr/bin/env node
/**
 * Generates a standalone (precompiled) manifest validator for the player.
 *
 * `ajv` at runtime costs ~25–40 KiB gzip once you count the compiler and the
 * meta-schema. The manifest schema is fixed at build time, so the player can
 * ship generated validation code instead and keep @wgif/format's runtime
 * validator for Node/CI only. This keeps ONE schema as the source of truth.
 *
 * Usage: tsx scripts/gen-validator.ts [--out apps/player/src/generated/manifest.validator.js]
 *                                    [--check]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_OUT = 'apps/player/src/generated/manifest.validator.js'

const SCHEMA_CANDIDATES = [
  'packages/format/schema/manifest.v0.1.schema.json',
  'packages/format/schemas/manifest.v0.1.schema.json',
  'packages/format/src/manifest.v0.1.schema.json',
  'packages/format/src/schema/manifest.v0.1.schema.json',
  // fallback so a rename doesn't silently break the build
  'packages/format/schema/manifest.schema.json',
]

export function findSchema(root: string): string | null {
  return SCHEMA_CANDIDATES.find((rel) => existsSync(path.join(root, rel))) ?? null
}

export async function generate(root: string, schemaRel: string): Promise<string> {
  const Ajv2020 = (await import('ajv/dist/2020.js')).default
  const standaloneCode = (await import('ajv/dist/standalone/index.js')).default

  const schema = JSON.parse(readFileSync(path.join(root, schemaRel), 'utf8')) as object
  const ajv = new Ajv2020({ allErrors: true, strict: false, code: { source: true, esm: true } })
  const validate = ajv.compile(schema)
  const code = standaloneCode(ajv, validate)

  return [
    '// GENERATED FILE — do not edit.',
    `// Source schema: ${schemaRel}`,
    '// Regenerate: npm run gen:validator',
    '// @ts-nocheck',
    code,
    '',
  ].join('\n')
}

async function main(argv: string[]): Promise<number> {
  const root = process.cwd()
  const outIdx = argv.indexOf('--out')
  const outRel = outIdx >= 0 ? argv[outIdx + 1] : DEFAULT_OUT
  const schemaRel = findSchema(root)
  if (!schemaRel) {
    console.error(
      `could not find the manifest schema (expected manifest.v0.1.schema.json). Looked for:\n  ` +
        SCHEMA_CANDIDATES.join('\n  '),
    )
    return 2
  }

  const code = await generate(root, schemaRel)
  const outAbs = path.join(root, outRel)

  if (argv.includes('--check')) {
    const current = existsSync(outAbs) ? readFileSync(outAbs, 'utf8') : ''
    if (current !== code) {
      console.error(`generated validator is stale: run \`npm run gen:validator\``)
      return 1
    }
    return 0
  }

  mkdirSync(path.dirname(outAbs), { recursive: true })
  writeFileSync(outAbs, code)
  console.log(`wrote ${outRel} from ${schemaRel} (${Buffer.byteLength(code)} bytes)`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && /gen-validator\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}