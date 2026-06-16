// Engine-side errors. Fail-loud per TR-PRIORITY-3 (VR-05/06/07). Callers wrap
// these as needed; the engine itself does not catch.

export class ConfigValidationError extends Error {
  override readonly name = "ConfigValidationError";
  readonly code:
    | "VR_05_MISSING_WEIGHT"
    | "VR_05_INVALID_WEIGHT"
    | "VR_06_THRESHOLDS_UNORDERED"
    | "VR_08_UNKNOWN_BARRIER_TYPE";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ConfigValidationError["code"],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class FactorTypeError extends Error {
  override readonly name = "FactorTypeError";
  readonly code: "VR_07_UNKNOWN_TYPE" | "VR_07_NON_FINITE_VALUE";
  readonly factorKey: string;

  constructor(
    code: FactorTypeError["code"],
    factorKey: string,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.factorKey = factorKey;
  }
}
