# Test Coverage Replacement Map

## 2026-02-15 Vitest deep optimization

| Removed test | Reason | Replacement |
| --- | --- | --- |
| `src/app/features/flow/components/flow-currentUserId-regression.spec.ts` | Dynamic import + placeholder assertions (`expect(true).toBe(true)`) caused heavy compile overhead and flaky timeout risk without runtime signal value. | `scripts/contracts/check-flow-current-userid.cjs` static contract check (must inject `UserSessionService`, forbid `projectState.currentUserId` access). |
