import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("startup scripts", () => {
  it("does not hardcode gateway tokens in scripts", () => {
    const scripts = [
      readFileSync("scripts/start-all.ps1", "utf8"),
      readFileSync("scripts/test-all.ps1", "utf8")
    ];

    for (const script of scripts) {
      assert.doesNotMatch(script, /my-secret-gateway-token/);
      assert.match(script, /GATEWAY_AUTH_TOKEN/);
      assert.match(script, /\.env/);
    }
  });

  it("does not assign reserved PowerShell PID variables", () => {
    const scripts = [
      readFileSync("scripts/start-all.ps1", "utf8"),
      readFileSync("scripts/stop-all.ps1", "utf8")
    ];

    for (const script of scripts) {
      assert.doesNotMatch(script, /\$pid\s*=/i);
    }
  });
});
