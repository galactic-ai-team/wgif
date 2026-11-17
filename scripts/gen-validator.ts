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

type Draft = '04' | '06' | '07' | '2019-09' | '2020-12'

/**
 * Map a JSON Schema `$schema` URI to a draft identifier. Returns null when
 * the URI is missing or unrecognized — callers must refuse to guess, because
 * draft-07 and draft-2020-12 are not interchangeable at compile time.
 */
export function detectDraft(schemaUri: string | undefined): Draft | null {
  if (!schemaUri) return null
  if (schemaUri.includes('2020-12')) return '2020-12'
  if (schemaUri.includes('2019-09')) return '2019-09'
  if (schemaUri.includes('draft-07')) return '07'
  if (schemaUri.includes('draft-06')) return '06'
  if (schemaUri.includes('draft-04')) return '04'
  return null
}

/**
 * Flatten `{ default: { default: X } }` or `{ default: X }` to `X`.
 * Ajv 8's per-draft builds are CJS; dynamic `import()` may add a wrapper
 * layer depending on Node version and bundler. Both shapes must work.
 */
function unwrap(m: unknown): unknown {
  let cur = m
  while (cur && typeof cur === 'object' && 'default' in (cur as Record<string, unknown>)) {
    const next = (cur as Record<string, unknown>).default
    if (next === cur) break
    cur = next
  }
  return cur
}

/**
 * Build the Ajv instance that matches the schema's declared draft.
 *
 * Ajv 8 ships one build per draft; using the wrong one throws
 * "no schema with key or ref http://json-schema.org/draft-07/schema#".
 * Adding the meta-schema to the wrong class is not a fix — Ajv 2020
 * rejects draft-07 keywords (`definitions`, `dependencies`, bare `items`).
 */
async function makeAjv(schemaUri: string | undefined): Promise<{
  ajv: { compile: (s: unknown) => unknown }
  standaloneCode: (ajv: unknown, validate?: unknown) => string
  draft: Draft
}> {
  const opts = { allErrors: true, strict: false, code: { source: true, esm: true } } as const
  const standaloneCode = unwrap(
    (await import('ajv/dist/standalone/index.js')) as unknown,
  ) as (ajv: unknown, validate?: unknown) => string

  const draft = detectDraft(schemaUri)
  if (!draft) {
    throw new Error(
      `gen-validator: schema has no recognized $schema URI (got ${JSON.stringify(schemaUri)}). ` +
        `Refusing to guess — draft-07 and draft-2020-12 are not interchangeable at compile time.`,
    )
  }
  if (draft === '04' || draft === '06') {
    throw new Error(
      `gen-validator: schema declares draft-${draft}. Ajv 8's per-draft builds cover ` +
        `07, 2019-09 and 2020-12 only; add ajv-draft-04 as a devDependency and route ` +
        `draft-04/06 through it before using this schema.`,
    )
  }

  type Ctor = new (o: typeof opts) => { compile: (s: unknown) => unknown }
  let mod: unknown
  if (draft === '2020-12') mod = await import('ajv/dist/2020.js')
  else if (draft === '2019-09') mod = await import('ajv/dist/2019.js')
  else mod = await import('ajv')
  const Ajv = unwrap(mod) as Ctor
  return { ajv: new Ajv(opts), standaloneCode, draft }
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