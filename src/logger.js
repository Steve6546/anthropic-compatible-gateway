import { appendFileSync } from "node:fs";

export function createLogger(config = {}) {
  const enabled = config.logEnabled !== false;
  const logFile = config.logFile || "gateway.log";

  function write(event, data = {}) {
    if (!enabled) return;
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...data
    };
    const line = `${JSON.stringify(entry)}\n`;
    console.log(line.trim());
    try {
      appendFileSync(logFile, line);
    } catch (error) {
      console.error(`gateway logging failed: ${error.message}`);
    }
  }

  return {
    info: write,
    error(event, error, data = {}) {
      write(event, {
        ...data,
        error: {
          name: error?.name,
          message: error?.message,
          stack: error?.stack
        }
      });
    }
  };
}
