import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Cloud, Compass, Download, RotateCcw } from 'lucide-react';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import {
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
import {
  selectGlobalStatusLabel,
  selectGrcSeatBadges
} from '../engine/grcComplianceSelectors';
import { RoleSeatItem, RoleSwitcherBar } from '../components/RoleSwitcherBar';
import { XRayDecodedProofSection, XRayTelemetryDrawer } from '../components/XRayTelemetryDrawer';
import { ObservabilitySpan } from '../types';

export interface GrcCompliancePageProps {
  onBack: () => void;
}

export function GrcCompliancePage({ onBack }: GrcCompliancePageProps) {
  const [sessionId, setSessionId] = useState<string>(() => createGrcSessionId());
  const sessionIdRef = useRef<string>(sessionId);
  sessionIdRef.current = sessionId;

  const [activeSeat, setActiveSeat] = useState<GrcSeatId>('cloud-engineer');
  const [state, setState] = useState<GrcComplianceState>(() => createInitialGrcState());
  const [busyControl, setBusyControl] = useState<DriftControlId | null>(null);
  const [spans, setSpans] = useState<ObservabilitySpan[]>([]);

  const tourLaunchedRef = useRef<boolean>(false);

  const recordSpan = useCallback((span: ObservabilitySpan) => {
    setSpans((prev) => [span, ...prev].slice(0, 40));
  }, []);

  useEffect(() => {
    recordSpan(
      createGrcSpan({
        sessionId: sessionIdRef.current,
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
  }, [recordSpan]);

  const startLabTour = useCallback(() => {
    const driverObj = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      overlayOpacity: 0.5,
      steps: [
        {
          popover: {
            title: 'Lab Orientation: Continuous Compliance & Regulatory Mapper',
            description:
              'See how live cloud configuration posture maps directly to BNM RMiT, ISO/IEC 27001:2022, and NIST CSF 2.0 clauses with cryptographic SHA-256 evidence verification.'
          }
        },
        {
          element: '#tour-role-switcher',
          popover: {
            title: 'Role Switcher',
            description:
              'Switch between Rohan Verma (Cloud Engineer) and Claire Dubois (GRC Auditor). Notification dots highlight configuration drift or remediation requests.'
          }
        },
        {
          element: '#tour-workspace',
          popover: {
            title: 'Role Workspace',
            description:
              'Start as Rohan Verma to modify or harden production cloud resource configurations, then switch to Claire Dubois to inspect regulatory clauses and verify evidence digests.'
          }
        },
        {
          element: '.xray-drawer',
          popover: {
            title: 'X-Ray Telemetry Drawer',
            description:
              'Expand this bottom drawer anytime to inspect live HTTP spans, raw posture scanner outputs, cross-framework mappings, and SHA-256 evidence digests.'
          }
        },
        {
          element: '#tour-lab-controls',
          popover: {
            title: 'Lab Controls',
            description:
              'Use Lab Tour to replay this orientation, or Reset to restore all cloud controls to their verified baseline posture.'
          }
        }
      ]
    });
    driverObj.drive();
  }, []);

  useEffect(() => {
    if (tourLaunchedRef.current) return;
    tourLaunchedRef.current = true;
    const timer = window.setTimeout(() => {
      startLabTour();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [startLabTour]);

  const readiness = useMemo(() => computeAuditReadinessScore(state), [state]);

  const hasRemediationTicket = useMemo(
    () => Object.values(state.controls).some((c) => c.remediationRequested),
    [state.controls]
  );

  const globalStatusLabel = selectGlobalStatusLabel(
    readiness,
    POSTURE_CHECK_CATALOG.length
  );

  const seats: RoleSeatItem<GrcSeatId>[] = useMemo(() => {
    const { engineerBadge, auditorBadge } = selectGrcSeatBadges(
      hasRemediationTicket,
      readiness,
      POSTURE_CHECK_CATALOG.length
    );

    return [
      {
        id: 'cloud-engineer',
        name: 'Rohan Verma',
        roleLabel: 'Cloud Engineer',
        appLabel: 'Cloud Resource Config',
        avatarInitials: 'RV',
        badge: engineerBadge
      },
      {
        id: 'auditor',
        name: 'Claire Dubois',
        roleLabel: 'GRC Auditor',
        appLabel: 'Compliance Control & Evidence Matrix',
        avatarInitials: 'CD',
        badge: auditorBadge
      }
    ];
  }, [hasRemediationTicket, readiness]);

  const selectedDef = useMemo(
    () =>
      POSTURE_CHECK_CATALOG.find((d) => d.id === state.selectedControlId) ||
      POSTURE_CHECK_CATALOG[0],
    [state.selectedControlId]
  );
  const selectedLive = state.controls[selectedDef.id];

  const handleReset = async () => {
    const nextSid = createGrcSessionId();
    sessionIdRef.current = nextSid;
    setSessionId(nextSid);
    setActiveSeat('cloud-engineer');
    setState(createInitialGrcState());
    setBusyControl(null);
    const res = await callPostureApi(nextSid, 'RESET');
    if (sessionIdRef.current !== nextSid) return;
    setSpans([
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
    ]);
  };

  const handlePostureAction = async (
    driftId: DriftControlId,
    action: 'INJECT_DRIFT' | 'REMEDIATE'
  ) => {
    const currentSid = sessionIdRef.current;
    setBusyControl(driftId);
    const t0 = performance.now();
    const res = await callPostureApi(currentSid, action, driftId, state.controls);
    if (sessionIdRef.current !== currentSid) return;
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
            ? `Updated ${driftId} to non-compliant configuration — mapped BNM RMiT, ISO 27001, and NIST CSF 2.0 controls flagged as DRIFT.`
            : `Restored hardened baseline for ${driftId} and refreshed SHA-256 evidence digest.`,
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
                : 'Posture remediated by Cloud Engineer; evidence digest refreshed.'
          }
        },
        traps: {
          ...prev.traps,
          iamDrift8A:
            prev.traps.iamDrift8A || (driftId === 'IAM_MFA_BYPASS' && action === 'INJECT_DRIFT'),
          backupWormDrift8B:
            prev.traps.backupWormDrift8B ||
            (driftId === 'BACKUP_WORM_DISABLED' && action === 'INJECT_DRIFT'),
          piiUnmaskedDrift8C:
            prev.traps.piiUnmaskedDrift8C ||
            (driftId === 'PII_UNMASKED' && action === 'INJECT_DRIFT')
        }
      };
    });

    recordSpan(
      createGrcSpan({
        sessionId: currentSid,
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
    const currentSid = sessionIdRef.current;
    setBusyControl(driftId);
    const t0 = performance.now();
    const currentCtrl = state.controls[driftId];
    const res = await callVerifyApi(currentSid, action, driftId, currentCtrl);
    if (sessionIdRef.current !== currentSid) return;
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
        lastActionSummary: `Verified ${driftId} PASS with cryptographic SHA-256 evidence digest.`,
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
        lastActionSummary: `Remediation request logged for ${driftId}.`,
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
        sessionId: currentSid,
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

  const handleDownloadAttestation = () => {
    const blob = new Blob([JSON.stringify(attestationPack, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lab8-grc-attestation-${sessionId}.json`;
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
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-canvas)',
        color: 'var(--text-primary)'
      }}
    >
      {/* 1. Compact AppShell Top Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          backgroundColor: 'rgba(255, 255, 255, 0.96)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        <div
          style={{
            maxWidth: '1280px',
            margin: '0 auto',
            padding: '0 16px',
            height: '56px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <button
              type="button"
              onClick={onBack}
              className="btn btn-sm"
              style={{ padding: '5px 9px' }}
              title="All Labs"
            >
              <ArrowLeft size={13} />
              <span>All Labs</span>
            </button>
            <span
              style={{
                fontSize: '14px',
                fontWeight: 700,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap'
              }}
            >
              Continuous Compliance &amp; BNM RMiT / ISO 27001 Mapper
            </span>
            <span
              className={`badge ${
                readiness.driftedCount > 0
                  ? 'badge-crimson'
                  : readiness.verifiedCount === POSTURE_CHECK_CATALOG.length
                    ? 'badge-emerald'
                    : 'badge-amber'
              }`}
              style={{ whiteSpace: 'nowrap', fontSize: '12px' }}
            >
              {globalStatusLabel}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <RoleSwitcherBar
              seats={seats}
              activeSeatId={activeSeat}
              onSelectSeat={setActiveSeat}
              variant="dropdown"
              ariaLabel="Switch workspace persona"
            />

            <div id="tour-lab-controls" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                type="button"
                onClick={startLabTour}
                className="btn btn-sm"
                style={{
                  backgroundColor: 'var(--accent-primary-dim)',
                  borderColor: 'var(--accent-primary-border)',
                  color: 'var(--accent-primary-ink)',
                  fontSize: '13px'
                }}
              >
                <Compass size={14} />
                <span>Lab Tour</span>
              </button>
              <button
                type="button"
                onClick={() => void handleReset()}
                className="btn btn-sm"
                style={{ fontSize: '13px' }}
              >
                <RotateCcw size={14} />
                <span>Reset</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 2. Center Role Workspace */}
      <main id="tour-workspace" style={{ flex: 1, padding: '16px', paddingBottom: '88px' }}>
        <div
          style={{
            maxWidth: '1280px',
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }}
        >
          {/* ==================== SEAT 1: ROHAN VERMA — CLOUD RESOURCE CONFIG ==================== */}
          {activeSeat === 'cloud-engineer' && (
            <section
              aria-label="Cloud Resource Configuration"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-sm)',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  padding: '10px 18px',
                  backgroundColor: '#0f172a',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    style={{
                      width: '26px',
                      height: '26px',
                      borderRadius: '5px',
                      backgroundColor: '#2563eb',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '12px'
                    }}
                  >
                    <Cloud size={15} />
                  </span>
                  <span style={{ fontSize: '15px', fontWeight: 700 }}>
                    Cloud Resource Configuration Console
                  </span>
                </div>
                <span style={{ fontSize: '13.5px', color: '#e2e8f0' }}>
                  Rohan Verma · Cloud Engineer
                </span>
              </div>

              <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <h2 style={{ fontSize: '15.5px', fontWeight: 700, margin: 0 }}>
                    Production Cloud Resources &amp; Live Posture
                  </h2>
                  <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    Manage production IAM, R2 Object Lock, and KMS/DLP configurations. Changes immediately re-compute SHA-256 posture evidence.
                  </p>
                </div>

                {state.lastActionSummary && (
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--accent-primary-dim)',
                      border: '1px solid var(--accent-primary-border)',
                      color: 'var(--accent-primary-ink)',
                      fontSize: '13.5px'
                    }}
                  >
                    {state.lastActionSummary}
                  </div>
                )}

                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Control &amp; Resource</th>
                        <th>Scanner</th>
                        <th>Posture Status</th>
                        <th>Audit Queue</th>
                        <th style={{ textAlign: 'right' }}>Configuration Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {POSTURE_CHECK_CATALOG.map((def) => {
                        const live = state.controls[def.id];
                        const isDrifted = live.postureStatus === 'DRIFT';
                        const isSelected = state.selectedControlId === def.id;
                        const isBusy = busyControl === def.id;

                        return (
                          <tr
                            key={def.id}
                            className={`clickable-row${isSelected ? ' selected-row' : ''}`}
                            onClick={() =>
                              setState((prev) => ({ ...prev, selectedControlId: def.id }))
                            }
                          >
                            <td>
                              <div style={{ fontWeight: 700, fontSize: '14px' }}>
                                {def.checkId} · {def.title}
                              </div>
                              <div className="mono" style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                                {def.resourceArn}
                              </div>
                            </td>
                            <td className="mono" style={{ fontSize: '12.5px' }}>
                              {def.scanner}
                            </td>
                            <td>
                              {isDrifted ? (
                                <span className="badge badge-crimson">DRIFT</span>
                              ) : (
                                <span className="badge badge-emerald">COMPLIANT</span>
                              )}
                            </td>
                            <td>
                              {live.remediationRequested ? (
                                <span className="badge badge-amber">REMEDIATION REQ</span>
                              ) : isDrifted ? (
                                <span className="badge badge-crimson">FLAGGED</span>
                              ) : (
                                <span className="badge">NO OPEN TICKETS</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {isDrifted ? (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  style={{ fontSize: '13px', padding: '6px 12px' }}
                                  disabled={busyControl !== null}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handlePostureAction(def.id, 'REMEDIATE');
                                  }}
                                >
                                  {isBusy ? 'Applying…' : 'Enforce Baseline'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  style={{ fontSize: '13px', padding: '6px 12px' }}
                                  disabled={busyControl !== null}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handlePostureAction(def.id, 'INJECT_DRIFT');
                                  }}
                                >
                                  {isBusy ? 'Updating…' : 'Switch to Legacy Config'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Live Resource Configuration JSON Preview */}
                <div
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-canvas)',
                    padding: '14px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '8px'
                    }}
                  >
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>
                      Active Configuration — {selectedDef.checkId} ({selectedDef.title})
                    </div>
                    <span className="mono" style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                      SHA-256: {selectedLive.evidenceSha256.slice(0, 16)}…
                    </span>
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: '12px 14px',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                      fontSize: '13px',
                      lineHeight: 1.55,
                      overflowX: 'auto',
                      color: 'var(--text-primary)'
                    }}
                  >
                    {JSON.stringify(
                      selectedLive.postureStatus === 'DRIFT'
                        ? selectedDef.driftedConfig
                        : selectedDef.baselineConfig,
                      null,
                      2
                    )}
                  </pre>
                </div>
              </div>
            </section>
          )}

          {/* ==================== SEAT 2: CLAIRE DUBOIS — COMPLIANCE CONTROL & EVIDENCE MATRIX ==================== */}
          {activeSeat === 'auditor' && (
            <section
              aria-label="Compliance Control and Evidence Matrix"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-sm)',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  padding: '10px 18px',
                  backgroundColor: 'var(--bg-canvas)',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    style={{
                      width: '26px',
                      height: '26px',
                      borderRadius: '5px',
                      backgroundColor: '#7c3aed',
                      color: '#ffffff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '12px'
                    }}
                  >
                    GR
                  </span>
                  <span style={{ fontSize: '15px', fontWeight: 700 }}>
                    Compliance Control &amp; Evidence Matrix
                  </span>
                </div>
                <span style={{ fontSize: '13.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Claire Dubois · GRC Auditor
                </span>
              </div>

              <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '12px'
                  }}
                >
                  <div>
                    <h2 style={{ fontSize: '15.5px', fontWeight: 700, margin: 0 }}>
                      Regulatory Control Matrix (BNM RMiT · ISO 27001:2022 · NIST CSF 2.0)
                    </h2>
                    <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                      Readiness: <strong>{readiness.scorePct}%</strong> ({readiness.verifiedCount}/{POSTURE_CHECK_CATALOG.length} verified PASS). Sign-off fails closed (HTTP 409) whenever live posture is drifted.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: '13px', padding: '7px 12px' }}
                    onClick={handleDownloadAttestation}
                  >
                    <Download size={14} />
                    <span>Export Attestation JSON</span>
                  </button>
                </div>

                {state.lastErrorBanner && (
                  <div
                    role="alert"
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--accent-crimson-dim)',
                      border: '1px solid var(--accent-crimson-border)',
                      color: 'var(--accent-crimson-ink)',
                      fontSize: '13.5px'
                    }}
                  >
                    <strong>Evidence Integrity Check Failed (HTTP 409):</strong>{' '}
                    {state.lastErrorBanner}
                  </div>
                )}

                {state.lastActionSummary && !state.lastErrorBanner && (
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--accent-emerald-dim)',
                      border: '1px solid var(--accent-emerald-border)',
                      color: 'var(--accent-emerald-ink)',
                      fontSize: '13.5px'
                    }}
                  >
                    {state.lastActionSummary}
                  </div>
                )}

                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Control</th>
                        <th>Regulatory Clauses</th>
                        <th>Live Posture</th>
                        <th>Evidence Digest</th>
                        <th>Sign-Off Status</th>
                        <th style={{ textAlign: 'right' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {POSTURE_CHECK_CATALOG.map((def) => {
                        const live = state.controls[def.id];
                        const isDrifted = live.postureStatus === 'DRIFT';
                        const isVerified =
                          !isDrifted && live.auditorStatus === 'VERIFIED_PASS';
                        const isBusy = busyControl === def.id;

                        return (
                          <tr
                            key={def.id}
                            className={`clickable-row${
                              state.selectedControlId === def.id ? ' selected-row' : ''
                            }`}
                            onClick={() =>
                              setState((prev) => ({ ...prev, selectedControlId: def.id }))
                            }
                          >
                            <td>
                              <div style={{ fontWeight: 700, fontSize: '14px' }}>
                                {def.checkId} · {def.title}
                              </div>
                              <div className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                {def.resourceArn}
                              </div>
                            </td>
                            <td>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {def.mappings.map((m) => (
                                  <span
                                    key={`${def.id}-${m.framework}`}
                                    style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}
                                  >
                                    <strong>{m.framework}:</strong> {m.clauseId}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td>
                              {isDrifted ? (
                                <span className="badge badge-crimson">DRIFT</span>
                              ) : (
                                <span className="badge badge-emerald">PASS</span>
                              )}
                            </td>
                            <td className="mono" style={{ fontSize: '12.5px' }}>
                              {live.evidenceSha256.slice(0, 12)}…
                            </td>
                            <td>
                              {isVerified ? (
                                <span className="badge badge-emerald">VERIFIED PASS</span>
                              ) : live.auditorStatus === 'REMEDIATION_REQUESTED' ? (
                                <span className="badge badge-amber">REMEDIATION REQ</span>
                              ) : (
                                <span className="badge badge-crimson">FLAGGED DRIFT</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'inline-flex', gap: '6px', justifyContent: 'flex-end' }}>
                                {isDrifted && (
                                  <button
                                    type="button"
                                    className="btn btn-amber-soft btn-sm"
                                    style={{ fontSize: '13px', padding: '6px 10px' }}
                                    disabled={busyControl !== null || live.remediationRequested}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleAuditorVerify(def.id, 'FLAG_REMEDIATION');
                                    }}
                                  >
                                    {live.remediationRequested ? 'Requested' : 'Request Remediation'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  style={{ fontSize: '13px', padding: '6px 10px' }}
                                  disabled={busyControl !== null || isVerified}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleAuditorVerify(def.id, 'MARK_PASS');
                                  }}
                                >
                                  {isBusy ? 'Verifying…' : isVerified ? 'Verified' : 'Verify & Sign Off'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>

      {/* 3. Sticky-Bottom X-Ray Telemetry Drawer */}
      <XRayTelemetryDrawer
        spans={spans}
        decodedProofSections={decodedProofSections}
        onClear={() => setSpans([])}
      />
    </div>
  );
}
