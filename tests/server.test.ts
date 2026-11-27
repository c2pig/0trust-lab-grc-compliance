import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCloudRunApp, verifyRouterSecret } from '../server/app';
import {
  buildKvDocId,
  FirestoreKvAdapter,
  MemoryKvAdapter,
  type FirestoreCollectionLike,
  type FirestoreKvDoc
} from '../server/kvAdapter';
import { resolvePublicOrigin } from '../server/origin';

const TEST_ROUTER_SECRET = 'test-router-secret-value-0123456789';

function createMockFirestoreCollection(): {
  collection: FirestoreCollectionLike;
  store: Map<string, FirestoreKvDoc>;
} {
  const store = new Map<string, FirestoreKvDoc>();
  const collection: FirestoreCollectionLike = {
    doc(id: string) {
      return {
        async get() {
          const data = store.get(id);
          return {
            exists: Boolean(data),
            data: () => data
          };
        },
        async set(data: FirestoreKvDoc) {
          store.set(id, data);
        },
        async delete() {
          store.delete(id);
        }
      };
    }
  };
  return { collection, store };
}

describe('Lab 8 (grc-compliance) Cloud Run Adapter — Security & API Invariants', () => {
  it('blocks direct *.run.app /api/* requests without or with invalid X-Lab-Router-Secret (fail-closed 403)', async () => {
    const app = createCloudRunApp({
      env: {
        ENVIRONMENT: 'production',
        LAB_SLUG: 'grc-compliance',
        LAB_ROUTER_SECRET: TEST_ROUTER_SECRET
      },
      kv: new MemoryKvAdapter({ labSlug: 'grc-compliance' })
    });

    // Missing header
    const resMissing = await app.request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'RESET' })
      }
    );
    assert.equal(resMissing.status, 403);
    assert.deepEqual(await resMissing.json(), { error: 'FORBIDDEN_DIRECT_ORIGIN' });

    // Wrong secret (same length & different length)
    const resWrongSameLen = await app.request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lab-router-secret': 'wrong-router-secret-value-987654321'
        },
        body: JSON.stringify({ action: 'RESET' })
      }
    );
    assert.equal(resWrongSameLen.status, 403);
    assert.deepEqual(await resWrongSameLen.json(), { error: 'FORBIDDEN_DIRECT_ORIGIN' });

    const resWrongDiffLen = await app.request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lab-router-secret': 'short'
        },
        body: JSON.stringify({ action: 'RESET' })
      }
    );
    assert.equal(resWrongDiffLen.status, 403);

    // Fail-closed when LAB_ROUTER_SECRET is unset in production
    const appUnconfigured = createCloudRunApp({
      env: {
        ENVIRONMENT: 'production',
        LAB_SLUG: 'grc-compliance'
      },
      kv: new MemoryKvAdapter({ labSlug: 'grc-compliance' })
    });
    const resUnconfigured = await appUnconfigured.request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lab-router-secret': TEST_ROUTER_SECRET
        },
        body: JSON.stringify({ action: 'RESET' })
      }
    );
    assert.equal(resUnconfigured.status, 403);
    assert.deepEqual(await resUnconfigured.json(), { error: 'FORBIDDEN_DIRECT_ORIGIN' });

    // Valid secret succeeds
    const resValid = await app.request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lab-router-secret': TEST_ROUTER_SECRET
        },
        body: JSON.stringify({ action: 'RESET' })
      }
    );
    assert.equal(resValid.status, 200);
    const json = (await resValid.json()) as Record<string, unknown>;
    assert.equal(json.status, 'RESET_COMPLETE');
    assert.equal(verifyRouterSecret(TEST_ROUTER_SECRET, TEST_ROUTER_SECRET), true);
  });

  it('serves GET /healthz without X-Lab-Router-Secret (Cloud Run probe)', async () => {
    const app = createCloudRunApp({
      env: {
        ENVIRONMENT: 'production',
        LAB_SLUG: 'grc-compliance',
        LAB_ROUTER_SECRET: TEST_ROUTER_SECRET
      },
      kv: new MemoryKvAdapter({ labSlug: 'grc-compliance' })
    });

    const res = await app.request('https://0trust-lab-grc-compliance-abc.run.app/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, lab: 'grc-compliance' });
  });

  it('synchronously returns null on expired TTL docs in FirestoreKvAdapter & MemoryKvAdapter', async () => {
    let nowMs = 1_700_000_000_000;
    const { collection, store } = createMockFirestoreCollection();
    const firestoreKv = new FirestoreKvAdapter({
      labSlug: 'grc-compliance',
      collectionRef: collection,
      nowFn: () => nowMs
    });

    await firestoreKv.put('lab8:grc:session/1', '{"v":1}', { expirationTtl: 3600 });
    const expectedDocId = buildKvDocId('grc-compliance', 'lab8:grc:session/1');
    assert.equal(expectedDocId, 'grc-compliance:lab8%3Agrc%3Asession%2F1');

    const storedDoc = store.get(expectedDocId);
    assert.ok(storedDoc);
    assert.equal(storedDoc.labSlug, 'grc-compliance');
    assert.equal(storedDoc.value, '{"v":1}');
    assert.equal(storedDoc.expireAt?.toMillis(), nowMs + 3_600_000);

    // Before expiry
    assert.equal(await firestoreKv.get('lab8:grc:session/1'), '{"v":1}');

    // Advance clock past TTL without deleting the doc from Firestore (simulating delayed background reaper)
    nowMs += 3_600_000;
    assert.equal(store.has(expectedDocId), true);
    assert.equal(await firestoreKv.get('lab8:grc:session/1'), null);

    // MemoryKvAdapter parity
    let memNow = 1_700_000_000_000;
    const memKv = new MemoryKvAdapter({ labSlug: 'grc-compliance', nowFn: () => memNow });
    await memKv.put('lab8:grc:abc', 'ok', { expirationTtl: 10 });
    assert.equal(await memKv.get('lab8:grc:abc'), 'ok');
    memNow += 10_000;
    assert.equal(await memKv.get('lab8:grc:abc'), null);
  });

  it('rejects forged X-Forwarded-Host headers and allows lab.0trust.dev + localhost:5182', () => {
    const forgedReq = new Request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        headers: {
          'x-forwarded-host': 'evil.com',
          'x-forwarded-proto': 'https'
        }
      }
    );
    assert.equal(resolvePublicOrigin(forgedReq), 'https://0trust-lab-grc-compliance-abc.run.app');

    const prodReq = new Request(
      'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
      {
        headers: {
          'x-forwarded-host': 'lab.0trust.dev',
          'x-forwarded-proto': 'https'
        }
      }
    );
    assert.equal(resolvePublicOrigin(prodReq), 'https://lab.0trust.dev');

    const localReq = new Request('http://127.0.0.1:8080/api/grc-compliance/posture', {
      headers: {
        'x-forwarded-host': 'localhost:5182',
        'x-forwarded-proto': 'http'
      }
    });
    assert.equal(resolvePublicOrigin(localReq), 'http://localhost:5182');
  });

  it('redacts JWT signatures in _telemetry and never leaks X-Lab-Router-Secret or OTLP_AUTH_HEADER', async () => {
    const otlpAuthSecret = 'Bearer otlp-super-secret-header-token';
    const capturedOtlpBodies: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedOtlpBodies.push(String(init?.body || ''));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const app = createCloudRunApp({
        env: {
          ENVIRONMENT: 'production',
          LAB_SLUG: 'grc-compliance',
          LAB_ROUTER_SECRET: TEST_ROUTER_SECRET,
          OTLP_ENDPOINT: 'https://otlp.example.com',
          OTLP_AUTH_HEADER: otlpAuthSecret
        },
        kv: new MemoryKvAdapter({ labSlug: 'grc-compliance' })
      });

      const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdWRpdG9yLTEifQ.SuperSecretSignatureXYZ123';
      const res = await app.request(
        'https://0trust-lab-grc-compliance-abc.run.app/api/grc-compliance/posture',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-lab-router-secret': TEST_ROUTER_SECRET,
            authorization: `Bearer ${fakeJwt}`,
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
          },
          body: JSON.stringify({ action: 'RESET' })
        }
      );

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('traceparent')?.startsWith('00-4bf92f3577b34da6a3ce929d0e0e4736-'));
      assert.ok(res.headers.get('X-Edge-Latency-Ms'));

      const bodyText = await res.text();
      assert.ok(!bodyText.includes('SuperSecretSignatureXYZ123'), 'JWT signature must be redacted');
      assert.ok(!bodyText.includes(TEST_ROUTER_SECRET), 'Router secret must never appear in response');
      assert.ok(!bodyText.includes(otlpAuthSecret), 'OTLP auth header must never appear in response');

      const parsed = JSON.parse(bodyText) as {
        _telemetry: { redacted_auth_header: string; redaction_applied: boolean };
      };
      assert.equal(parsed._telemetry.redaction_applied, true);
      assert.equal(
        parsed._telemetry.redacted_auth_header,
        'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdWRpdG9yLTEifQ.***REDACTED***'
      );

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(capturedOtlpBodies.length, 2);
      for (const otlpBody of capturedOtlpBodies) {
        assert.ok(!otlpBody.includes(TEST_ROUTER_SECRET));
        assert.ok(!otlpBody.includes('SuperSecretSignatureXYZ123'));
        assert.ok(!otlpBody.includes(otlpAuthSecret));
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('executes full Lab 8 GRC Drift -> 409 Evidence Gate -> Remediation -> Auditor Verify lifecycle', async () => {
    const kv = new MemoryKvAdapter({ labSlug: 'grc-compliance' });
    const app = createCloudRunApp({
      env: {
        ENVIRONMENT: 'development',
        LAB_SLUG: 'grc-compliance'
      },
      kv
    });

    const sessionId = 'test-grc-session';

    // 1. Inject drift on IAM_MFA_BYPASS
    const driftRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/posture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ action: 'INJECT_DRIFT', drift_id: 'IAM_MFA_BYPASS' })
    });
    assert.equal(driftRes.status, 200);
    const driftData = (await driftRes.json()) as { status: string; posture_status: string; evidence_sha256: string };
    assert.equal(driftData.status, 'DRIFT_INJECTED');
    assert.equal(driftData.posture_status, 'DRIFT');
    assert.equal(driftData.evidence_sha256.length, 64);

    // 2. Auditor attempts MARK_PASS while posture is DRIFT -> fail-closed 409
    const blockedVerifyRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'IAM_MFA_BYPASS' })
    });
    assert.equal(blockedVerifyRes.status, 409);
    const blockedVerifyData = (await blockedVerifyRes.json()) as { error: string };
    assert.equal(blockedVerifyData.error, 'EVIDENCE_DRIFT_MISMATCH');

    // 3. Auditor flags remediation
    const flagRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({
        action: 'FLAG_REMEDIATION',
        drift_id: 'IAM_MFA_BYPASS',
        auditor_note: 'Enforce FIDO2 MFA immediately.'
      })
    });
    assert.equal(flagRes.status, 200);
    const flagData = (await flagRes.json()) as { status: string };
    assert.equal(flagData.status, 'REMEDIATION_REQUESTED');

    // 4. Cloud Engineer remediates posture
    const remediateRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/posture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ action: 'REMEDIATE', drift_id: 'IAM_MFA_BYPASS' })
    });
    assert.equal(remediateRes.status, 200);
    const remediateData = (await remediateRes.json()) as { status: string; posture_status: string };
    assert.equal(remediateData.status, 'POSTURE_REMEDIATED');
    assert.equal(remediateData.posture_status, 'PASS');

    // 5. Auditor verifies PASS -> 200 VERIFIED_PASS
    const verifyRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ action: 'MARK_PASS', drift_id: 'IAM_MFA_BYPASS' })
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = (await verifyRes.json()) as { status: string; evidence_sha256: string };
    assert.equal(verifyData.status, 'VERIFIED_PASS');
    assert.equal(verifyData.evidence_sha256.length, 64);
  });

  it('rejects >64KB JSON bodies with 413 PAYLOAD_TOO_LARGE', async () => {
    const app = createCloudRunApp({ kv: new MemoryKvAdapter({ labSlug: 'grc-compliance' }) });
    const oversizedPayload = JSON.stringify({
      action: 'INJECT_DRIFT',
      drift_id: 'IAM_MFA_BYPASS',
      padding: 'x'.repeat(65 * 1024)
    });

    const res = await app.request('http://127.0.0.1:8080/api/grc-compliance/posture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': 'oversized-test-session'
      },
      body: oversizedPayload
    });

    assert.equal(res.status, 413);
    const data = (await res.json()) as { error: string };
    assert.equal(data.error, 'PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed JSON and invalid action/drift_id with 400 fail-closed', async () => {
    const app = createCloudRunApp({ kv: new MemoryKvAdapter({ labSlug: 'grc-compliance' }) });

    const badJsonRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/posture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': 'bad-json-session'
      },
      body: '{"action": "INJECT_DRIFT", broken'
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonData = (await badJsonRes.json()) as { error: string };
    assert.equal(badJsonData.error, 'INVALID_JSON');

    const missingActionRes = await app.request('http://127.0.0.1:8080/api/grc-compliance/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drift_id: 'IAM_MFA_BYPASS' })
    });
    assert.equal(missingActionRes.status, 400);
    const missingActionData = (await missingActionRes.json()) as { error: string };
    assert.equal(missingActionData.error, 'INVALID_ACTION');
  });
});
