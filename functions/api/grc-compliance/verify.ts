import {
  computeEvidenceSha256,
  DriftControlId,
  GrcEnv,
  loadSessionRecord,
  sanitizeSessionId,
  saveSessionRecord
} from './posture';

export type VerifyAction = 'MARK_PASS' | 'FLAG_REMEDIATION';

export interface VerifyRequest {
  sessionId?: string;
  action?: VerifyAction;
  drift_id?: DriftControlId;
  auditor_note?: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const KV_TTL_SECONDS = 3600;
const VALID_ACTIONS = new Set<VerifyAction>(['MARK_PASS', 'FLAG_REMEDIATION']);
const VALID_DRIFT_IDS = new Set<DriftControlId>([
  'IAM_MFA_BYPASS',
  'BACKUP_WORM_DISABLED',
  'PII_UNMASKED'
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestPost(context: {
  request: Request;
  env: GrcEnv;
}): Promise<Response> {
  const rawText = await context.request.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return jsonResponse(
      { error: 'PAYLOAD_TOO_LARGE', message: 'Request payload exceeds 64KB limit.' },
      413
    );
  }

  let body: VerifyRequest = {};
  if (rawText.trim().length > 0) {
    try {
      body = JSON.parse(rawText) as VerifyRequest;
    } catch {
      return jsonResponse(
        { error: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
        400
      );
    }
  }

  const sessionId = sanitizeSessionId(
    context.request.headers.get('X-Session-Id') || body.sessionId
  );

  if (!body.action || !VALID_ACTIONS.has(body.action)) {
    return jsonResponse(
      {
        error: 'INVALID_ACTION',
        message: 'action must be MARK_PASS or FLAG_REMEDIATION.'
      },
      400
    );
  }

  if (!body.drift_id || !VALID_DRIFT_IDS.has(body.drift_id)) {
    return jsonResponse(
      {
        error: 'INVALID_DRIFT_ID',
        message: 'drift_id must be IAM_MFA_BYPASS, BACKUP_WORM_DISABLED, or PII_UNMASKED.'
      },
      400
    );
  }

  const driftId = body.drift_id;
  const record = await loadSessionRecord(context.env, sessionId);
  const current = record.controls[driftId];
  const timestamp = new Date().toISOString();
  const safeNote = (body.auditor_note || '').slice(0, 240);

  if (body.action === 'MARK_PASS') {
    // Security Invariant: Fail-closed 409 if underlying posture check is DRIFT
    if (current.posture_status === 'DRIFT') {
      return jsonResponse(
        {
          error: 'EVIDENCE_DRIFT_MISMATCH',
          http_status: 409,
          drift_id: driftId,
          posture_status: current.posture_status,
          evidence_sha256: current.evidence_sha256,
          invariant: 'FAIL_CLOSED_EVIDENCE_INTEGRITY',
          kv_ttl_seconds: KV_TTL_SECONDS,
          timestamp,
          message: `Fail-closed 409: Cannot mark ${driftId} as PASS while underlying cloud posture check is DRIFT. Cloud Engineer must remediate posture first.`
        },
        409
      );
    }

    const verifiedDigest = await computeEvidenceSha256({
      session_id: sessionId,
      drift_id: driftId,
      posture_status: 'PASS',
      auditor_signoff: 'VERIFIED_PASS',
      previous_evidence_sha256: current.evidence_sha256,
      timestamp
    });

    record.controls[driftId] = {
      ...current,
      auditor_status: 'VERIFIED_PASS',
      remediation_requested: false,
      evidence_sha256: verifiedDigest,
      updated_at: timestamp,
      auditor_note: safeNote || 'Auditor verified cryptographic evidence link (PASS).'
    };
    record.updated_at = timestamp;
    const storage = await saveSessionRecord(context.env, sessionId, record);

    return jsonResponse({
      status: 'VERIFIED_PASS',
      http_status: 200,
      session_id: sessionId,
      drift_id: driftId,
      posture_status: 'PASS',
      evidence_sha256: verifiedDigest,
      controls: record.controls,
      storage,
      kv_ttl_seconds: KV_TTL_SECONDS,
      timestamp,
      message: `Control ${driftId} verified PASS with SHA-256 evidence digest.`
    });
  }

  // FLAG_REMEDIATION
  record.controls[driftId] = {
    ...current,
    auditor_status: 'REMEDIATION_REQUESTED',
    remediation_requested: true,
    updated_at: timestamp,
    auditor_note:
      safeNote ||
      `Auditor flagged ${driftId} for mandatory Cloud Engineer remediation before sign-off.`
  };
  record.updated_at = timestamp;
  const storage = await saveSessionRecord(context.env, sessionId, record);

  return jsonResponse({
    status: 'REMEDIATION_REQUESTED',
    http_status: 200,
    session_id: sessionId,
    drift_id: driftId,
    posture_status: current.posture_status,
    evidence_sha256: current.evidence_sha256,
    controls: record.controls,
    storage,
    kv_ttl_seconds: KV_TTL_SECONDS,
    timestamp,
    message: `Remediation ticket dispatched to Cloud Engineer for ${driftId}.`
  });
}
