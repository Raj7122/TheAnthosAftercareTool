import { describe, expect, it } from "vitest";

import {
  deriveRowTags,
  type RowTagSnapshot,
} from "../../src/tags/index.js";

const NOW = new Date("2026-05-25T12:00:00Z");

// All-empty baseline. Each test overrides only the field it exercises so a
// missing branch can't accidentally light up another tag.
function baseSnapshot(): RowTagSnapshot {
  return {
    upcomingVisitDueDate: null,
    failedAttempts: 0,
    failedAttemptsThreshold: 3,
    voucherRecertDays: null,
    voucherRecertWarningDays: 30,
    perCheckpointBreakdown: [],
    incidents: [],
    arrearsCount: 0,
    aftercareExtensionEndDate: null,
    pathCSuppression: null,
  };
}

describe("deriveRowTags — visit_overdue", () => {
  it("emits visit_overdue (high) when the upcoming visit date is strictly past", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        upcomingVisitDueDate: new Date("2026-05-20T12:00:00Z"),
      },
      NOW,
    );
    expect(tags).toEqual([
      { key: "visit_overdue", label: "Visit overdue", severity: "high" },
    ]);
  });

  it("does not emit when the upcoming visit date is in the future", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        upcomingVisitDueDate: new Date("2026-06-10T12:00:00Z"),
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("does not emit when the date matches `now` exactly (strict past only)", () => {
    const tags = deriveRowTags(
      { ...baseSnapshot(), upcomingVisitDueDate: NOW },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("does not emit when source is missing", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — cannot_reach + failed_attempts pair", () => {
  it("emits both tags when failedAttempts meets the threshold", () => {
    const tags = deriveRowTags(
      { ...baseSnapshot(), failedAttempts: 3, failedAttemptsThreshold: 3 },
      NOW,
    );
    expect(tags.map((t) => t.key)).toEqual(["cannot_reach", "failed_attempts"]);
    expect(tags.find((t) => t.key === "cannot_reach")?.severity).toBe("high");
    expect(tags.find((t) => t.key === "failed_attempts")?.severity).toBe("low");
  });

  it("emits both tags when failedAttempts exceeds the threshold", () => {
    const tags = deriveRowTags(
      { ...baseSnapshot(), failedAttempts: 7, failedAttemptsThreshold: 3 },
      NOW,
    );
    expect(tags.map((t) => t.key)).toEqual(["cannot_reach", "failed_attempts"]);
  });

  it("emits neither tag below the threshold", () => {
    const tags = deriveRowTags(
      { ...baseSnapshot(), failedAttempts: 2, failedAttemptsThreshold: 3 },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("emits neither tag when source is the documented `0` no-data sentinel", () => {
    const tags = deriveRowTags(
      { ...baseSnapshot(), failedAttempts: 0, failedAttemptsThreshold: 3 },
      NOW,
    );
    expect(tags).toEqual([]);
  });
});

describe("deriveRowTags — voucher_critical_<N>d", () => {
  it("emits voucher_critical_<N>d (high) with N in key + label for an in-window deadline", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        voucherRecertDays: 9,
        voucherRecertWarningDays: 30,
      },
      NOW,
    );
    expect(tags).toEqual([
      { key: "voucher_critical_9d", label: "Voucher 9d", severity: "high" },
    ]);
  });

  it("emits voucher_critical_<N>d at the window boundary (days === warningDays)", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        voucherRecertDays: 30,
        voucherRecertWarningDays: 30,
      },
      NOW,
    );
    expect(tags[0]?.key).toBe("voucher_critical_30d");
  });

  it("does not emit when the deadline is beyond the warning window", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        voucherRecertDays: 45,
        voucherRecertWarningDays: 30,
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("collapses past-due to voucher_critical_overdue (degenerate label case)", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        voucherRecertDays: -5,
        voucherRecertWarningDays: 30,
      },
      NOW,
    );
    expect(tags).toEqual([
      {
        key: "voucher_critical_overdue",
        label: "Voucher overdue",
        severity: "high",
      },
    ]);
  });

  it("treats days === 0 as overdue (today is the deadline)", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        voucherRecertDays: 0,
        voucherRecertWarningDays: 30,
      },
      NOW,
    );
    expect(tags[0]?.key).toBe("voucher_critical_overdue");
  });

  it("does not emit when source is missing", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — catch_up", () => {
  it("emits catch_up (med) when any anchor is in catch_up state", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        perCheckpointBreakdown: [
          { state: "complete" },
          { state: "complete" },
          { state: "catch_up" },
          { state: "future" },
        ],
      },
      NOW,
    );
    expect(tags).toEqual([
      { key: "catch_up", label: "Catch-up", severity: "med" },
    ]);
  });

  it("does not emit when no anchor is in catch_up state", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        perCheckpointBreakdown: [
          { state: "complete" },
          { state: "due" },
          { state: "overdue" },
        ],
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("does not emit on an empty breakdown", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — recent_incident", () => {
  it("emits recent_incident (med) for an incident inside the 14-day window", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        incidents: [{ incidentDate: new Date("2026-05-20T12:00:00Z") }],
      },
      NOW,
    );
    expect(tags).toEqual([
      { key: "recent_incident", label: "Recent incident", severity: "med" },
    ]);
  });

  it("emits at the 14-day boundary (inclusive)", () => {
    const fourteenDaysAgo = new Date(NOW.getTime() - 14 * 86_400_000);
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        incidents: [{ incidentDate: fourteenDaysAgo }],
      },
      NOW,
    );
    expect(tags[0]?.key).toBe("recent_incident");
  });

  it("does not emit for incidents older than 14 days", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        incidents: [{ incidentDate: new Date("2026-04-01T00:00:00Z") }],
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("ignores junction rows with a null incidentDate", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        incidents: [{ incidentDate: null }, { incidentDate: null }],
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("does not emit on an empty incidents array", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — arrears", () => {
  it("emits arrears (med) when arrearsCount is at least 1", () => {
    const tags = deriveRowTags(
      { ...baseSnapshot(), arrearsCount: 1 },
      NOW,
    );
    expect(tags).toEqual([
      { key: "arrears", label: "Arrears", severity: "med" },
    ]);
  });

  it("does not emit on an empty arrears collection", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — aftercare_extended (retired in P1H-14)", () => {
  // P1H-14 moved the Aftercare Extended modifier out of the TAGS cluster
  // and into a dedicated `ProgramModifierChip` in the PARTICIPANT cell.
  // The `aftercareExtensionEndDate` field stays on `RowTagSnapshot` for
  // future tag rules, but `deriveRowTags` no longer derives a tag from it.
  it("does NOT emit an aftercare_extended tag even when the extension end date is non-null", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        aftercareExtensionEndDate: new Date("2026-12-31T00:00:00Z"),
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("does not emit when source is null", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — reserved keys (not emitted today)", () => {
  it("does not emit documentation (source field TBD per ticket P1H-03)", () => {
    // The closed inventory the SPA renders must not include `documentation`
    // until the source confirms; the key is reserved but never produced.
    const tags = deriveRowTags(baseSnapshot(), NOW);
    expect(tags.map((t) => t.key)).not.toContain("documentation");
  });
});

describe("deriveRowTags — path_c_suppression", () => {
  // P1H-10 — the derivation function is in production today; the always-null
  // gating moved to the caller (`buildRowTagSnapshot`). These tests cover
  // the post-ratification behavior so the chip lights up correctly the day
  // BR-21 ratifies + the upstream detection ticket starts populating data.

  it("emits path_c_suppression (info) when active is true", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        pathCSuppression: {
          active: true,
          reason: null,
          seenAt: new Date("2026-05-14T12:00:00Z"),
          provider: null,
        },
      },
      NOW,
    );
    expect(tags).toEqual([
      {
        key: "path_c_suppression",
        label: "Path C suppression",
        severity: "info",
      },
    ]);
  });

  it("does not emit when active is false", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        pathCSuppression: {
          active: false,
          reason: null,
          seenAt: null,
          provider: null,
        },
      },
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("does not emit when pathCSuppression is null (the always-null stub state)", () => {
    // This is the production-today branch: every caller passes null until
    // BR-21 ratifies + upstream detection ships.
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});

describe("deriveRowTags — ordering + composition", () => {
  it("returns chips in severity order (high → med → low → info)", () => {
    const tags = deriveRowTags(
      {
        ...baseSnapshot(),
        upcomingVisitDueDate: new Date("2026-05-20T12:00:00Z"),
        failedAttempts: 4,
        failedAttemptsThreshold: 3,
        voucherRecertDays: 12,
        voucherRecertWarningDays: 30,
        perCheckpointBreakdown: [{ state: "catch_up" }],
        incidents: [{ incidentDate: new Date("2026-05-20T12:00:00Z") }],
        arrearsCount: 2,
        // P1H-14 retired the aftercare_extended info-tier tag; seed the
        // info tier via path_c_suppression (the surviving info-tier tag,
        // also dead-coded today but exercised by the derivation function).
        pathCSuppression: {
          active: true,
          reason: null,
          seenAt: new Date("2026-05-20T12:00:00Z"),
          provider: null,
        },
      },
      NOW,
    );
    // Severity-rank by the documented chip ordering — high first so the row's
    // headline signals sit leftmost in the wireframe cluster.
    const severityRank: Record<string, number> = {
      high: 0,
      med: 1,
      low: 2,
      info: 3,
    };
    const ranks = tags.map((t) => severityRank[t.severity]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(tags[0]?.severity).toBe("high");
    expect(tags[tags.length - 1]?.severity).toBe("info");
  });

  it("returns an empty array on a fully-degraded (no-signal) snapshot", () => {
    expect(deriveRowTags(baseSnapshot(), NOW)).toEqual([]);
  });
});
