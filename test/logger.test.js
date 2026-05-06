import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLogger } from "../src/logger.js";

describe("logger", () => {
  it("writes log entries through a flushable async stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-logger-"));
    const logFile = join(dir, "gateway.log");
    try {
      const logger = createLogger({ logFile, logEnabled: true });

      logger.info("test.event", { ok: true });

      assert.equal(typeof logger.flush, "function");
      await logger.flush();
      assert.match(readFileSync(logFile, "utf8"), /"event":"test.event"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
