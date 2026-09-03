import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setCodexThreadName } from "../server/codex-app-server.mjs";

test("native Codex app-server thread name requests use thread/name/set", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-codex-name-"));
  const executable = path.join(directory, "fake-codex.mjs");
  const capture = path.join(directory, "capture.json");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      process.stdout.write(JSON.stringify({ id: 1, result: { platformFamily: "unix" } }) + "\\n");
    } else if (message.method === "thread/name/set") {
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify(message.params));
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
  }
});
`);
  await chmod(executable, 0o755);
  try {
    const result = await setCodexThreadName({
      executable,
      threadId: "01900000-0000-7000-8000-000000000001",
      name: "Taskboard · Finance 流水账",
      cwd: directory,
      processEnv: {
        ...process.env,
        CODEX_TASKBOARD_RUNTIME_FILE: "/private/tmp/should-not-leak.json",
      },
    });
    assert.deepEqual(result, {});
    assert.deepEqual(
      JSON.parse(await readFile(capture, "utf8")),
      {
        threadId: "01900000-0000-7000-8000-000000000001",
        name: "Taskboard · Finance 流水账",
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
