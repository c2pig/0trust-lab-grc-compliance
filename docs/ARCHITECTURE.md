# Lab 8 Architecture: Continuous Compliance & BNM RMiT / ISO 27001 Mapper (`/grc-compliance`)

> **Zoom Level:** 2.5 (Lab Assembly + Infrastructure Mapping)  
> **Parent Overview:** [`0trust.dev/docs/ARCHITECTURE.md`](https://github.com/c2pig/0trust.dev/blob/main/docs/ARCHITECTURE.md)  
> **Experience Archetype:** Archetype D — 2-Seat Audit & Drift Investigation (`Cloud Engineer · Posture & Drift` ↔ `GRC Auditor · Evidence Reviewer`)  
> **Architecture SVG:** [`docs/diagrams/grc_compliance_architecture.svg`](diagrams/grc_compliance_architecture.svg)

---

## 1. End-to-End 2-Seat Continuous Compliance + `managed-infrastructure` Zoom-In

```mermaid
flowchart TB
    subgraph Seats ["Archetype D: 2-Seat Audit & Drift Investigation (RoleSwitcherBar.tsx)"]
        CE["Seat 1: Rohan Verma (Cloud Engineer · Posture & Drift)"]
        AUD["Seat 2: Claire Dubois (GRC Auditor · Evidence Reviewer)"]
    end

    subgraph S1 ["Phase 1–2 (Discovery & Understanding): Posture Scanners & Drift Injection"]
        Scanners["Cloud & CI Posture Checks (CHK-IAM-01 · CHK-BKP-02 · CHK-DLP-03)"]
        PostureAPI["Edge API: POST /api/grc-compliance/posture (STATE_KV lab8:grc:* 1h TTL)"]
        Mapper["Cross-Framework Mapper (BNM RMiT · ISO/IEC 27001:2022 · NIST CSF 2.0)"]
        Scanners --> PostureAPI --> Mapper
    end

    subgraph S2 ["Phase 3 (Practice): Fail-Closed 409 Evidence Gate & Remediation Loop"]
        VerifyAPI["Edge API: POST /api/grc-compliance/verify"]
        Gate409["Fail-Closed Guardrail: 409 EVIDENCE_DRIFT_MISMATCH if Posture == DRIFT"]
        Remediate["Cloud Engineer Remediation -> Fresh SHA-256 Digest -> Auditor VERIFIED_PASS"]
        VerifyAPI --> Gate409 --> Remediate
    end

    subgraph S3 ["Phase 4 (Reflection): Audit-Readiness & X-Ray Telemetry Drawer"]
        Score["Audit-Readiness Score (0–100%) + Attestation JSON Export"]
        XRay["Sticky Bottom XRayTelemetryDrawer (Security Audit Feed + Live Decoded Proof)"]
        Score --> XRay
    end

    subgraph Infra ["Provisioned by managed-infrastructure & infra/terraform"]
        TF_Edge["Cloudflare Pages Functions, STATE_KV (lab8:grc:<sid>, 1h TTL), 0trust-lab-router"]
    end

    CE -->|"Inject Drift / Remediate"| PostureAPI
    AUD -->|"Flag / Mark PASS"| VerifyAPI
    Mapper --> VerifyAPI
    Remediate --> Score
    TF_Edge -.->|"Hosts & Isolates"| PostureAPI
    TF_Edge -.->|"Hosts & Isolates"| VerifyAPI
```

---

## 2. Distributed Repo & Infrastructure Ownership

| Lab Phase & Seat | Plain-English Purpose | Owning Application Repo | Provisioning Infrastructure |
| :--- | :--- | :--- | :--- |
| **Phase 1 (Discovery)**: Posture-to-Regulation Map | Map 3 live posture checks (`CHK-IAM-01`, `CHK-BKP-02`, `CHK-DLP-03`) to BNM RMiT, ISO/IEC 27001:2022, and NIST CSF 2.0 | [`0trust-lab-grc-compliance`](https://github.com/c2pig/0trust-lab-grc-compliance) (`src/contracts/grcComplianceContract.ts`) | `managed-infrastructure/modules/cloudflare-pages-lab` (`enable_custom_domain = false`, behind `0trust-lab-router` at `https://lab.0trust.dev/grc-compliance`) |
| **Phase 2 (Understanding · Seat 1 Cloud Engineer)**: Drift Injection | Inject Drift 8A (`IAM_MFA_BYPASS`), 8B (`BACKUP_WORM_DISABLED`), or 8C (`PII_UNMASKED`) via `POST /api/grc-compliance/posture` | [`0trust-lab-grc-compliance`](https://github.com/c2pig/0trust-lab-grc-compliance) (`functions/api/grc-compliance/posture.ts`) | Cloudflare Pages Functions + `STATE_KV` (`lab8:grc:<sid>`, `1h TTL`) |
| **Phase 3 (Practice · Seat 2 Auditor ↔ Seat 1 Cloud Engineer)**: 409 Trap & Remediation | Enforce fail-closed `409 EVIDENCE_DRIFT_MISMATCH` if Auditor tries `MARK_PASS` while posture is `DRIFT`; remediate & re-verify SHA-256 link | [`0trust-lab-grc-compliance`](https://github.com/c2pig/0trust-lab-grc-compliance) (`functions/api/grc-compliance/verify.ts`, `src/pages/GrcCompliancePage.tsx`) | Cloudflare WebCrypto SHA-256 + `STATE_KV` (`1h TTL`) |
| **Phase 4 (Reflection)**: Attestation Pack & X-Ray Drawer | Compute audit-readiness score, export JSON attestation pack, and inspect raw posture/mapping/SHA-256 proof | [`0trust-lab-grc-compliance`](https://github.com/c2pig/0trust-lab-grc-compliance) (`src/engine/grcComplianceEngine.ts`, `src/components/XRayTelemetryDrawer.tsx`) | `$0.00` Guided Sandbox + `_middleware.ts` W3C `traceparent` |

---

## 3. Security & Evidence Integrity Invariants Enforced

1. **Fail-Closed Auditor Verification (`POST /api/grc-compliance/verify`)**:
   - Attempting `MARK_PASS` while the underlying posture check in `STATE_KV` (`lab8:grc:<sid>`) is `DRIFT` fails closed with **`HTTP 409 EVIDENCE_DRIFT_MISMATCH`**.
2. **Cryptographic SHA-256 Evidence Digests**:
   - Every posture transition and auditor sign-off computes a fresh SHA-256 digest over `(session_id, drift_id, posture_status, timestamp)` via WebCrypto (`crypto.subtle.digest`).
3. **Strict Input Validation & Session Isolation**:
   - `MAX_BODY_BYTES = 65536`, `Set`-based enum validation (`INJECT_DRIFT | REMEDIATE | RESET`, `MARK_PASS | FLAG_REMEDIATION`), `sanitizeSessionId()`, `Cache-Control: no-store`, and `expirationTtl: 3600`.
