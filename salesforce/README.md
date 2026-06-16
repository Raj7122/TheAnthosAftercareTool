# Salesforce metadata (`salesforce/`)

Version-controlled Salesforce metadata the tool **owns and deploys** (as opposed
to the org's pre-existing config, which lives only in the org). This is a minimal
SFDX project so the metadata here can be deployed/retrieved directly.

This is intentionally separate from the `packages/` / `apps/` TypeScript layout —
it is org metadata, not application code. Keep it small: only metadata the tool
itself authors belongs here.

## Contents

### `Anthos_Tool_Send_Email` (Flow)

The tool-owned **autolaunched** Flow invoked by the BFF for outbound email
(E-12 / F-10, TRD v1.9 §). Autolaunched so it is REST-invocable via the Actions
API (`POST /services/data/v67.0/actions/custom/flow/Anthos_Tool_Send_Email`) —
screen flows are not indexed there (GAP-8, resolved).

- **Inputs** (match `EmailFlowClient` exactly): `participant_id` (Program
  Enrollment Id), `subject`, `body`, `template_id`.
- **Output:** `activityId` — the created Activity (Task) Id, which
  `EmailFlowClient` extracts and the E-12 endpoint returns.
- **Behavior (Demo: LOG-ONLY):** creates a completed Task Activity related to the
  Program Enrollment (`WhatId`) with the supplied subject/body, and returns its
  Id. It does **not** transmit mail — mirroring the SMS Dummy-Gateway posture
  (the SMS path logs a `Mogli_SMS__SMS__c` that queues but isn't delivered).
- **Production:** flip delivery on by adding a core `emailSimple` Send Email
  action (recipient resolved from the PE → Contact; `logEmailOnSend=true`,
  `senderAddress=aftercare@anthoshome.org`). Confirm org Email Deliverability is
  "All email" before doing so.

The BFF endpoint (`packages/api/src/comms/email/`) only calls this Flow when
`EMAIL_FLOW_API_NAME` is set (else it returns `503 EMAIL_NOT_CONFIGURED`).

## Deploy / retrieve

```bash
# from this directory, with the sandbox as the default org (sf org login web)
sf project deploy start  --metadata Flow:Anthos_Tool_Send_Email
sf project retrieve start --metadata Flow:Anthos_Tool_Send_Email
```

Deployed to `anthoshome3--pursuit` on 2026-06-03 (active, REST-invocable, smoke-
tested). Set `EMAIL_FLOW_API_NAME=Anthos_Tool_Send_Email` on each environment
(local `.env`, Vercel Preview + Production) to enable E-12.
