import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  FileCheck2,
  Lock,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Wrench
} from 'lucide-react';
import {
  ComplianceStage,
  DriftControlId,
  GrcComplianceState,
  GrcSeatId,
  POSTURE_CHECK_CATALOG
} from '../contracts/grcComplianceContract';
import {
  buildComplianceAttestationPack,
  callPostureApi,
  callVerifyApi,
  computeAuditReadinessScore,
  createGrcSessionId,
  createGrcSpan,
  createInitialGrcState
} from '../engine/grcComplianceEngine';
import { RoleSeatItem, RoleSwitcherBar } from '../components/RoleSwitcherBar';
import { XRayDecodedProofSection, XRayTelemetryDrawer } from '../components/XRayTelemetryDrawer';
import { ObservabilitySpan } from '../types';

export interface GrcCompliancePageProps {
  onBack: () => void;
}

const STAGE_ITEMS: { id: ComplianceStage; label: string; subtitle: string }[] = [
  { id: 1, label: 'Discovery', subtitle: 'Posture-to-Regulation Map' },
  { id: 2, label: 'Understanding', subtitle: 'Live Drift Injection' },
  { id: 3, label: 'Practice', subtitle: 'Auditor Workbench & 409 Trap' },
  { id: 4, label: 'Reflection', subtitle: 'Readiness & Attestation' }
];

