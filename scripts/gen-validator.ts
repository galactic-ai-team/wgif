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

/**
 * Ajv 8 has one build per JSON-Schema draft; each carries only its own
 * meta-schema. Picking the wrong one throws:
 *   "no schema with key or ref http://json-schema.org/draft-07/schema#"
 * so select by the schema's own `$schema` URI. Missing/unknown → draft-07,
 * which is Ajv's default build.
 */
async function makeAjv(schemaUri: string | undefined): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ajv: any
  standaloneCode: (ajv: unknown, validate: unknown) => string
  draft: '07' | '2019-09' | '2020-12'
}> {
  const opts = { allErrors: true, strict: false, code: { source: true, esm: true } } as const
  const standaloneMod = (await import('ajv/dist/standalone/index.js')) as unknown as {
    default: (ajv: unknown, validate?: unknown) => string
  }
  const standaloneCode = standaloneMod.default

  if (schemaUri?.includes('2020-12')) {
    const Ajv2020 = (await import('ajv/dist/2020.js')).default.default
    return { ajv: new Ajv2020(opts), standaloneCode, draft: '2020-12' }
  }
  if (schemaUri?.includes('2019-09')) {
    const Ajv2019 = (await import('ajv/dist/2019.js')).default.default
    return { ajv: new Ajv2019(opts), standaloneCode, draft: '2019-09' }
  }
  const Ajv = (await import('ajv')).default.default
  return { ajv: new Ajv(opts), standaloneCode, draft: '07' }
}

export async function generate(
  root: string,
  schemaRel: string,
): Promise<{ code: string; draft: string }> {
  const raw = readFileSync(path.join(root, schemaRel), 'utf8')
  const schema = JSON.parse(raw) as { $schema?: string }
  const { ajv, standaloneCode, draft } = await makeAjv(schema.$schema)

  let validate: unknown
  try {
    validate = ajv.compile(schema)
  } catch (err) {
    throw new Error(
      `gen-validator: ajv (draft ${draft}) could not compile ${schemaRel}: ${(err as Error).message}`,
      { cause: err },
    )
  }
  const code = standaloneCode(ajv, validate)

  return {
    draft,
    code: [
      '// GENERATED FILE — do not edit.',
      `// Source schema: ${schemaRel} (draft ${draft})`,
      '// Regenerate: npm run gen:validator',
      '// @ts-nocheck',
      code,
      '',
    ].join('\n'),
  }
}

async function main(argv: string[]): Promise<number> {
  const root = process.cwd()
  const outIdx = argv.indexOf('--out')
  const outRel = (outIdx >= 0 ? argv[outIdx + 1] : undefined) ?? DEFAULT_OUT
  const schemaRel = findSchema(root)
  if (!schemaRel) {
    console.error(
      `could not find the manifest schema (expected manifest.v0.1.schema.json). Looked for:\n  ` +
        SCHEMA_CANDIDATES.join('\n  '),
    )
    return 2
  }

  const { code, draft } = await generate(root, schemaRel)
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
  console.log(`wrote ${outRel} from ${schemaRel} · draft ${draft} · ${Buffer.byteLength(code)} bytes`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && /gen-validator\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}