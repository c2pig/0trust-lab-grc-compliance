export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export type DriftControlId = 'IAM_MFA_BYPASS' | 'BACKUP_WORM_DISABLED' | 'PII_UNMASKED';
export type PostureAction = 'INJECT_DRIFT' | 'REMEDIATE' | 'RESET';

export interface GrcEnv {
  STATE_KV?: KVNamespace;
  ENVIRONMENT?: string;
}

export interface PostureRequest {
  sessionId?: string;
  action?: PostureAction;
  drift_id?: DriftControlId;
  actor?: string;
}

export interface StoredControlRecord {
  drift_id: DriftControlId;
  posture_status: 'PASS' | 'DRIFT';
  auditor_status: 'VERIFIED_PASS' | 'FLAGGED_DRIFT' | 'REMEDIATION_REQUESTED';
  evidence_sha256: string;
  updated_at: string;
  remediation_requested: boolean;
  auditor_note: string;
}

export interface GrcSessionKvRecord {
  session_id: string;
  controls: Record<DriftControlId, StoredControlRecord>;
  updated_at: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const KV_TTL_SECONDS = 3600;
const VALID_ACTIONS = new Set<PostureAction>(['INJECT_DRIFT', 'REMEDIATE', 'RESET']);
const VALID_DRIFT_IDS = new Set<DriftControlId>([
  'IAM_MFA_BYPASS',
  'BACKUP_WORM_DISABLED',
  'PII_UNMASKED'
]);

export const ephemeralGrcStore = new Map<string, GrcSessionKvRecord>();

export function sanitizeSessionId(raw: string | null | undefined): string {
  if (!raw) return 'demo-visitor';
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'demo-visitor';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function computeEvidenceSha256(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const FRAMEWORK_MAP: Record<
  DriftControlId,
  {
    check_id: string;
    bnm_rmit: string;
    iso_27001: string;
    nist_csf: string;
    scanner: string;
    resource: string;
  }
> = {
  IAM_MFA_BYPASS: {
    check_id: 'CHK-IAM-01',
    bnm_rmit: 'BNM RMiT 10.5x (Privileged Access & Strong Authentication)',
    iso_27001: 'ISO/IEC 27001:2022 A.5.15 / A.8.5',
    nist_csf: 'NIST CSF 2.0 PR.AA-01',
    scanner: 'steampipe-aws-iam-prowler',
    resource: 'arn:aws:iam::104928374612:policy/CloudAdminPolicy'
  },
  BACKUP_WORM_DISABLED: {
    check_id: 'CHK-BKP-02',
    bnm_rmit: 'BNM RMiT Backup & Recovery (Immutable Offsite Retention)',
    iso_27001: 'ISO/IEC 27001:2022 A.8.13',
    nist_csf: 'NIST CSF 2.0 PR.DS-11 / RC.RP',
    scanner: 'cf-r2-worm-posture-auditor',
    resource: 'r2://0trust-prod-immutable-backups/ledger/2026-11-22'
  },
  PII_UNMASKED: {
    check_id: 'CHK-DLP-03',
    bnm_rmit: 'BNM RMiT Data Security (Cryptographic & PII Masking)',
    iso_27001: 'ISO/IEC 27001:2022 A.8.24',
    nist_csf: 'NIST CSF 2.0 PR.DS-01',
    scanner: 'ci-dlp-pii-classifier',
    resource: 's3://0trust-fin-exports/customer-kyc/telemetry.parquet'
  }
};

export async function createDefaultSessionRecord(sessionId: string): Promise<GrcSessionKvRecord> {
  const now = new Date().toISOString();
  const iamHash = await computeEvidenceSha256({
    sessionId,
    drift_id: 'IAM_MFA_BYPASS',
    status: 'PASS',
    now
  });
  const bkpHash = await computeEvidenceSha256({
    sessionId,
    drift_id: 'BACKUP_WORM_DISABLED',
    status: 'PASS',
    now
  });
  const piiHash = await computeEvidenceSha256({
    sessionId,
    drift_id: 'PII_UNMASKED',
    status: 'PASS',
    now
  });

  return {
    session_id: sessionId,
    updated_at: now,
    controls: {
      IAM_MFA_BYPASS: {
        drift_id: 'IAM_MFA_BYPASS',
        posture_status: 'PASS',
        auditor_status: 'VERIFIED_PASS',
        evidence_sha256: iamHash,
        updated_at: now,
        remediation_requested: false,
        auditor_note: 'Baseline FIDO2 MFA & least-privilege IAM verified.'
      },
      BACKUP_WORM_DISABLED: {
        drift_id: 'BACKUP_WORM_DISABLED',
        posture_status: 'PASS',
        auditor_status: 'VERIFIED_PASS',
        evidence_sha256: bkpHash,
        updated_at: now,
        remediation_requested: false,
        auditor_note: 'Baseline R2 Object Lock COMPLIANCE WORM active.'
      },
      PII_UNMASKED: {
        drift_id: 'PII_UNMASKED',
        posture_status: 'PASS',
        auditor_status: 'VERIFIED_PASS',
        evidence_sha256: piiHash,
        updated_at: now,
        remediation_requested: false,
        auditor_note: 'Baseline AES-256-GCM + DLP PII masking verified.'
      }
    }
  };
}

export async function loadSessionRecord(
  env: GrcEnv,
  sessionId: string
): Promise<GrcSessionKvRecord> {
  const kvKey = `lab8:grc:${sessionId}`;
  if (env.STATE_KV) {
    try {
      const raw = await env.STATE_KV.get(kvKey);
      if (raw) {
        return JSON.parse(raw) as GrcSessionKvRecord;
      }
    } catch {
      // Fall through to default record
    }
  } else {
    const existing = ephemeralGrcStore.get(kvKey);
    if (existing) return existing;
  }
  return createDefaultSessionRecord(sessionId);
}

export async function saveSessionRecord(
  env: GrcEnv,
  sessionId: string,
  record: GrcSessionKvRecord
): Promise<'cloudflare-kv' | 'ephemeral-edge'> {
  const kvKey = `lab8:grc:${sessionId}`;
  if (env.STATE_KV) {
    await env.STATE_KV.put(kvKey, JSON.stringify(record), {
      expirationTtl: KV_TTL_SECONDS
    });
    return 'cloudflare-kv';
  }
  ephemeralGrcStore.set(kvKey, record);
  return 'ephemeral-edge';
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

  let body: PostureRequest = {};
  if (rawText.trim().length > 0) {
    try {
      body = JSON.parse(rawText) as PostureRequest;
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
        message: 'action must be one of INJECT_DRIFT, REMEDIATE, RESET.'
      },
      400
    );
  }

  const timestamp = new Date().toISOString();

  if (body.action === 'RESET') {
    const fresh = await createDefaultSessionRecord(sessionId);
    const storage = await saveSessionRecord(context.env, sessionId, fresh);
    return jsonResponse({
      status: 'RESET_COMPLETE',
      session_id: sessionId,
      controls: fresh.controls,
      storage,
      kv_ttl_seconds: KV_TTL_SECONDS,
      timestamp
    });
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
  const mapping = FRAMEWORK_MAP[driftId];

  const nextPostureStatus: 'PASS' | 'DRIFT' =
    body.action === 'INJECT_DRIFT' ? 'DRIFT' : 'PASS';

  const evidenceSha256 = await computeEvidenceSha256({
    session_id: sessionId,
    check_id: mapping.check_id,
    drift_id: driftId,
    posture_status: nextPostureStatus,
    resource: mapping.resource,
    timestamp
  });

  record.controls[driftId] = {
    drift_id: driftId,
    posture_status: nextPostureStatus,
    auditor_status:
      nextPostureStatus === 'DRIFT'
        ? 'FLAGGED_DRIFT'
        : record.controls[driftId].remediation_requested
          ? 'REMEDIATION_REQUESTED'
          : 'VERIFIED_PASS',
    evidence_sha256: evidenceSha256,
    updated_at: timestamp,
    remediation_requested:
      nextPostureStatus === 'DRIFT' ? record.controls[driftId].remediation_requested : false,
    auditor_note:
      nextPostureStatus === 'DRIFT'
        ? `Live drift detected by ${mapping.scanner}: ${mapping.bnm_rmit} impacted.`
        : `Posture remediated by Cloud Engineer; ready for Auditor evidence re-verification.`
  };
  record.updated_at = timestamp;

  const storage = await saveSessionRecord(context.env, sessionId, record);

  return jsonResponse({
    status: nextPostureStatus === 'DRIFT' ? 'DRIFT_INJECTED' : 'POSTURE_REMEDIATED',
    session_id: sessionId,
    drift_id: driftId,
    check_id: mapping.check_id,
    posture_status: nextPostureStatus,
    framework_mappings: {
      bnm_rmit: mapping.bnm_rmit,
      iso_27001: mapping.iso_27001,
      nist_csf: mapping.nist_csf
    },
    evidence_sha256: evidenceSha256,
    controls: record.controls,
    storage,
    kv_ttl_seconds: KV_TTL_SECONDS,
    timestamp
  });
}