export function GrcCompliancePage({ onBack }: GrcCompliancePageProps) {
  const [sessionId, setSessionId] = useState<string>(() => createGrcSessionId());
  const [activeSeat, setActiveSeat] = useState<GrcSeatId>('cloud-engineer');
  const [state, setState] = useState<GrcComplianceState>(() => createInitialGrcState());
  const [busyControl, setBusyControl] = useState<DriftControlId | null>(null);
  const [copiedPack, setCopiedPack] = useState<boolean>(false);
  const [spans, setSpans] = useState<ObservabilitySpan[]>([]);

  const recordSpan = useCallback((span: ObservabilitySpan) => {
    setSpans((prev) => [span, ...prev].slice(0, 40));
  }, []);

  useEffect(() => {
    recordSpan(
      createGrcSpan({
        sessionId,
        method: 'GET',
        path: '/api/grc-compliance/posture',
        status: 200,
        latencyMs: 6,
        executionOrigin: 'browser-webcrypto-fallback',
        responseSummary: {
          event: 'BASELINE_POSTURE_LOADED',
          frameworks: ['BNM RMiT', 'ISO/IEC 27001:2022', 'NIST CSF 2.0'],
          controls_passing: 3
        }
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readiness = useMemo(() => computeAuditReadinessScore(state), [state]);

  const seats: RoleSeatItem<GrcSeatId>[] = useMemo(() => {
    const engineerBadge =
      readiness.driftedCount > 0
        ? {
            text: `● ${readiness.driftedCount} Drift Active`,
            tone: 'crimson' as const,
            pulse: true
          }
        : { text: 'All Posture PASS', tone: 'emerald' as const };

    const auditorBadge =
      readiness.driftedCount > 0
        ? { text: '● Drift', tone: 'crimson' as const, pulse: true }
        : readiness.verifiedCount === POSTURE_CHECK_CATALOG.length
          ? { text: 'Verified PASS', tone: 'emerald' as const }
          : { text: 'Pending Re-Verify', tone: 'amber' as const, pulse: true };

    return [
      {
        id: 'cloud-engineer',
        name: 'Rohan Verma',
        roleLabel: 'Cloud Engineer · Posture & Drift',
        appLabel: 'Multi-Cloud Posture & Drift Injector',
        avatarInitials: 'RV',
        badge: engineerBadge
      },
      {
        id: 'auditor',
        name: 'Claire Dubois',
        roleLabel: 'GRC Auditor · Evidence Reviewer',
        appLabel: 'Regulatory Control & Evidence Workbench',
        avatarInitials: 'CD',
        badge: auditorBadge
      }
    ];
  }, [readiness]);

  const selectedDef = useMemo(
    () =>
      POSTURE_CHECK_CATALOG.find((d) => d.id === state.selectedControlId) ||
      POSTURE_CHECK_CATALOG[0],
    [state.selectedControlId]
  );

  const selectedLive = state.controls[selectedDef.id];

  const handleSelectStage = (stage: ComplianceStage) => {
    setState((prev) => ({ ...prev, stage, lastErrorBanner: null }));
  };

  const handleReset = async () => {
    const nextSid = createGrcSessionId();
    const res = await callPostureApi(nextSid, 'RESET');
    setSessionId(nextSid);
    setActiveSeat('cloud-engineer');
    setState(createInitialGrcState());
    setCopiedPack(false);
    recordSpan(
      createGrcSpan({
        sessionId: nextSid,
        method: 'POST',
        path: '/api/grc-compliance/posture',
        status: res.httpStatus,
        latencyMs: 9,
        executionOrigin: res.executionOrigin,
        telemetry: res.telemetry,
        responseSummary: res.rawPayload
      })
    );
  };

  const handlePostureAction = async (
    driftId: DriftControlId,
    action: 'INJECT_DRIFT' | 'REMEDIATE'
  ) => {
    setBusyControl(driftId);
    const t0 = performance.now();
    const res = await callPostureApi(sessionId, action, driftId, state.controls);
    const latencyMs = Math.max(4, Math.round(performance.now() - t0));
    const timestamp = new Date().toISOString();

    setState((prev) => {
      const prevCtrl = prev.controls[driftId];
      const nextPosture = action === 'INJECT_DRIFT' ? 'DRIFT' : 'PASS';
      const nextAuditorStatus =
        nextPosture === 'DRIFT'
          ? 'FLAGGED_DRIFT'
          : prevCtrl.remediationRequested
            ? 'REMEDIATION_REQUESTED'
            : 'VERIFIED_PASS';

      return {
        ...prev,
        selectedControlId: driftId,
        lastErrorBanner: null,
        lastActionSummary:
          action === 'INJECT_DRIFT'
            ? `Injected ${driftId} drift — affected BNM RMiT, ISO 27001, and NIST CSF 2.0 clauses flipped to DRIFT.`
            : `Remediated ${driftId} posture check — evidence digest refreshed. Switch to Auditor seat to verify PASS.`,
        controls: {
          ...prev.controls,
          [driftId]: {
            ...prevCtrl,
            postureStatus: nextPosture,
            auditorStatus: nextAuditorStatus,
            remediationRequested:
              nextPosture === 'DRIFT' ? prevCtrl.remediationRequested : false,
            evidenceSha256: res.evidenceSha256,
            updatedAt: timestamp,
            storageOrigin: res.storageOrigin,
            auditorNote:
              nextPosture === 'DRIFT'
                ? 'Live configuration drift detected by posture scanner.'
                : 'Posture remediated by Cloud Engineer; awaiting Auditor verification.'
          }
        },
        traps: {
          ...prev.traps,
          iamDrift8A: prev.traps.iamDrift8A || (driftId === 'IAM_MFA_BYPASS' && action === 'INJECT_DRIFT'),
          backupWormDrift8B:
            prev.traps.backupWormDrift8B ||
            (driftId === 'BACKUP_WORM_DISABLED' && action === 'INJECT_DRIFT'),
          piiUnmaskedDrift8C:
            prev.traps.piiUnmaskedDrift8C || (driftId === 'PII_UNMASKED' && action === 'INJECT_DRIFT')
        }
      };
    });

    recordSpan(
      createGrcSpan({
        sessionId,
        method: 'POST',
        path: '/api/grc-compliance/posture',
        status: res.httpStatus,
        latencyMs,
        executionOrigin: res.executionOrigin,
        telemetry: res.telemetry,
        responseSummary: res.rawPayload
      })
    );
    setBusyControl(null);
  };

  const handleAuditorVerify = async (
    driftId: DriftControlId,
    action: 'MARK_PASS' | 'FLAG_REMEDIATION'
  ) => {
    setBusyControl(driftId);
    const t0 = performance.now();
    const currentCtrl = state.controls[driftId];
    const res = await callVerifyApi(sessionId, action, driftId, currentCtrl);
    const latencyMs = Math.max(4, Math.round(performance.now() - t0));
    const timestamp = new Date().toISOString();

    if (res.httpStatus === 409) {
      setState((prev) => ({
        ...prev,
        selectedControlId: driftId,
        lastErrorBanner: res.message,
        lastActionSummary: null,
        traps: {
          ...prev.traps,
          auditorOverrideBlocked409: true
        }
      }));
    } else if (action === 'MARK_PASS') {
      setState((prev) => ({
        ...prev,
        selectedControlId: driftId,
        lastErrorBanner: null,
        lastActionSummary: `Auditor verified ${driftId} PASS with cryptographic SHA-256 evidence link.`,
        controls: {
          ...prev.controls,
          [driftId]: {
            ...prev.controls[driftId],
            auditorStatus: 'VERIFIED_PASS',
            remediationRequested: false,
            evidenceSha256: res.evidenceSha256,
            updatedAt: timestamp,
            storageOrigin: res.storageOrigin,
            auditorNote: 'Auditor verified cryptographic evidence link (PASS).'
          }
        },
        traps: {
          ...prev.traps,
          remediatedAndVerified: true
        }
      }));
    } else {
      setState((prev) => ({
        ...prev,
        selectedControlId: driftId,
        lastErrorBanner: null,
        lastActionSummary: `Remediation ticket dispatched to Cloud Engineer (Rohan Verma) for ${driftId}.`,
        controls: {
          ...prev.controls,
          [driftId]: {
            ...prev.controls[driftId],
            auditorStatus: 'REMEDIATION_REQUESTED',
            remediationRequested: true,
            updatedAt: timestamp,
            storageOrigin: res.storageOrigin,
            auditorNote: 'Auditor flagged non-compliant clause and requested remediation.'
          }
        }
      }));
    }

    recordSpan(
      createGrcSpan({
        sessionId,
        method: 'POST',
        path: '/api/grc-compliance/verify',
        status: res.httpStatus,
        latencyMs,
        executionOrigin: res.executionOrigin,
        telemetry: res.telemetry,
        responseSummary: res.rawPayload
      })
    );
    setBusyControl(null);
  };

  const attestationPack = useMemo(
    () => buildComplianceAttestationPack(sessionId, state),
    [sessionId, state]
  );

  const handleCopyAttestation = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(attestationPack, null, 2));
      setCopiedPack(true);
      window.setTimeout(() => setCopiedPack(false), 2000);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleDownloadAttestation = () => {
    const blob = new Blob([JSON.stringify(attestationPack, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `0trust-grc-attestation-${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const decodedProofSections: XRayDecodedProofSection[] = useMemo(
    () => [
      {
        id: 'posture-raw',
        label: `Posture Check Raw JSON (${selectedDef.checkId} · ${selectedLive.postureStatus})`,
        payload: {
          check_id: selectedDef.checkId,
          drift_id: selectedDef.id,
          scanner: selectedDef.scanner,
          resource: selectedDef.resourceArn,
          posture_status: selectedLive.postureStatus,
          evaluated_config:
            selectedLive.postureStatus === 'DRIFT'
              ? selectedDef.driftedConfig
              : selectedDef.baselineConfig,
          storage: selectedLive.storageOrigin,
          evaluated_at: selectedLive.updatedAt
        }
      },
      {
        id: 'framework-mapping',
        label: 'Cross-Framework Clause Mapping (BNM RMiT · ISO 27001:2022 · NIST CSF 2.0)',
        payload: {
          control_id: selectedDef.id,
          posture_status: selectedLive.postureStatus,
          auditor_status: selectedLive.auditorStatus,
          mapped_clauses: selectedDef.mappings
        }
      },
      {
        id: 'evidence-digest',
        label: 'SHA-256 Evidence Digest & Timestamp',
        payload: {
          session_id: sessionId,
          drift_id: selectedDef.id,
          evidence_sha256: selectedLive.evidenceSha256,
          timestamp: selectedLive.updatedAt,
          auditor_note: selectedLive.auditorNote
        }
      }
    ],
    [selectedDef, selectedLive, sessionId]
  );

  return (
    <div className="mission-control" style={{ paddingBottom: '88px' }}>
      {/* Top Bar */}
      <header className="lab-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={onBack}>
            <ArrowLeft size={14} /> All Labs
          </button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>
                Continuous Compliance &amp; BNM RMiT / ISO 27001 Mapper
              </span>
              <span className="badge badge-blue">Guided Sandbox · $0.00/mo</span>
              {readiness.driftedCount > 0 ? (
                <span className="badge badge-crimson">
                  Audit Score: {readiness.scorePct}% ({readiness.driftedCount} Drift)
                </span>
              ) : (
                <span className="badge badge-emerald">
                  Audit Score: {readiness.scorePct}% ({readiness.statusLabel})
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              Lab 8 · Archetype D (Audit &amp; Drift Investigation) · Session{' '}
              <span className="mono">{sessionId}</span> · 1h TTL
            </div>
          </div>
        </div>

        <button type="button" className="btn btn-sm" onClick={handleReset}>
          <RotateCcw size={14} /> Reset
        </button>
      </header>

      {/* 2-Seat Role Switcher */}
      <RoleSwitcherBar
        seats={seats}
        activeSeatId={activeSeat}
        onSelectSeat={setActiveSeat}
        ariaLabel="GRC Compliance 2-Seat Role Switcher"
      />

      {/* 4-Phase Stepper */}
      <nav aria-label="4-Phase Cognitive Arc" className="stepper-bar">
        {STAGE_ITEMS.map((item) => {
          const isActive = state.stage === item.id;
          const isDone = state.stage > item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelectStage(item.id)}
              className={`stage-pill ${isActive ? 'active' : ''} ${isDone ? 'completed' : ''}`}
            >
              <span className="stage-number">{item.id}</span>
              <span>
                <strong>{item.label}</strong>
                <span style={{ display: 'block', fontSize: '0.72rem', opacity: 0.85 }}>
                  {item.subtitle}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* Status / Fail-Closed 409 Alert Banner */}
      {state.lastErrorBanner && (
        <div
          role="alert"
          style={{
            marginTop: '14px',
            padding: '12px 16px',
            borderRadius: '10px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px'
          }}
        >
          <ShieldAlert size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '0.88rem' }}>
            <strong>409 EVIDENCE_DRIFT_MISMATCH (Fail-Closed):</strong> {state.lastErrorBanner}
          </div>
        </div>
      )}

      {state.lastActionSummary && !state.lastErrorBanner && (
        <div
          style={{
            marginTop: '14px',
            padding: '10px 14px',
            borderRadius: '10px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #bbf7d0',
            color: '#166534',
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
          <span>{state.lastActionSummary}</span>
        </div>
      )}

      {/* Phase 1: Discovery */}
      {state.stage === 1 && (
        <section style={{ marginTop: '18px', display: 'grid', gap: '16px' }}>
          <div className="surface-card">
            <div className="section-header" style={{ marginBottom: '12px' }}>
              <h2 className="section-title" style={{ fontSize: '1.1rem' }}>
                Phase 1 · Discovery: Posture-to-Regulation Architecture
              </h2>
              <p className="section-subtitle">
                Continuous compliance eliminates manual screenshot audits. Cloud posture scanners
                feed cryptographic SHA-256 evidence into a single cross-framework mapper covering{' '}
                <strong>BNM RMiT</strong>, <strong>ISO/IEC 27001:2022</strong>, and{' '}
                <strong>NIST CSF 2.0</strong>.
              </p>
            </div>

            <div className="grid-3">
              <div className="surface-card" style={{ padding: '14px' }}>
                <span className="badge badge-blue">1. Cloud &amp; CI Scanners</span>
                <h3 style={{ fontSize: '0.95rem', margin: '8px 0 4px' }}>
                  Live Posture Telemetry
                </h3>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                  Steampipe/Prowler IAM check, Cloudflare R2 Object Lock auditor, and CI DLP
                  classifier evaluate live cloud state.
                </p>
              </div>

              <div className="surface-card" style={{ padding: '14px' }}>
                <span className="badge badge-emerald">2. Cryptographic Evidence</span>
                <h3 style={{ fontSize: '0.95rem', margin: '8px 0 4px' }}>
                  SHA-256 Digest + Timestamp
                </h3>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                  Every posture evaluation hashes the resource state into an immutable{' '}
                  <span className="mono">lab8:grc:&lt;sid&gt;</span> record (1h TTL).
                </p>
              </div>

              <div className="surface-card" style={{ padding: '14px' }}>
                <span className="badge badge-amber">3. Fail-Closed Auditor Gate</span>
                <h3 style={{ fontSize: '0.95rem', margin: '8px 0 4px' }}>
                  409 Evidence Integrity
                </h3>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                  Auditors cannot manually override a <span className="mono">DRIFT</span> control to{' '}
                  <span className="mono">PASS</span> without underlying Cloud Engineer remediation.
                </p>
              </div>
            </div>
          </div>

          {/* Live 3x3 Cross-Framework Matrix */}
          <div className="surface-card">
            <h3 style={{ fontSize: '0.98rem', margin: '0 0 10px' }}>
              Cross-Framework Control Matrix (Live Status)
            </h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)', textAlign: 'left' }}>
                    <th style={{ padding: '8px' }}>Posture Check</th>
                    <th style={{ padding: '8px' }}>BNM RMiT</th>
                    <th style={{ padding: '8px' }}>ISO/IEC 27001:2022</th>
                    <th style={{ padding: '8px' }}>NIST CSF 2.0</th>
                    <th style={{ padding: '8px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {POSTURE_CHECK_CATALOG.map((def) => {
                    const live = state.controls[def.id];
                    return (
                      <tr
                        key={def.id}
                        style={{ borderBottom: '1px solid var(--border-subtle)' }}
                      >
                        <td style={{ padding: '8px', fontWeight: 600 }}>
                          {def.checkId} · {def.title}
                        </td>
                        <td style={{ padding: '8px' }}>{def.mappings[0].clauseId}</td>
                        <td style={{ padding: '8px' }}>{def.mappings[1].clauseId}</td>
                        <td style={{ padding: '8px' }}>{def.mappings[2].clauseId}</td>
                        <td style={{ padding: '8px' }}>
                          {live.postureStatus === 'PASS' ? (
                            <span className="badge badge-emerald">PASS</span>
                          ) : (
                            <span className="badge badge-crimson">DRIFT</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleSelectStage(2)}
              >
                Continue to Phase 2: Drift Injection <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Phase 2 & Phase 3: Active 2-Seat Workspace */}
      {(state.stage === 2 || state.stage === 3) && (
        <section style={{ marginTop: '18px', display: 'grid', gap: '16px' }}>
          <div className="surface-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '10px',
                marginBottom: '12px'
              }}
            >
              <div>
                <h2 className="section-title" style={{ fontSize: '1.08rem', margin: 0 }}>
                  {state.stage === 2
                    ? 'Phase 2 · Understanding: Inject Live Drift & Observe Multi-Framework Impact'
                    : 'Phase 3 · Practice: Auditor Workbench, 409 Trap & Remediation Loop'}
                </h2>
                <p style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  Active Seat:{' '}
                  <strong>
                    {activeSeat === 'cloud-engineer'
                      ? 'Rohan Verma (Cloud Engineer · Posture & Drift)'
                      : 'Claire Dubois (GRC Auditor · Evidence Reviewer)'}
                  </strong>
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setActiveSeat(activeSeat === 'cloud-engineer' ? 'auditor' : 'cloud-engineer')
                  }
                >
                  Switch to {activeSeat === 'cloud-engineer' ? 'Auditor Seat' : 'Cloud Engineer Seat'}
                </button>
                {state.stage === 2 ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      setActiveSeat('auditor');
                      handleSelectStage(3);
                    }}
                  >
                    Go to Phase 3 (Auditor Workbench) <ArrowRight size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => handleSelectStage(4)}
                  >
                    Go to Phase 4 (Reflection) <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Control Cards */}
            <div style={{ display: 'grid', gap: '14px' }}>
              {POSTURE_CHECK_CATALOG.map((def) => {
                const live = state.controls[def.id];
                const isDrift = live.postureStatus === 'DRIFT';
                const isSelected = state.selectedControlId === def.id;
                const isBusy = busyControl === def.id;

                return (
                  <div
                    key={def.id}
                    onClick={() => setState((prev) => ({ ...prev, selectedControlId: def.id }))}
                    style={{
                      padding: '14px',
                      borderRadius: '10px',
                      border: isSelected
                        ? '2px solid var(--accent-blue, #2563eb)'
                        : '1px solid var(--border-subtle)',
                      backgroundColor: isDrift ? '#fff5f5' : '#ffffff',
                      cursor: 'pointer'
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                        gap: '8px'
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span className="mono" style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                            {def.checkId}
                          </span>
                          <strong style={{ fontSize: '0.96rem' }}>{def.title}</strong>
                          {isDrift ? (
                            <span className="badge badge-crimson">POSTURE: DRIFT</span>
                          ) : (
                            <span className="badge badge-emerald">POSTURE: PASS</span>
                          )}
                          {live.auditorStatus === 'VERIFIED_PASS' && (
                            <span className="badge badge-emerald">AUDITOR: VERIFIED PASS</span>
                          )}
                          {live.auditorStatus === 'FLAGGED_DRIFT' && (
                            <span className="badge badge-crimson">AUDITOR: FLAGGED DRIFT</span>
                          )}
                          {live.auditorStatus === 'REMEDIATION_REQUESTED' && (
                            <span className="badge badge-amber">REMEDIATION REQUESTED</span>
                          )}
                        </div>
                        <div
                          className="mono"
                          style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}
                        >
                          {def.resourceArn} · SHA-256: {live.evidenceSha256.slice(0, 18)}…
                        </div>
                      </div>

                      {/* Seat-Specific Actions */}
                      <div
                        style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {activeSeat === 'cloud-engineer' ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-danger-soft btn-sm"
                              disabled={isBusy || isDrift}
                              onClick={() => handlePostureAction(def.id, 'INJECT_DRIFT')}
                            >
                              <AlertTriangle size={14} /> {def.driftLabel}
                            </button>
                            <button
                              type="button"
                              className="btn btn-emerald btn-sm"
                              disabled={isBusy || !isDrift}
                              onClick={() => handlePostureAction(def.id, 'REMEDIATE')}
                            >
                              <Wrench size={14} /> {def.remediationLabel}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-amber-soft btn-sm"
                              disabled={isBusy}
                              onClick={() => handleAuditorVerify(def.id, 'FLAG_REMEDIATION')}
                            >
                              <ShieldAlert size={14} /> Flag &amp; Request Remediation
                            </button>
                            <button
                              type="button"
                              className="btn btn-emerald btn-sm"
                              disabled={isBusy}
                              onClick={() => handleAuditorVerify(def.id, 'MARK_PASS')}
                            >
                              <ClipboardCheck size={14} /> Mark Clause PASS
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* 3-Framework Clauses Row */}
                    <div className="grid-3" style={{ marginTop: '12px' }}>
                      {def.mappings.map((m) => (
                        <div
                          key={m.framework}
                          style={{
                            padding: '10px',
                            borderRadius: '8px',
                            backgroundColor: isDrift ? '#fef2f2' : '#f8fafc',
                            border: isDrift ? '1px solid #fecaca' : '1px solid var(--border-subtle)'
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: '0.75rem',
                              fontWeight: 700
                            }}
                          >
                            <span>{m.framework}</span>
                            <span className={isDrift ? 'badge badge-crimson' : 'badge badge-emerald'}>
                              {isDrift ? 'DRIFT' : 'PASS'}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: '4px' }}>
                            {m.clauseId} · {m.clauseTitle}
                          </div>
                          <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {m.requirementSummary}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Phase 4: Reflection */}
      {state.stage === 4 && (
        <section style={{ marginTop: '18px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px' }}>
          <div className="surface-card" style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px'
              }}
            >
              <div>
                <h2 className="section-title" style={{ fontSize: '1.1rem', margin: 0 }}>
                  Phase 4 · Reflection: Audit-Readiness &amp; Compliance Attestation Pack
                </h2>
                <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  Cross-framework coverage across BNM RMiT, ISO/IEC 27001:2022, and NIST CSF 2.0
                  with cryptographic SHA-256 evidence links.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" onClick={handleCopyAttestation}>
                  <Copy size={14} /> {copiedPack ? 'Copied JSON' : 'Copy Attestation JSON'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleDownloadAttestation}
                >
                  <Download size={14} /> Export Attestation Pack
                </button>
              </div>
            </div>

            <div className="grid-3" style={{ marginTop: '14px' }}>
              <div className="surface-card" style={{ padding: '14px' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Audit-Readiness Score
                </div>
                <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '4px' }}>
                  {readiness.scorePct}%
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {readiness.verifiedCount} / {POSTURE_CHECK_CATALOG.length} controls verified PASS
                </div>
              </div>

              <div className="surface-card" style={{ padding: '14px' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Fail-Closed 409 Guardrail
                </div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: '6px' }}>
                  {state.traps.auditorOverrideBlocked409 ? (
                    <span className="badge badge-emerald">409 Trap Verified</span>
                  ) : (
                    <span className="badge badge-amber">Not Yet Tested</span>
                  )}
                </div>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Blocks manual PASS override when posture is DRIFT.
                </div>
              </div>

              <div className="surface-card" style={{ padding: '14px' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Drift Scenarios Explored
                </div>
                <div style={{ fontSize: '0.82rem', marginTop: '6px', display: 'grid', gap: '4px' }}>
                  <span>
                    {state.traps.iamDrift8A ? '✓' : '○'} 8A: IAM Wildcard / MFA Bypass
                  </span>
                  <span>
                    {state.traps.backupWormDrift8B ? '✓' : '○'} 8B: Backup WORM Disabled
                  </span>
                  <span>
                    {state.traps.piiUnmaskedDrift8C ? '✓' : '○'} 8C: Unencrypted / Unmasked PII
                  </span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: '14px', minWidth: 0, maxWidth: '100%' }}>
              <pre
                className="mono"
                style={{
                  fontSize: '0.74rem',
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: '#0f172a',
                  color: '#e2e8f0',
                  overflowX: 'auto',
                  maxWidth: '100%',
                  maxHeight: '260px',
                  margin: 0
                }}
              >
                {JSON.stringify(attestationPack, null, 2)}
              </pre>
            </div>
          </div>
        </section>
      )}

      {/* Sticky Bottom X-Ray Telemetry Drawer */}
      <XRayTelemetryDrawer
        spans={spans}
        decodedProofSections={decodedProofSections}
        onClear={() => setSpans([])}
      />
    </div>
  );
}
