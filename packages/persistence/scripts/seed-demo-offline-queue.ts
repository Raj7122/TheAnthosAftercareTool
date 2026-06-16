// P3C-13 — seed ONE Review-Required row into the server-side `offline_queue`
// so the tablet "Today" home's Review Required panel is non-empty for the
// June demo (demo flow step 6: resolve a conflict via Discard / Escalate).
//
// Data only — no schema, no migration. The row models the Pattern E race:
// the specialist logged a call offline; by the time it tried to sync,
// Salesforce had reassigned the participant, so the write was rejected and
// routed to Review Required.
//
// Usage:
//   pnpm --filter @anthos/persistence db:seed:offline-queue -- <specialistId> [participantId]
// or set SEED_SPECIALIST_ID (+ optional SEED_PARTICIPANT_ID) in the env.
//
// The specialistId MUST be the Salesforce id the live session resolves to,
// else `GET /queue/pending` (scoped to the signed-in specialist) won't return
// the row. There is no hard-coded default — seeding the wrong specialist would
// silently show an empty panel.
//
// Env load mirrors scripts/migrate.ts: dotenv must populate the environment
// before `src/db/client.ts` evaluates (it reads DEMO_POSTGRES_URL at module
// load), so the client + schema are pulled in via dynamic `import()` after
// `loadEnv()`.
import { randomUUID } from "node:crypto";

import { config as loadEnv } from "dotenv";

loadEnv({ path: "../../.env" });
loadEnv();

function resolveArgs(): { specialistId: string; participantId: string | null } {
  const specialistId = process.argv[2] ?? process.env.SEED_SPECIALIST_ID ?? "";
  if (specialistId.length === 0) {
    throw new Error(
      "specialistId is required (argv[2] or SEED_SPECIALIST_ID) — must match the live session's Salesforce id.",
    );
  }
  const participantId =
    process.argv[3] ?? process.env.SEED_PARTICIPANT_ID ?? null;
  return { specialistId, participantId };
}

async function main(): Promise<void> {
  const { specialistId, participantId } = resolveArgs();
  const { closeDb, db } = await import("../src/db/client.js");
  const { offlineQueue } = await import("../src/schema/offline_queue.js");
  try {
    const id = randomUUID();
    await db.insert(offlineQueue).values({
      id,
      specialistId,
      participantId,
      actionType: "call.logged",
      // `payload` jsonb — `derivePayloadPreview` allow-lists `status` + a
      // `snippet` sourced from `summary`/`note`/`body`. Keeping it minimal so
      // the preview renders without echoing PHI-suspect content.
      payload: {
        status: "Completed",
        summary: "Offline visit note pending sync.",
      },
      idempotencyKey: null,
      traceId: null,
      lastAttemptAt: new Date(),
      retryCount: 1,
      status: "review_required_reassigned",
      // `INVALID_CROSS_REFERENCE_KEY` maps to ESCALATE_TO_SUPERVISOR via
      // `deriveSuggestedResolution`, so the panel highlights Escalate (the
      // gated Reassign action is disabled this ticket).
      errorDetails: {
        sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
        message:
          "Participant was reassigned to another specialist while you were offline; Salesforce rejected the write.",
      },
    });
    console.log(
      `✓ Seeded review_required offline_queue row ${id} for specialist ${specialistId}.`,
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("✗ Seed failed:", err);
  process.exitCode = 1;
});
