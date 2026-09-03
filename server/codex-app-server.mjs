import { spawn } from "node:child_process";

import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LINE_BYTES = 1_048_576;

function protocolError(message) {
  const error = new Error(message);
  error.code = "CODEX_APP_SERVER_PROTOCOL_ERROR";
  return error;
}

/**
 * Set the name stored by the native Codex app-server for an existing thread.
 *
 * This deliberately uses app-server --stdio rather than changing Taskboard's
 * SQLite title. The two stores are independent; the native request is what
 * updates the Codex sidebar title.
 */
export function setCodexThreadName({
  executable,
  threadId,
  name,
  cwd,
  processEnv,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd,
      env: withoutTaskboardLauncherEnvironment(processEnv),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    let requestId = 1;
    const timer = setTimeout(() => finish(protocolError("Codex app-server name update timed out")), timeoutMs);
    timer.unref?.();

    function cleanup() {
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      if (settled || child.stdin.destroyed) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(error);
      }
    }

    function handleMessage(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.id === 1) {
        if (message.error) {
          finish(protocolError(`Codex app-server initialization failed: ${message.error.message ?? "unknown error"}`));
          return;
        }
        send({ method: "initialized" });
        requestId = 2;
        send({
          id: requestId,
          method: "thread/name/set",
          params: { threadId, name },
        });
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) {
        finish(protocolError(`Codex app-server could not set thread name: ${message.error.message ?? "unknown error"}`));
        return;
      }
      finish(null, message.result ?? {});
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        finish(protocolError(`Codex app-server response exceeded ${MAX_LINE_BYTES} bytes`));
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0 && !settled) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch (error) {
            finish(error instanceof SyntaxError ? protocolError("Codex app-server emitted malformed JSON") : error);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(protocolError(`Codex app-server exited before setting thread name (${signal || code})`));
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.2.2" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });
}
