# Podcast release gate

The release gate checks the complete local baseline before a release:

```powershell
npm test
npm run lint
npm run build
npm run test:e2e:podcast
```

Or run the complete sequence:

```powershell
npm run release:gate
```

The E2E test in `tests/e2e/podcast.spec.ts` verifies that the running app loads,
the podcast UI is present, and `/api/jerry-debug` is reachable through a real
browser. It requires:

- a running server at `RELEASE_GATE_BASE_URL` or `http://localhost:3000`;
- `GEMINI_API_KEY` or a valid local `.api-key.json`;
- `@playwright/test` and its browser binaries.

Missing prerequisites fail the gate with a diagnostic. An explicit skip is
available for environments that intentionally cannot run browsers:

```powershell
$env:RELEASE_GATE_ALLOW_SKIP = '1'
npm run test:e2e:podcast
```

The skip is never treated as a release pass; CI/release automation should leave
the variable unset. Set `RELEASE_GATE_BASE_URL` when testing a deployed or
non-default local server.

## Rollback criteria

Rollback the release if any required command fails, the E2E test reports a
missing server/browser/credential, the podcast UI is absent, or the debug
endpoint is unavailable. A skipped E2E test is a release blocker, not approval.

Use the deployment system's previous known-good commit or artifact. Do not alter
recording runtime code as part of rollback triage; first preserve the failing
gate output and return to the last commit where all four commands passed.
