import assert from "node:assert/strict";
import { test } from "node:test";

import {
  automaticTaskKey,
  chooseAutomaticDispatchBatch,
  chooseAutomaticDispatch,
  compareAutomaticDispatchTasks,
} from "../web/src/automaticDispatchState.ts";

const projectId = "hills-nova";

function task(id, sortOrder, version = 1, overrides = {}) {
  return {
    id,
    identifier: `LOCAL-${id}`,
    projectId,
    title: id,
    status: "todo",
    priority: "none",
    dueDate: null,
    developmentContext: null,
    sortOrder,
    version,
    threadId: null,
    createdAt: `2026-08-15T00:0${sortOrder}:00.000Z`,
    ...overrides,
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

test("an idle managed thread is resumed instead of skipped or duplicated", () => {
  const currentTask = task("one", 1);
  const managedThread = { ...thread(currentTask.id, "idle"), taskboardManaged: true };
  const result = chooseAutomaticDispatch({
    projectId,
    tasks: [currentTask],
    aiThreads: [managedThread],
    dispatches: [],
    hydrated: true,
  });

  assert.equal(result.kind, "dispatch");
  assert.equal(result.task.id, currentTask.id);
  assert.deepEqual(result.skipped, []);
});

test("global scheduling uses date then priority and caps non-conflicting work at three", () => {
  const overdue = task("overdue", 4, 1, {
    projectId: "finance",
    dueDate: "2026-09-02",
    priority: "low",
  });
  const urgent = task("urgent", 3, 1, { projectId: "nova", priority: "urgent" });
  const high = task("high", 2, 1, { projectId: "dashboard", priority: "high" });
  const low = task("low", 1, 1, { projectId: "booking", priority: "low" });
  const candidates = [low, high, urgent, overdue];
  const paths = {
    finance: "/repos/finance",
    nova: "/repos/nova",
    dashboard: "/repos/dashboard",
    booking: "/repos/booking",
  };

  assert.equal(compareAutomaticDispatchTasks(overdue, urgent, "2026-09-03") < 0, true);
  assert.deepEqual(chooseAutomaticDispatchBatch({
    candidates,
    tasks: candidates,
    aiThreads: [],
    dispatches: [],
    projectWorkspacePaths: paths,
  }).map((item) => item.id), ["overdue", "urgent", "high"]);
});

test("global scheduling lets waiting review or blocked work release its directory", () => {
  const waitingReview = task("review", 1, 1, {
    projectId: "review-project",
    status: "in_review",
  });
  const waitingInput = task("blocked", 1, 1, {
    projectId: "blocked-project",
    status: "blocked",
  });
  const sameDirectory = task("same", 2, 1, { projectId: "duplicate-project", priority: "urgent" });
  const free = task("free", 3, 1, { projectId: "free-project", priority: "high" });
  const selected = chooseAutomaticDispatchBatch({
    candidates: [sameDirectory, free],
    tasks: [waitingReview, waitingInput, sameDirectory, free],
    aiThreads: [],
    dispatches: [],
    projectWorkspacePaths: {
      "review-project": "/repos/shared",
      "blocked-project": "/repos/shared",
      "duplicate-project": "/repos/shared/",
      "free-project": "/repos/free",
    },
  });

  assert.deepEqual(selected.map((item) => item.id), ["same", "free"]);
});

test("global scheduling keeps actual in-progress work and selected candidates from sharing a directory", () => {
  const active = task("active", 1, 1, {
    projectId: "active-project",
    status: "in_progress",
  });
  const occupied = task("occupied", 2, 1, { projectId: "occupied-project", priority: "urgent" });
  const first = task("first", 3, 1, { projectId: "first-project", priority: "high" });
  const second = task("second", 4, 1, { projectId: "second-project", priority: "medium" });
  const selected = chooseAutomaticDispatchBatch({
    candidates: [occupied, first, second],
    tasks: [active, occupied, first, second],
    aiThreads: [],
    dispatches: [],
    projectWorkspacePaths: {
      "active-project": "/repos/active",
      "occupied-project": "/repos/active",
      "first-project": "/repos/shared",
      "second-project": "/repos/shared/",
    },
  });

  assert.deepEqual(selected.map((item) => item.id), ["first"]);
});
