# Agent & Contributor Instructions (`0trust-lab-grc-compliance`)

## Two-Way Architecture Diagram Sync (Global <-> Local)

This repository powers **Lab 8 (`Continuous Compliance & BNM RMiT / ISO 27001 Mapper` — `/grc-compliance`)** on [`0trust.dev`](https://github.com/c2pig/0trust.dev/blob/main/docs/ECOSYSTEM_MAP.md), hosted at `https://lab.0trust.dev/grc-compliance`.

Whenever you modify code, edge functions, or infrastructure under `src/`, `functions/`, `infra/`, or `.github/workflows/`:
1. **Local Sync**: Update [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/diagrams/grc_compliance_architecture.svg`](docs/diagrams/grc_compliance_architecture.svg) in the same Pull Request (enforced by [`.github/workflows/diagram-check.yml`](.github/workflows/diagram-check.yml)).
2. **Global Sync**: If public contracts (`lab.manifest.json`, `seats`, `apiEndpoints`, `kvPrefixes`), posture drift mappings, or fail-closed `409 EVIDENCE_DRIFT_MISMATCH` interfaces change, also update `docs/diagrams/platform_capability_zoomin.svg` and `src/contracts/labManifest.ts` in [`c2pig/0trust.dev`](https://github.com/c2pig/0trust.dev).
