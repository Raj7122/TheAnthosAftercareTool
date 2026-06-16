## Summary

<!-- 1–3 sentences: what this PR does and why. -->

## Definition of Done

- [ ] Tests added / updated (unit + integration where applicable)
- [ ] Audit log written on every state mutation
- [ ] Idempotency key honored on every mutating endpoint
- [ ] Quiet hours respected if a notification path is touched
- [ ] Calibration gate met if scoring/priority logic changed
- [ ] OAuth + PKCE preserved if the auth path is touched
- [ ] Salesforce remains the system of record — no local SoR writes
- [ ] Documentation updated if behavior changed
- [ ] No secrets, no PII in logs
