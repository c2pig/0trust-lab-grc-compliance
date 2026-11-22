import {
  ControlLiveState,
  DriftControlId,
  GrcComplianceState,
  POSTURE_CHECK_CATALOG
} from '../contracts/grcComplianceContract';
import { ObservabilitySpan } from '../types';

export function createGrcSessionId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `grc-${hex}`;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(payload: unknown): Promise<string> {
  const text = JSON.stringify(payload);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return randomHex(32);
}

function deterministicSyncHash(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.repeat(4);
}

export function createInitialGrcState(): GrcComplianceState {
  const now = new Date().toISOString();
  const controls = {} as Record<DriftControlId, ControlLiveState>;

  for (const def of POSTURE_CHECK_CATALOG) {
    controls[def.id] = {
      driftId: def.id,
      postureStatus: 'PASS',
      auditorStatus: 'VERIFIED_PASS',
      remediationRequested: false,
      evidenceSha256: deterministicSyncHash(`${def.id}:PASS:BASELINE`),
      updatedAt: now,
      auditorNote: `Baseline ${def.checkId} verified PASS across BNM RMiT, ISO 27001, and NIST CSF 2.0.`,
      storageOrigin: 'client-sandbox-fallback'
    };
  }

  return {
    stage: 1,
    controls,
    selectedControlId: 'IAM_MFA_BYPASS',
    lastErrorBanner: null,
    lastActionSummary: null,
    traps: {
      iamDrift8A: false,
      backupWormDrift8B: false,
      piiUnmaskedDrift8C: false,
      auditorOverrideBlocked409: false,
      remediatedAndVerified: false
    }
  };
}

export function createGrcSpan(input: {
  sessionId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  executionOrigin: 'cloudflare-edge' | 'browser-webcrypto-fallback';
  responseSummary: Record<string, unknown>;
  telemetry?: {
    traceparent?: string;
    trace_id?: string;
    span_id?: string;
    parent_span_id?: string;
    otlp_export?: 'configured' | 'in-lab-only';
  };
}): ObservabilitySpan {
  const traceId = input.telemetry?.trace_id || randomHex(16);
  const spanId = input.telemetry?.span_id || randomHex(8);
  return {
    id: `span-${randomHex(6)}`,
    traceparent: input.telemetry?.traceparent || `00-${traceId}-${spanId}-01`,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: input.telemetry?.parent_span_id || '0000000000000000',
    session_id: input.sessionId,
    method: input.method,
    path: input.path,
    status: input.status,
    latency_ms: input.latencyMs,
    timestamp: new Date().toISOString(),
    otlp_export: input.telemetry?.otlp_export || 'in-lab-only',
    redacted_auth_header: null,
    redaction_applied: false,
    execution_origin: input.executionOrigin,
    response_summary: input.responseSummary
  };
}

export interface ApiCallResult {
  httpStatus: number;
  executionOrigin: 'cloudflare-edge' | 'browser-webcrypto-fallback';
  storageOrigin: 'cloudflare-kv' | 'ephemeral-edge' | 'client-sandbox-fallback';
  evidenceSha256: string;
  message: string;
  errorCode?: string;
  telemetry?: {
    traceparent?: string;
    trace_id?: string;
    span_id?: string;
    parent_span_id?: string;
    otlp_export?: 'configured' | 'in-lab-only';
  };
  rawPayload: Record<string, unknown>;
}

function isEdgeApiLikelyAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  const port = window.location.port;
  // vite dev (5182) and vite preview (4182) have no Edge Functions; wrangler pages dev uses 8788
  if ((host === 'localhost' || host === '127.0.0.1') && port !== '8788') {
    return false;
  }
  return true;
}

