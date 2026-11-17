import { describe, expect, it } from 'vitest';
import { auditChecklist, auditEvidence, optionalManifestRequires } from '../scripts/freeze-check.js';

describe('v0.1.0 release preflight fail-closed contracts', () => {
  it('allows absent requires[] but rejects malformed capability declarations', () => {
    expect(optionalManifestRequires({ entry: { scene: 'scene/court.glb' } })).toEqual([]);
    expect(optionalManifestRequires({ requires: ['scene.glb'] })).toEqual(['scene.glb']);
    expect(optionalManifestRequires({ requires: 'scene.glb' })).toBeNull();
    expect(optionalManifestRequires({ requires: ['scene.glb', 7] })).toBeNull();
    expect(optionalManifestRequires(null)).toBeNull();
  });
  it('rejects incomplete and newly added undocumented checklist gates', () => {
    expect(auditChecklist('- [ ] **Owner decision:** pending')).not.toEqual([]);
    const labels = [
      'Owner decision', 'Normative docs', 'Capability behavior', 'Offline acceptance',
      'Format/security', 'Examples/reproducibility', 'CI/release smoke',
      'Package versions/lock', 'Release commit/tag',
    ];
    const complete = labels.map((name) => `- [x] **${name}:** completed`).join('\n');
    expect(auditChecklist(complete)).toEqual([]);
    expect(auditChecklist(`${complete}\n- [ ] **Surprise gate:** blocked`)).not.toEqual([]);
  });
  it('refuses empty, partial or placeholder evidence', () => {
    expect(auditEvidence(null).length).toBeGreaterThan(0);
    expect(auditEvidence({ release: 'v0.1.0', formatVersion: '0.1', gates: {} }).length).toBeGreaterThan(0);
    expect(auditEvidence({ release: 'v0.1.0', formatVersion: '0.1', gates: {
      owner: { complete: true, evidence: 'TODO fake approval' },
    } }).length).toBeGreaterThan(0);
  });
});
