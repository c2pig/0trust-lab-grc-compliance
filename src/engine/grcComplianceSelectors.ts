import type { GrcComplianceState } from '../contracts/grcComplianceContract';
import type { computeAuditReadinessScore } from './grcComplianceEngine';

type ControlRecord = GrcComplianceState['controls'][keyof GrcComplianceState['controls']];

export type ReadinessSummary = ReturnType<typeof computeAuditReadinessScore>;

export interface SeatBadgeDescriptor {
  text: string;
  tone: 'amber' | 'crimson';
  pulse: boolean;
}

export function selectGlobalStatusLabel(
  readiness: ReadinessSummary,
  totalControls: number
): string {
  if (readiness.driftedCount > 0) {
    return `Drift Detected (${readiness.scorePct}%)`;
  }
  if (readiness.verifiedCount === totalControls) {
    return `Audit Ready (${readiness.scorePct}%)`;
  }
  return `Pending Sign-Off (${readiness.scorePct}%)`;
}

export function selectGlobalStatusBadgeClass(
  readiness: ReadinessSummary,
  totalControls: number
): 'badge-crimson' | 'badge-emerald' | 'badge-amber' {
  if (readiness.driftedCount > 0) return 'badge-crimson';
  if (readiness.verifiedCount === totalControls) return 'badge-emerald';
  return 'badge-amber';
}

export function selectGrcSeatBadges(
  hasRemediationTicket: boolean,
  readiness: ReadinessSummary,
  totalControls: number
): {
  engineerBadge: SeatBadgeDescriptor | null;
  auditorBadge: SeatBadgeDescriptor | null;
} {
  const engineerBadge: SeatBadgeDescriptor | null = hasRemediationTicket
    ? { text: 'Remediation Req', tone: 'amber', pulse: true }
    : readiness.driftedCount > 0
      ? { text: `${readiness.driftedCount} Drift`, tone: 'crimson', pulse: true }
      : null;

  const auditorBadge: SeatBadgeDescriptor | null =
    readiness.driftedCount > 0
      ? { text: `${readiness.driftedCount} Drift`, tone: 'crimson', pulse: true }
      : readiness.verifiedCount < totalControls
        ? { text: 'Verify Ready', tone: 'amber', pulse: true }
        : null;

  return { engineerBadge, auditorBadge };
}

export function selectControlPostureBadge(
  postureStatus: ControlRecord['postureStatus']
): { label: 'DRIFT' | 'COMPLIANT'; className: 'badge-crimson' | 'badge-emerald' } {
  return postureStatus === 'DRIFT'
    ? { label: 'DRIFT', className: 'badge-crimson' }
    : { label: 'COMPLIANT', className: 'badge-emerald' };
}

export function selectControlAuditorBadge(
  auditorStatus: ControlRecord['auditorStatus'],
  remediationRequested: boolean
): { label: string; className: 'badge-emerald' | 'badge-amber' | 'badge-crimson' } {
  if (auditorStatus === 'VERIFIED_PASS') {
    return { label: 'VERIFIED PASS', className: 'badge-emerald' };
  }
  if (remediationRequested) {
    return { label: 'REMEDIATION REQ', className: 'badge-amber' };
  }
  return { label: 'FLAGGED DRIFT', className: 'badge-crimson' };
}