export async function callPostureApi(
  sessionId: string,
  action: 'INJECT_DRIFT' | 'REMEDIATE' | 'RESET',
  driftId?: DriftControlId,
  currentControls?: Record<DriftControlId, ControlLiveState>
): Promise<ApiCallResult> {
  const path = '/api/grc-compliance/posture';
  if (isEdgeApiLikelyAvailable()) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId
        },
        body: JSON.stringify({ sessionId, action, drift_id: driftId })
      });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = (await res.json()) as Record<string, unknown>;
        return {
          httpStatus: res.status,
          executionOrigin: 'cloudflare-edge',
          storageOrigin:
            (data.storage as 'cloudflare-kv' | 'ephemeral-edge') || 'ephemeral-edge',
          evidenceSha256: String(data.evidence_sha256 || deterministicSyncHash(sessionId)),
          message: String(data.status || 'OK'),
          errorCode: data.error ? String(data.error) : undefined,
          telemetry: data._telemetry as ApiCallResult['telemetry'],
          rawPayload: data
        };
      }
    } catch {
      // Fall through to deterministic $0/mo client-side simulation
    }
  }

  const timestamp = new Date().toISOString();
  if (action === 'RESET' || !driftId) {
    const hash = await sha256Hex({ sessionId, action: 'RESET', timestamp });
    return {
      httpStatus: 200,
      executionOrigin: 'browser-webcrypto-fallback',
      storageOrigin: 'client-sandbox-fallback',
      evidenceSha256: hash,
      message: 'RESET_COMPLETE',
      rawPayload: {
        status: 'RESET_COMPLETE',
        session_id: sessionId,
        storage: 'client-sandbox-fallback',
        kv_ttl_seconds: 3600,
        timestamp
      }
    };
  }

  const def = POSTURE_CHECK_CATALOG.find((d) => d.id === driftId)!;
  const nextStatus = action === 'INJECT_DRIFT' ? 'DRIFT' : 'PASS';
  const hash = await sha256Hex({
    sessionId,
    check_id: def.checkId,
    drift_id: driftId,
    posture_status: nextStatus,
    previous_hash: currentControls?.[driftId]?.evidenceSha256,
    timestamp
  });

  return {
    httpStatus: 200,
    executionOrigin: 'browser-webcrypto-fallback',
    storageOrigin: 'client-sandbox-fallback',
    evidenceSha256: hash,
    message: nextStatus === 'DRIFT' ? 'DRIFT_INJECTED' : 'POSTURE_REMEDIATED',
    rawPayload: {
      status: nextStatus === 'DRIFT' ? 'DRIFT_INJECTED' : 'POSTURE_REMEDIATED',
      session_id: sessionId,
      drift_id: driftId,
      check_id: def.checkId,
      posture_status: nextStatus,
      evidence_sha256: hash,
      framework_mappings: def.mappings.map((m) => `${m.framework} ${m.clauseId}`),
      storage: 'client-sandbox-fallback',
      kv_ttl_seconds: 3600,
      timestamp
    }
  };
}

