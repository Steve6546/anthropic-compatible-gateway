import { appendFile } from "node:fs/promises";

export function createLogger(config = {}) {
  const enabled = config.logEnabled !== false;
  const logFile = config.logFile || "gateway.log";
  const logConsoleEnabled = config.logConsoleEnabled === true;
  let pendingWrite = Promise.resolve();

  function write(event, data = {}) {
    if (!enabled) return;
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...data
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (logConsoleEnabled) console.log(line.trim());
    pendingWrite = pendingWrite
      .then(() => appendFile(logFile, line))
      .catch((error) => {
        console.error(`gateway logging failed: ${error.message}`);
      });
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
    },
    flush() {
      return pendingWrite;
    }
  };
}
