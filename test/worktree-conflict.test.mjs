import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = {
  type: "user",
  id: "worktree-conflict-tester",
  name: "Worktree Conflict Tester",
  avatarUrl: null,
};

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktree-conflict-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  return {
    database,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createProject(database) {
  return database.createProject({
    id: "worktree-conflict",
    name: "Worktree Conflict",
    workspacePath: "/tmp/worktree-conflict",
  });
}

function createTask(database, title, overrides = {}) {
  return database.createTask({
    projectId: "worktree-conflict",
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    ...overrides,
  });
}

test("a worktree can be claimed by only one active task", async () => {
  const fixture = await createFixture();
  try {
    createProject(fixture.database);
    const worktreePath = "/tmp/worktree-conflict/./shared";
    const first = createTask(fixture.database, "First task", {
      developmentContext: { type: "worktree", path: worktreePath, branch: "task/first" },
    });
    const second = createTask(fixture.database, "Second task", {
      developmentContext: { type: "worktree", path: "/tmp/worktree-conflict/shared", branch: "task/second" },
    });

    const claimed = fixture.database.moveTask(
      first.id,
      first.version,
      "in_progress",
      undefined,
      undefined,
      actor,
    );
    assert.equal(claimed.status, "in_progress");

    assert.throws(
      () => fixture.database.moveTask(
        second.id,
        second.version,
        "in_progress",
        undefined,
        undefined,
        actor,
      ),
      (error) => (
        error?.status === 409
        && error?.code === "WORKTREE_CONFLICT"
        && error?.details?.identifier === first.identifier
        && error?.details?.worktreePath === "/tmp/worktree-conflict/shared"
      ),
    );
    assert.equal(fixture.database.getTask(second.id).status, "todo");

    const released = fixture.database.moveTask(
      claimed.id,
      claimed.version,
      "done",
      undefined,
      undefined,
      actor,
    );
    const reassigned = fixture.database.moveTask(
      second.id,
      second.version,
      "in_progress",
      undefined,
      undefined,
      actor,
    );
    assert.equal(released.status, "done");
    assert.equal(reassigned.status, "in_progress");
  } finally {
    await fixture.close();
  }
});

test("creating or editing an active task cannot bypass a worktree conflict", async () => {
  const fixture = await createFixture();
  try {
    createProject(fixture.database);
    const first = createTask(fixture.database, "First task", {
      status: "in_progress",
      developmentContext: { type: "worktree", path: "/tmp/worktree-conflict/shared", branch: "task/first" },
    });

    assert.throws(
      () => createTask(fixture.database, "Second task", {
        status: "in_progress",
        developmentContext: { type: "worktree", path: "/tmp/worktree-conflict/shared", branch: "task/second" },
      }),
      (error) => error?.code === "WORKTREE_CONFLICT" && error?.details?.identifier === first.identifier,
    );

    const second = createTask(fixture.database, "Second task");
    assert.throws(
      () => fixture.database.updateTask(
        second.id,
        second.version,
        {
          status: "in_review",
          developmentContext: {
            type: "worktree",
            path: "/tmp/worktree-conflict/shared",
            branch: "task/second",
          },
        },
        undefined,
        actor,
      ),
      (error) => error?.code === "WORKTREE_CONFLICT" && error?.details?.identifier === first.identifier,
    );
    assert.equal(fixture.database.getTask(second.id).status, "todo");
    assert.equal(fixture.database.getTask(second.id).developmentContext, null);
  } finally {
    await fixture.close();
  }
});