export async function callVerifyApi(
  sessionId: string,
  action: 'MARK_PASS' | 'FLAG_REMEDIATION',
  driftId: DriftControlId,
  currentControl: ControlLiveState,
  auditorNote?: string
): Promise<ApiCallResult> {
  const path = '/api/grc-compliance/verify';
  if (isEdgeApiLikelyAvailable()) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId
        },
        body: JSON.stringify({
          sessionId,
          action,
          drift_id: driftId,
          auditor_note: auditorNote
        })
      });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = (await res.json()) as Record<string, unknown>;
        return {
          httpStatus: res.status,
          executionOrigin: 'cloudflare-edge',
          storageOrigin:
            (data.storage as 'cloudflare-kv' | 'ephemeral-edge') || 'ephemeral-edge',
          evidenceSha256: String(data.evidence_sha256 || currentControl.evidenceSha256),
          message: String(data.message || data.status || 'OK'),
          errorCode: data.error ? String(data.error) : undefined,
          telemetry: data._telemetry as ApiCallResult['telemetry'],
          rawPayload: data
        };
      }
    } catch {
      // Fall through to deterministic $0/mo client-side simulation
    }
  }

  const timestamp = new Date().toISOString();

  if (action === 'MARK_PASS') {
    // Security Invariant: Fail-closed 409 if underlying posture check is DRIFT
    if (currentControl.postureStatus === 'DRIFT') {
      return {
        httpStatus: 409,
        executionOrigin: 'browser-webcrypto-fallback',
        storageOrigin: 'client-sandbox-fallback',
        evidenceSha256: currentControl.evidenceSha256,
        errorCode: 'EVIDENCE_DRIFT_MISMATCH',
        message: `Fail-closed 409: Cannot mark ${driftId} as PASS while underlying cloud posture check is DRIFT. Cloud Engineer must remediate posture first.`,
        rawPayload: {
          error: 'EVIDENCE_DRIFT_MISMATCH',
          http_status: 409,
          drift_id: driftId,
          posture_status: 'DRIFT',
          evidence_sha256: currentControl.evidenceSha256,
          invariant: 'FAIL_CLOSED_EVIDENCE_INTEGRITY',
          storage: 'client-sandbox-fallback',
          timestamp
        }
      };
    }

    const verifiedDigest = await sha256Hex({
      sessionId,
      drift_id: driftId,
      posture_status: 'PASS',
      auditor_signoff: 'VERIFIED_PASS',
      previous_evidence_sha256: currentControl.evidenceSha256,
      timestamp
    });

    return {
      httpStatus: 200,
      executionOrigin: 'browser-webcrypto-fallback',
      storageOrigin: 'client-sandbox-fallback',
      evidenceSha256: verifiedDigest,
      message: `Control ${driftId} verified PASS with SHA-256 evidence digest.`,
      rawPayload: {
        status: 'VERIFIED_PASS',
        http_status: 200,
        session_id: sessionId,
        drift_id: driftId,
        posture_status: 'PASS',
        evidence_sha256: verifiedDigest,
        storage: 'client-sandbox-fallback',
        kv_ttl_seconds: 3600,
        timestamp
      }
    };
  }

  return {
    httpStatus: 200,
    executionOrigin: 'browser-webcrypto-fallback',
    storageOrigin: 'client-sandbox-fallback',
    evidenceSha256: currentControl.evidenceSha256,
    message: `Remediation ticket dispatched to Cloud Engineer for ${driftId}.`,
    rawPayload: {
      status: 'REMEDIATION_REQUESTED',
      http_status: 200,
      session_id: sessionId,
      drift_id: driftId,
      posture_status: currentControl.postureStatus,
      evidence_sha256: currentControl.evidenceSha256,
      storage: 'client-sandbox-fallback',
      timestamp
    }
  };
}

export function computeAuditReadinessScore(state: GrcComplianceState): {
  scorePct: number;
  passingCount: number;
  driftedCount: number;
  verifiedCount: number;
  statusLabel: 'AUDIT_READY' | 'NON_COMPLIANT_DRIFT' | 'PENDING_SIGN_OFF';
} {
  const values = Object.values(state.controls);
  const passingCount = values.filter((c) => c.postureStatus === 'PASS').length;
  const driftedCount = values.filter((c) => c.postureStatus === 'DRIFT').length;
  const verifiedCount = values.filter(
    (c) => c.postureStatus === 'PASS' && c.auditorStatus === 'VERIFIED_PASS'
  ).length;

  const scorePct = Math.round((verifiedCount / values.length) * 100);
  const statusLabel =
    driftedCount > 0
      ? 'NON_COMPLIANT_DRIFT'
      : verifiedCount === values.length
        ? 'AUDIT_READY'
        : 'PENDING_SIGN_OFF';

  return { scorePct, passingCount, driftedCount, verifiedCount, statusLabel };
}

export function buildComplianceAttestationPack(
  sessionId: string,
  state: GrcComplianceState
): Record<string, unknown> {
  const readiness = computeAuditReadinessScore(state);
  return {
    attestation_version: '2026.11-grc-continuous',
    lab_id: 'grc-compliance',
    session_id: sessionId,
    generated_at: new Date().toISOString(),
    audit_readiness: readiness,
    frameworks_covered: ['BNM RMiT', 'ISO/IEC 27001:2022', 'NIST CSF 2.0'],
    controls: POSTURE_CHECK_CATALOG.map((def) => {
      const live = state.controls[def.id];
      return {
        check_id: def.checkId,
        drift_id: def.id,
        title: def.title,
        resource: def.resourceArn,
        posture_status: live.postureStatus,
        auditor_status: live.auditorStatus,
        evidence_sha256: live.evidenceSha256,
        updated_at: live.updatedAt,
        auditor_note: live.auditorNote,
        regulatory_mappings: def.mappings
      };
    }),
    traps_explored: state.traps
  };
}
