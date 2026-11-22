export type GrcSeatId = 'cloud-engineer' | 'auditor';

export type ComplianceStage = 1 | 2 | 3 | 4;

export type DriftControlId = 'IAM_MFA_BYPASS' | 'BACKUP_WORM_DISABLED' | 'PII_UNMASKED';

export type PostureStatus = 'PASS' | 'DRIFT';

export type AuditorStatus = 'VERIFIED_PASS' | 'FLAGGED_DRIFT' | 'REMEDIATION_REQUESTED';

export interface FrameworkClauseMapping {
  framework: 'BNM RMiT' | 'ISO/IEC 27001:2022' | 'NIST CSF 2.0';
  clauseId: string;
  clauseTitle: string;
  requirementSummary: string;
}

export interface PostureCheckDefinition {
  id: DriftControlId;
  checkId: string;
  title: string;
  scanner: string;
  resourceArn: string;
  driftLabel: string;
  driftSummary: string;
  remediationLabel: string;
  remediationSummary: string;
  baselineConfig: Record<string, unknown>;
  driftedConfig: Record<string, unknown>;
  mappings: FrameworkClauseMapping[];
}

export interface ControlLiveState {
  driftId: DriftControlId;
  postureStatus: PostureStatus;
  auditorStatus: AuditorStatus;
  remediationRequested: boolean;
  evidenceSha256: string;
  updatedAt: string;
  auditorNote: string;
  storageOrigin: 'cloudflare-kv' | 'ephemeral-edge' | 'client-sandbox-fallback';
}

export interface GrcTrapsExplored {
  iamDrift8A: boolean;
  backupWormDrift8B: boolean;
  piiUnmaskedDrift8C: boolean;
  auditorOverrideBlocked409: boolean;
  remediatedAndVerified: boolean;
}

export interface GrcComplianceState {
  stage: ComplianceStage;
  controls: Record<DriftControlId, ControlLiveState>;
  selectedControlId: DriftControlId;
  lastErrorBanner: string | null;
  lastActionSummary: string | null;
  traps: GrcTrapsExplored;
}

