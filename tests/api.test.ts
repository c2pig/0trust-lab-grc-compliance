import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as posturePost } from '../functions/api/grc-compliance/posture';
import { onRequestPost as verifyPost } from '../functions/api/grc-compliance/verify';
import { MemoryKvAdapter } from '../server/kvAdapter';

function makeEnv() {
  return {
    STATE_KV: new MemoryKvAdapter({ labSlug: 'grc-compliance' }),
    ENVIRONMENT: 'test'
  };
}

describe('Lab 8 (grc-compliance) Layer 2 — API Route Handlers', () => {
  it('POST /posture RESET initializes 3 PASS controls for a fresh session', async () => {
    const env = makeEnv();
    const res = await posturePost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/posture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'layer2-init-session' },
        body: JSON.stringify({ action: 'RESET', drift_id: 'IAM_MFA_BYPASS' })
      }),
      env
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      session_id: string;
      status: string;
      controls: Record<string, { drift_id: string; posture_status: string; auditor_status: string }>;
    };
    assert.equal(data.session_id, 'layer2-init-session');
    assert.equal(data.status, 'RESET_COMPLETE');
    const controls = Object.values(data.controls);
    assert.equal(controls.length, 3);
    assert.ok(controls.every((c) => c.posture_status === 'PASS' && c.auditor_status === 'VERIFIED_PASS'));
  });

  it('enforces fail-closed 409 EVIDENCE_DRIFT_MISMATCH on partial remediation until all drifted controls are remediated', async () => {
    const env = makeEnv();
    const sessionId = 'layer2-partial-remediation';

    // Inject drift on two controls
    for (const driftId of ['IAM_MFA_BYPASS', 'BACKUP_WORM_DISABLED'] as const) {
      const injectRes = await posturePost({
        request: new Request('https://lab.0trust.dev/api/grc-compliance/posture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
          body: JSON.stringify({ action: 'INJECT_DRIFT', drift_id: driftId })
        }),
        env
      });
      assert.equal(injectRes.status, 200);
    }

    // Remediate only IAM_MFA_BYPASS
    const partialRemediate = await posturePost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/posture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ action: 'REMEDIATE', drift_id: 'IAM_MFA_BYPASS' })
      }),
      env
    });
    assert.equal(partialRemediate.status, 200);

    // Remediated control can be verified PASS
    const passFirst = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'IAM_MFA_BYPASS' })
      }),
      env
    });
    assert.equal(passFirst.status, 200);

    // Remaining drifted control still blocks attestation with 409 EVIDENCE_DRIFT_MISMATCH
    const blockedSecond = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'BACKUP_WORM_DISABLED' })
      }),
      env
    });
    assert.equal(blockedSecond.status, 409);
    const blockedBody = (await blockedSecond.json()) as { error: string; drift_id: string };
    assert.equal(blockedBody.error, 'EVIDENCE_DRIFT_MISMATCH');
    assert.equal(blockedBody.drift_id, 'BACKUP_WORM_DISABLED');

    // Full remediation of remaining control unblocks attestation
    const fullRemediate = await posturePost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/posture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ action: 'REMEDIATE', drift_id: 'BACKUP_WORM_DISABLED' })
      }),
      env
    });
    assert.equal(fullRemediate.status, 200);

    const passSecond = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'BACKUP_WORM_DISABLED' })
      }),
      env
    });
    assert.equal(passSecond.status, 200);
    const passBody = (await passSecond.json()) as { status: string };
    assert.equal(passBody.status, 'VERIFIED_PASS');
  });

  it('isolates posture state across distinct sessions', async () => {
    const env = makeEnv();

    await posturePost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/posture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'session-alpha' },
        body: JSON.stringify({ action: 'INJECT_DRIFT', drift_id: 'PII_UNMASKED' })
      }),
      env
    });

    // Session alpha has PII_UNMASKED drifted -> MARK_PASS returns 409
    const alphaVerify = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'session-alpha' },
        body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'PII_UNMASKED' })
      }),
      env
    });
    assert.equal(alphaVerify.status, 409);

    // Session beta is isolated and unaffected -> MARK_PASS returns 200
    const betaVerify = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'session-beta' },
        body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'PII_UNMASKED' })
      }),
      env
    });
    assert.equal(betaVerify.status, 200);
  });

  it('rejects oversized, malformed, and invalid payloads fail-closed', async () => {
    const env = makeEnv();

    const oversized = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'neg-session' },
        body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'IAM_MFA_BYPASS', pad: 'a'.repeat(65 * 1024) })
      }),
      env
    });
    assert.equal(oversized.status, 413);

    const invalidJson = await verifyPost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'neg-session' },
        body: '{invalid'
      }),
      env
    });
    assert.equal(invalidJson.status, 400);

    const invalidDriftId = await posturePost({
      request: new Request('https://lab.0trust.dev/api/grc-compliance/posture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'neg-session' },
        body: JSON.stringify({ action: 'INJECT_DRIFT', drift_id: 'UNKNOWN_CONTROL' })
      }),
      env
    });
    assert.equal(invalidDriftId.status, 400);
  });
});
