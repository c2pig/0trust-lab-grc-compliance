import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectControlAuditorBadge,
  selectControlPostureBadge,
  selectGlobalStatusBadgeClass,
  selectGlobalStatusLabel,
  selectGrcSeatBadges
} from '../src/engine/grcComplianceSelectors';

describe('Lab 8 (grc-compliance) Layer 3 — UI Selectors Unit Tests', () => {
  it('selectGlobalStatusLabel & selectGlobalStatusBadgeClass reflect drift, pending, and audit-ready states', () => {
    const driftReadiness = {
      scorePct: 67,
      passingCount: 2,
      driftedCount: 1,
      verifiedCount: 2,
      statusLabel: 'NON_COMPLIANT_DRIFT' as const
    };
    assert.equal(selectGlobalStatusLabel(driftReadiness, 3), 'Drift Detected (67%)');
    assert.equal(selectGlobalStatusBadgeClass(driftReadiness, 3), 'badge-crimson');

    const pendingReadiness = {
      scorePct: 67,
      passingCount: 3,
      driftedCount: 0,
      verifiedCount: 2,
      statusLabel: 'PENDING_SIGN_OFF' as const
    };
    assert.equal(selectGlobalStatusLabel(pendingReadiness, 3), 'Pending Sign-Off (67%)');
    assert.equal(selectGlobalStatusBadgeClass(pendingReadiness, 3), 'badge-amber');

    const readyReadiness = {
      scorePct: 100,
      passingCount: 3,
      driftedCount: 0,
      verifiedCount: 3,
      statusLabel: 'AUDIT_READY' as const
    };
    assert.equal(selectGlobalStatusLabel(readyReadiness, 3), 'Audit Ready (100%)');
    assert.equal(selectGlobalStatusBadgeClass(readyReadiness, 3), 'badge-emerald');
  });

  it('selectGrcSeatBadges computes engineer and auditor badges', () => {
    const driftReadiness = {
      scorePct: 67,
      passingCount: 2,
      driftedCount: 1,
      verifiedCount: 2,
      statusLabel: 'NON_COMPLIANT_DRIFT' as const
    };
    const withTicket = selectGrcSeatBadges(true, driftReadiness, 3);
    assert.deepEqual(withTicket.engineerBadge, { text: 'Remediation Req', tone: 'amber', pulse: true });
    assert.deepEqual(withTicket.auditorBadge, { text: '1 Drift', tone: 'crimson', pulse: true });

    const readyReadiness = {
      scorePct: 100,
      passingCount: 3,
      driftedCount: 0,
      verifiedCount: 3,
      statusLabel: 'AUDIT_READY' as const
    };
    const allClear = selectGrcSeatBadges(false, readyReadiness, 3);
    assert.equal(allClear.engineerBadge, null);
    assert.equal(allClear.auditorBadge, null);
  });

  it('selectControlPostureBadge & selectControlAuditorBadge map control statuses', () => {
    assert.deepEqual(selectControlPostureBadge('DRIFT'), { label: 'DRIFT', className: 'badge-crimson' });
    assert.deepEqual(selectControlPostureBadge('PASS'), { label: 'COMPLIANT', className: 'badge-emerald' });

    assert.deepEqual(selectControlAuditorBadge('VERIFIED_PASS', false), {
      label: 'VERIFIED PASS',
      className: 'badge-emerald'
    });
    assert.deepEqual(selectControlAuditorBadge('REMEDIATION_REQUESTED', true), {
      label: 'REMEDIATION REQ',
      className: 'badge-amber'
    });
    assert.deepEqual(selectControlAuditorBadge('FLAGGED_DRIFT', false), {
      label: 'FLAGGED DRIFT',
      className: 'badge-crimson'
    });
  });
});
