import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const inboxSource = await readFile(
  new URL("../web/src/components/CodexSessionInbox.tsx", import.meta.url),
  "utf8",
);
const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);

test("session inbox derives project membership from source metadata and links only to tasks", () => {
  assert.match(inboxSource, /selectedProjectId === "local"[\s\S]*thread\.codexProjectId === null/);
  assert.match(inboxSource, /thread\.codexProjectId === selectedProjectId/);
  assert.match(inboxSource, /!thread\.taskId/);
  assert.match(inboxSource, /value=\{thread\.taskId \?\? ""\}/);
  assert.match(inboxSource, /tasks\.map\(\(task\) =>/);
  assert.doesNotMatch(inboxSource, /assignedProjectId|businessProject/);
});

test("injected Codex defaults to sessions while standalone web stays on the issue board", () => {
  assert.match(appSource, /const defaultBoardView: BoardView = embedded \? "sessions" : "issues"/);
  assert.match(appSource, /syncCodexThreads\(sidebarThreadsSnapshot\)/);
  assert.match(appSource, /linkCodexThreadToTask\(threadId, taskId\)/);
  assert.match(appSource, /<CodexSessionInbox/);
});

test("task detail lists saved related sessions and opens the native thread", () => {
  assert.match(detailSource, /relatedCodexThreads: CodexThreadRecord\[\]/);
  assert.match(detailSource, /relatedCodexThreads\.map\(\(thread\) =>/);
  assert.match(detailSource, /onOpenThread\(thread\.threadId\)/);
  assert.match(detailSource, />相关会话</);
});
