import assert from "node:assert/strict";
import { test } from "node:test";

import {
  automaticTaskKey,
  chooseAutomaticDispatch,
} from "../web/src/automaticDispatchState.ts";

const projectId = "hills-nova";

function task(id, sortOrder, version = 1) {
  return {
    id,
    identifier: `LOCAL-${id}`,
    projectId,
    title: id,
    status: "todo",
    sortOrder,
    version,
    threadId: null,
    createdAt: `2026-08-15T00:0${sortOrder}:00.000Z`,
  };
}

function thread(issueId, status = "idle") {
  return {
    id: `thread-${issueId}`,
    title: issueId,
    status,
    origin: { projectId, issueId },
    currentRun: status === "running" ? { id: `run-${issueId}`, status: "running" } : null,
  };
}

function entry(currentTask, phase) {
  return {
    taskId: currentTask.id,
    taskKey: automaticTaskKey(currentTask),
    projectId,
    phase,
    thread: null,
    runId: null,
    error: null,
  };
}

test("hydration must finish before an automatic task can be selected", () => {
  const result = chooseAutomaticDispatch({
    projectId,
    tasks: [task("one", 1)],
    aiThreads: [],
    dispatches: [],
    hydrated: false,
  });

  assert.deepEqual(result, { kind: "wait", reason: "hydrating", skipped: [] });
});

test("a legacy automation pending pause must block automatic dispatch", () => {
  const result = chooseAutomaticDispatch({
    projectId,
    tasks: [task("one", 1)],
    aiThreads: [],
    dispatches: [],
    hydrated: true,
    automationId: "legacy-cron-1",
  });

  assert.deepEqual(result, {
    kind: "wait",
    reason: "legacy-automation-pending",
    skipped: [],
  });
});

test("an existing local issue thread is never duplicated and the next todo can be selected", () => {
  const first = task("one", 1);
  const second = task("two", 2);
  const result = chooseAutomaticDispatch({
    projectId,
    tasks: [first, second],
    aiThreads: [thread(first.id, "idle")],
    dispatches: [],
    hydrated: true,
  });

  assert.equal(result.kind, "dispatch");
  assert.equal(result.task.id, second.id);
  assert.deepEqual(result.skipped.map((skip) => [skip.task.id, skip.reason]), [
    [first.id, "existing-local-thread"],
  ]);
});

test("a failed task version is skipped so the next todo can be selected", () => {
  const failed = task("one", 1);
  const next = task("two", 2);
  const result = chooseAutomaticDispatch({
    projectId,
    tasks: [failed, next],
    aiThreads: [],
    dispatches: [entry(failed, "failed")],
    hydrated: true,
  });

  assert.equal(result.kind, "dispatch");
  assert.equal(result.task.id, next.id);
  assert.deepEqual(result.skipped.map((skip) => [skip.task.id, skip.reason]), [
    [failed.id, "failed-task-version"],
  ]);
});

test("a running local thread blocks the whole project", () => {
  const result = chooseAutomaticDispatch({
    projectId,
    tasks: [task("one", 1)],
    aiThreads: [thread("one", "running")],
    dispatches: [],
    hydrated: true,
  });

  assert.deepEqual(result, { kind: "wait", reason: "running-thread", skipped: [] });
});
