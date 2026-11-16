import { describe, expect, it } from 'vitest';
import { sha256, versionRuleIssues } from './freeze-technical.js';

const draft = { format: '0.1.0-draft.0', ai: '0.1.0-draft.0' };
const final = { format: '0.1.0', ai: '0.1.0' };

describe('v0.1 technical release rules', () => {
  it('keeps both packages on draft versions until owner approval', () => {
    expect(versionRuleIssues(false, draft, draft)).toEqual([]);
    expect(versionRuleIssues(false, final, final)).toHaveLength(2);
    expect(versionRuleIssues(true, final, final)).toEqual([]);
  });
  it('refuses a package-lock.json mismatch even after owner approval', () => {
    expect(versionRuleIssues(false, draft, final)).toHaveLength(2);
    expect(versionRuleIssues(true, final, draft)).toHaveLength(2);
  });
  it('hashes bytes as SHA-256, not Git object IDs', () => {
    expect(sha256(new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
