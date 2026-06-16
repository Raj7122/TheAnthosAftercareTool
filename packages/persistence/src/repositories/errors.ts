// Sentinel errors raised by the M-CONFIG repository. Discriminated by class so
// callers can branch on `error instanceof UnauthorizedRoleError` without
// pattern-matching error messages.

export class UnauthorizedRoleError extends Error {
  override readonly name = "UnauthorizedRoleError";
  readonly actorId: string;
  readonly actorRole: string;
  readonly requiredRole: string;

  constructor(actorId: string, actorRole: string, requiredRole: string) {
    super(
      `Actor '${actorId}' with role '${actorRole}' is not permitted to perform this action (requires '${requiredRole}').`,
    );
    this.actorId = actorId;
    this.actorRole = actorRole;
    this.requiredRole = requiredRole;
  }
}

export class ConfigurationNotFoundError extends Error {
  override readonly name = "ConfigurationNotFoundError";
  readonly version: number;

  constructor(version: number) {
    super(`No configuration row exists for version=${version}.`);
    this.version = version;
  }
}

export class NoActiveConfigurationError extends Error {
  override readonly name = "NoActiveConfigurationError";

  constructor() {
    super("No active configuration row exists (configuration.is_active = true).");
  }
}

export class MalformedConfigurationError extends Error {
  override readonly name = "MalformedConfigurationError";
  readonly version: number;
  readonly issues: unknown;

  constructor(version: number, issues: unknown) {
    super(
      `Configuration row for version=${version} failed schema validation (ERD §6.6 / VR-05 fail-loud). See .issues for details.`,
    );
    this.version = version;
    this.issues = issues;
  }
}

export class BootstrapConflictError extends Error {
  override readonly name = "BootstrapConflictError";

  constructor() {
    super(
      "Cannot bootstrap (basedOn=null) when prior configuration versions already exist. Pass basedOn to fork from an existing version.",
    );
  }
}
