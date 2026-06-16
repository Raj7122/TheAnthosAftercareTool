// Edge Config feature-flag provider — the Demo-Mode vendor adapter (P1A-05
// vendor decision: Vercel Edge Config). This is the ONLY file in the codebase
// that imports the vendor SDK; every other surface goes through the wrapper.
// At Production cutover this file is replaced by a LaunchDarkly adapter and
// the FeatureFlagProvider interface — and all consumers — stay unchanged.
//
// All flag rules live in a single Edge Config item (`featureFlags`): a JSON
// object mapping flag key -> FlagRule. One item is used rather than one item
// per flag because Edge Config item keys cannot contain dots, and flag keys
// (e.g. `feature.m_ai.summary`) do.
import { get } from "@vercel/edge-config";

import { evaluateRule, parseFlagRule } from "../rule.js";
import type {
  FeatureFlagProvider,
  FlagEvaluation,
  SpecialistContext,
} from "../types.js";

// The Edge Config item holding every flag rule. Alphanumeric — itself a valid
// Edge Config key (the flag keys nested inside it are not).
export const EDGE_CONFIG_FLAGS_ITEM = "featureFlags";

// Reads one Edge Config item. Injectable so tests run without a connection
// string or network; production defaults to the vendor SDK's `get`.
export type EdgeConfigReader = (itemKey: string) => Promise<unknown>;

export interface EdgeConfigFeatureFlagProviderOptions {
  readonly readImpl?: EdgeConfigReader;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EdgeConfigFeatureFlagProvider implements FeatureFlagProvider {
  private readonly read: EdgeConfigReader;

  constructor(options: EdgeConfigFeatureFlagProviderOptions = {}) {
    this.read = options.readImpl ?? ((itemKey) => get(itemKey));
  }

  // Resolves to null when the flags item is absent or the flag key is not in
  // it — the client maps that to the default (OFF). A malformed item or a
  // malformed rule throws; the client catches it, logs, and fails closed.
  async evaluate(
    flagKey: string,
    context: SpecialistContext,
  ): Promise<FlagEvaluation | null> {
    const raw = await this.read(EDGE_CONFIG_FLAGS_ITEM);
    if (raw === undefined || raw === null) {
      return null;
    }
    if (!isPlainObject(raw)) {
      throw new Error(
        `Edge Config item "${EDGE_CONFIG_FLAGS_ITEM}" must be a JSON object of flag key -> rule.`,
      );
    }
    // Object.entries -> Map: own enumerable keys only (no prototype lookup),
    // and no dynamic bracket indexing on the untrusted item payload.
    const entry = new Map(Object.entries(raw)).get(flagKey);
    if (entry === undefined) {
      return null;
    }
    const rule = parseFlagRule(
      entry,
      `Edge Config item "${EDGE_CONFIG_FLAGS_ITEM}" -> "${flagKey}"`,
    );
    return evaluateRule(rule, context);
  }
}
