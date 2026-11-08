## What changed

<!-- One paragraph: the problem and the approach. Link the issue: Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / chore
- [ ] Documentation
- [ ] Tests only

## Evidence (required)

Paste the commands you actually ran and their real results. Do not paste expected output.

```
npm run lint            ->
npm run build           ->
npm run test            ->
npm run test:integration ->
npx playwright test     ->
```

## Checklist

- [ ] Tenant isolation enforced server-side for every new/changed query (`organizationId` + role scope)
- [ ] RBAC decorators updated and covered by an integration test
- [ ] Input validated with DTO/Zod; no secrets or card data logged or stored
- [ ] Prisma migration added when the schema changed (`prisma migrate dev`), indexes considered
- [ ] Loading / empty / error / unavailable states handled in the UI
- [ ] Docs updated (README, ARCHITECTURE, DEPLOYMENT or ROADMAP as relevant)
- [ ] `docs/openapi.json` regenerated when the API surface changed
- [ ] No fabricated data, metrics, screenshots or test results
