import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComplianceAttestationPack,
  computeAuditReadinessScore,
  createInitialGrcState,
  sha256Hex
} from '../src/engine/grcComplianceEngine';

describe('Lab 8 (grc-compliance) Layer 3 — Engine Unit Tests', () => {
  it('computeAuditReadinessScore returns 100% AUDIT_READY when all controls are PASS and VERIFIED_PASS', () => {
    const state = createInitialGrcState();
    const score = computeAuditReadinessScore(state);

    assert.equal(score.scorePct, 100);
    assert.equal(score.passingCount, 3);
    assert.equal(score.driftedCount, 0);
    assert.equal(score.verifiedCount, 3);
    assert.equal(score.statusLabel, 'AUDIT_READY');
  });

  it('computeAuditReadinessScore returns partial score and NON_COMPLIANT_DRIFT when controls drift', () => {
    const state = createInitialGrcState();
    state.controls.IAM_MFA_BYPASS.postureStatus = 'DRIFT';
    state.controls.IAM_MFA_BYPASS.auditorStatus = 'FLAGGED_DRIFT';

    const partial = computeAuditReadinessScore(state);
    assert.equal(partial.scorePct, 67);
    assert.equal(partial.passingCount, 2);
    assert.equal(partial.driftedCount, 1);
    assert.equal(partial.verifiedCount, 2);
    assert.equal(partial.statusLabel, 'NON_COMPLIANT_DRIFT');

    // 0% compliance when all 3 controls drift
    state.controls.BACKUP_WORM_DISABLED.postureStatus = 'DRIFT';
    state.controls.BACKUP_WORM_DISABLED.auditorStatus = 'FLAGGED_DRIFT';
    state.controls.PII_UNMASKED.postureStatus = 'DRIFT';
    state.controls.PII_UNMASKED.auditorStatus = 'FLAGGED_DRIFT';

    const zero = computeAuditReadinessScore(state);
    assert.equal(zero.scorePct, 0);
    assert.equal(zero.passingCount, 0);
    assert.equal(zero.driftedCount, 3);
    assert.equal(zero.verifiedCount, 0);
    assert.equal(zero.statusLabel, 'NON_COMPLIANT_DRIFT');
  });

  it('computeAuditReadinessScore returns PENDING_SIGN_OFF when posture is PASS but auditor sign-off is pending', () => {
    const state = createInitialGrcState();
    state.controls.PII_UNMASKED.postureStatus = 'PASS';
    state.controls.PII_UNMASKED.auditorStatus = 'REMEDIATION_REQUESTED';

    const score = computeAuditReadinessScore(state);
    assert.equal(score.scorePct, 67);
    assert.equal(score.passingCount, 3);
    assert.equal(score.driftedCount, 0);
    assert.equal(score.verifiedCount, 2);
    assert.equal(score.statusLabel, 'PENDING_SIGN_OFF');
  });

  it('buildComplianceAttestationPack includes BNM RMiT & ISO 27001 mappings and sha256Hex is deterministic', async () => {
    const state = createInitialGrcState();
    const pack = buildComplianceAttestationPack('deterministic-session', state);

    assert.equal(pack.lab_id, 'grc-compliance');
    assert.equal(pack.session_id, 'deterministic-session');
    const controls = pack.controls as Array<{
      drift_id: string;
      regulatory_mappings: Array<{ framework: string; clause: string }>;
    }>;
    assert.equal(controls.length, 3);
    assert.ok(controls[0].regulatory_mappings.some((m) => m.framework === 'BNM RMiT'));
    assert.ok(controls[0].regulatory_mappings.some((m) => m.framework === 'ISO/IEC 27001:2022'));

    // Deterministic SHA-256 across repeated runs with identical inputs
    const fixedPayload = { ...pack, generated_at: '2026-11-27T00:00:00.000Z' };
    const hash1 = await sha256Hex(fixedPayload);
    const hash2 = await sha256Hex(fixedPayload);
    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2);
  });
});
