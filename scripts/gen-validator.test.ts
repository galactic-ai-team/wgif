import { describe, expect, it } from 'vitest'
import { detectDraft } from './gen-validator.js'

describe('detectDraft', () => {
  it.each([
    ['http://json-schema.org/draft-07/schema#', '07'],
    ['https://json-schema.org/draft/2019-09/schema', '2019-09'],
    ['https://json-schema.org/draft/2020-12/schema', '2020-12'],
    ['http://json-schema.org/draft-04/schema#', '04'],
    [undefined, null],
    ['https://example.com/custom', null],
  ])('%s → %s', (uri, draft) => {
    expect(detectDraft(uri)).toBe(draft)
  })
})