export const POSTURE_CHECK_CATALOG: PostureCheckDefinition[] = [
  {
    id: 'IAM_MFA_BYPASS',
    checkId: 'CHK-IAM-01',
    title: 'IAM Least Privilege & Phishing-Resistant MFA',
    scanner: 'steampipe-aws-iam-prowler',
    resourceArn: 'arn:aws:iam::104928374612:policy/CloudAdminPolicy',
    driftLabel: 'Inject Drift 8A: IAM Wildcard (*:*) + MFA Bypass',
    driftSummary:
      'Attaches Action: "*" / Resource: "*" and disables aws:MultiFactorAuthPresent condition on privileged role.',
    remediationLabel: 'Remediate 8A: Enforce Least-Privilege IAM + FIDO2 MFA',
    remediationSummary:
      'Restores scoped IAM actions and enforces hardware FIDO2 MFA condition on AssumeRole.',
    baselineConfig: {
      effect: 'Allow',
      actions: ['ec2:Describe*', 'rds:Describe*'],
      condition: { Bool: { 'aws:MultiFactorAuthPresent': true }, NumericLessThan: { 'aws:MultiFactorAuthAge': 900 } }
    },
    driftedConfig: {
      effect: 'Allow',
      actions: ['*'],
      resource: '*',
      condition: { Bool: { 'aws:MultiFactorAuthPresent': false } },
      finding_severity: 'CRITICAL'
    },
    mappings: [
      {
        framework: 'BNM RMiT',
        clauseId: '10.5x',
        clauseTitle: 'Privileged Access & Strong Authentication',
        requirementSummary:
          'Financial institutions must enforce MFA and least-privilege separation for privileged cloud/production access.'
      },
      {
        framework: 'ISO/IEC 27001:2022',
        clauseId: 'A.5.15 / A.8.5',
        clauseTitle: 'Access Control & Secure Authentication',
        requirementSummary:
          'Restrict access rights to authorized identities and enforce strong authentication technologies.'
      },
      {
        framework: 'NIST CSF 2.0',
        clauseId: 'PR.AA-01',
        clauseTitle: 'Identity Management, Authentication & Access Control',
        requirementSummary:
          'Identities and credentials for authorized users, services, and hardware are managed and verified.'
      }
    ]
  },
  {
    id: 'BACKUP_WORM_DISABLED',
    checkId: 'CHK-BKP-02',
    title: 'Immutable Backup & R2 Object Lock (WORM)',
    scanner: 'cf-r2-worm-posture-auditor',
    resourceArn: 'r2://0trust-prod-immutable-backups/ledger/2026-11-22',
    driftLabel: 'Inject Drift 8B: Disable Backup Immutability (WORM Off)',
    driftSummary:
      'Downgrades R2 Object Lock from COMPLIANCE to NONE, exposing ledger backups to ransomware deletion.',
    remediationLabel: 'Remediate 8B: Restore R2 Object Lock (COMPLIANCE Mode)',
    remediationSummary:
      'Re-enables 30-day R2 Object Lock COMPLIANCE WORM retention policy across ledger snapshots.',
    baselineConfig: {
      bucket: '0trust-prod-immutable-backups',
      object_lock_mode: 'COMPLIANCE',
      retain_days: 30,
      bypass_governance_allowed: false
    },
    driftedConfig: {
      bucket: '0trust-prod-immutable-backups',
      object_lock_mode: 'NONE',
      retain_days: 0,
      bypass_governance_allowed: true,
      finding_severity: 'CRITICAL'
    },
    mappings: [
      {
        framework: 'BNM RMiT',
        clauseId: 'Backup / Recovery',
        clauseTitle: 'Immutable Offsite Backup & Cyber Recovery',
        requirementSummary:
          'Maintain tamper-resistant, immutable backups isolated from primary administrative control planes.'
      },
      {
        framework: 'ISO/IEC 27001:2022',
        clauseId: 'A.8.13',
        clauseTitle: 'Information Backup',
        requirementSummary:
          'Backup copies of information, software, and systems shall be maintained and protected against deletion.'
      },
      {
        framework: 'NIST CSF 2.0',
        clauseId: 'PR.DS-11 / RC.RP',
        clauseTitle: 'Data Backups & Recovery Execution',
        requirementSummary:
          'Backups of data are created, protected, maintained, and tested to ensure resilient restoration.'
      }
    ]
  },
  {
    id: 'PII_UNMASKED',
    checkId: 'CHK-DLP-03',
    title: 'PII Encryption & DLP Field Masking',
    scanner: 'ci-dlp-pii-classifier',
    resourceArn: 's3://0trust-fin-exports/customer-kyc/telemetry.parquet',
    driftLabel: 'Inject Drift 8C: Unencrypted / Unmasked PII in Exports',
    driftSummary:
      'Disables KMS envelope encryption and exposes raw National ID / PAN fields in telemetry export.',
    remediationLabel: 'Remediate 8C: Enable AES-256-GCM + DLP PII Masking',
    remediationSummary:
      'Enforces KMS AES-256-GCM bucket encryption and deterministic DLP field redaction.',
    baselineConfig: {
      sse_algorithm: 'aws:kms',
      cipher: 'AES-256-GCM',
      dlp_masking_rules: ['DLP-001-PAN', 'DLP-002-MYKAD', 'DLP-003-JWT']
    },
    driftedConfig: {
      sse_algorithm: 'NONE',
      cipher: 'PLAINTEXT',
      dlp_masking_rules: [],
      exposed_fields: ['national_id', 'card_pan'],
      finding_severity: 'HIGH'
    },
    mappings: [
      {
        framework: 'BNM RMiT',
        clauseId: 'Data Security',
        clauseTitle: 'Cryptographic Protection & Sensitive Data Masking',
        requirementSummary:
          'Encrypt confidential customer PII at rest/in transit and mask sensitive fields in logs and exports.'
      },
      {
        framework: 'ISO/IEC 27001:2022',
        clauseId: 'A.8.24',
        clauseTitle: 'Use of Cryptography',
        requirementSummary:
          'Rules for the effective use of cryptography, including key management and data protection, shall be enforced.'
      },
      {
        framework: 'NIST CSF 2.0',
        clauseId: 'PR.DS-01',
        clauseTitle: 'Data-at-Rest Protection',
        requirementSummary:
          'The confidentiality, integrity, and availability of data-at-rest are protected.'
      }
    ]
  }
];
