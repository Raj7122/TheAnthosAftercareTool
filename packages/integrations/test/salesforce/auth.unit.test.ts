import { describe, expect, it, vi } from "vitest";

import { SfCliKeychainAuth } from "../../src/salesforce/auth.js";

function makeSpawn(
  payload: { stdout?: string; stderr?: string; exitCode?: number },
) {
  return vi.fn(async () => ({
    stdout: payload.stdout ?? "",
    stderr: payload.stderr ?? "",
    exitCode: payload.exitCode ?? 0,
  }));
}

describe("SfCliKeychainAuth", () => {
  it("returns the access token + instance URL from `sf org display --json`", async () => {
    const spawnImpl = makeSpawn({
      stdout: JSON.stringify({
        result: {
          accessToken: "00DU800000DHR9BMAX!ABC123",
          instanceUrl: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
          username: "rajiv.sukhnandan@pursuit.org",
        },
      }),
    });
    const auth = new SfCliKeychainAuth({ orgAlias: "anthos-demo", spawnImpl });

    expect(await auth.getAccessToken()).toBe("00DU800000DHR9BMAX!ABC123");
    expect(await auth.getInstanceUrl()).toBe(
      "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
    );
    // Both calls share one spawn (token is cached within the refresh buffer).
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("sf", [
      "org",
      "display",
      "--target-org",
      "anthos-demo",
      "--json",
    ]);
  });

  it("tolerates non-zero exit when stdout is valid JSON (sf plugin-load warnings)", async () => {
    // Real-world `sf` writes plugin-load errors to stderr and exits non-zero
    // even when the core command produced valid output on stdout. Parse-first
    // semantics let the keychain auth survive that quirk.
    const spawnImpl = makeSpawn({
      stdout: JSON.stringify({
        result: { accessToken: "T", instanceUrl: "https://x" },
      }),
      stderr: "Error Plugin: @salesforce/cli: could not find package.json",
      exitCode: 1,
    });
    const auth = new SfCliKeychainAuth({ orgAlias: "anthos-demo", spawnImpl });
    expect(await auth.getAccessToken()).toBe("T");
  });

  it("throws SF_AUTH_FAILED on unparseable JSON", async () => {
    const spawnImpl = makeSpawn({ stdout: "<html>login page</html>" });
    const auth = new SfCliKeychainAuth({ orgAlias: "anthos-demo", spawnImpl });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
  });

  it("throws SF_AUTH_FAILED when the JSON is missing the access token", async () => {
    const spawnImpl = makeSpawn({
      stdout: JSON.stringify({ result: { instanceUrl: "https://x" } }),
    });
    const auth = new SfCliKeychainAuth({ orgAlias: "anthos-demo", spawnImpl });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
  });

  it("refreshes the cached token once the buffer expires", async () => {
    const spawnImpl = makeSpawn({
      stdout: JSON.stringify({
        result: { accessToken: "T1", instanceUrl: "https://x" },
      }),
    });
    let nowMs = 1_000_000;
    const auth = new SfCliKeychainAuth({
      orgAlias: "anthos-demo",
      spawnImpl,
      now: () => nowMs,
    });
    await auth.getAccessToken();
    nowMs += 6 * 60 * 1000; // past the 5-min refresh buffer
    await auth.getAccessToken();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });
});
