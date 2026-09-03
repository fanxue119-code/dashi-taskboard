import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import { normalizeCodexEvent } from "../server/ai-chat-process.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

test("normalized item events retain a bounded public item id", () => {
  const itemId = "x".repeat(70_000);
  const normalized = normalizeCodexEvent({
    type: "item.updated",
    item: {
      id: itemId,
      type: "command_execution",
      command: "npm test",
      status: "in_progress",
    },
  });

  assert.equal(normalized.data.itemId, itemId.slice(0, 65_536));
});

async function createFixture({ setCodexThreadName } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-runner-"));
  const workspacePath = path.join(directory, "workspace");
  const otherWorkspacePath = path.join(directory, "other-workspace");
  await Promise.all([mkdir(workspacePath), mkdir(otherWorkspacePath)]);
  const [workspace, otherWorkspace] = await Promise.all([
    realpath(workspacePath),
    realpath(otherWorkspacePath),
  ]);
  const capturePath = path.join(directory, "capture.jsonl");
  const environmentCapturePath = path.join(directory, "environment-capture.jsonl");
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const descendantPath = path.join(directory, "descendant-alive");
  const executable = path.join(directory, "fake-codex.mjs");
  const nativeNameCalls = [];
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (process.env.FAKE_ENVIRONMENT_CAPTURE_PATH) {
  appendFileSync(process.env.FAKE_ENVIRONMENT_CAPTURE_PATH, JSON.stringify({
    args,
    launcherKeys: Object.keys(process.env).filter((name) => name.startsWith("CODEX_TASKBOARD_")),
    runtimeFile: process.env.CODEX_TASKBOARD_RUNTIME_FILE || null,
  }) + "\\n");
}
if (args[0] === "debug" && args[1] === "models") {
  if (args.length !== 2) process.exit(2);
  process.stdout.write(JSON.stringify({models:[{
    slug:"gpt-real", display_name:"GPT Real", description:"Real fixture",
    default_reasoning_level:"medium",
    supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}],
    service_tiers:[{id:"priority",name:"Fast",description:"fixture"}]
  }]}));
  process.exit(0);
}
if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{"platformFamily":"unix"}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","description":"Real fixture skill","path":"/fixture/real-skill/SKILL.md","interface":{"displayName":"Real Skill"}},{"name":"disabled","enabled":false,"scope":"user"}]}]}}\\n');
    }
  });
} else if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({args,prompt}) + "\\n");
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (!args.includes("resume")) emit({type:"thread.started",thread_id:"codex-thread-1"});
    emit({type:"turn.started"});
    if (prompt.includes("MALFORMED_STUBBORN") || prompt.includes("CALLBACK_FATAL_STUBBORN")) {
      spawn(process.execPath, [
        "-e",
        'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(process.env.FAKE_DESCENDANT_PATH, "alive"), 300); setInterval(() => {}, 1000)',
      ], {env:process.env,stdio:"ignore"});
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      if (prompt.includes("CALLBACK_FATAL_STUBBORN")) {
        emit({type:"thread.started",thread_id:"unexpected-thread"});
      } else {
        process.stdout.write("{not-json}\\n");
      }
      return;
    }
    if (prompt.includes("MALFORMED")) {
      process.stdout.write("{not-json}\\n");
      return;
    }
    emit({type:"item.completed",item:{type:"reasoning",text:"SECRET REASONING"}});
    emit({type:"item.completed",item:{type:"agent_message",text:"Visible answer"}});
    emit({type:"item.completed",item:{type:"command_execution",command:"npm test",status:"completed",exit_code:0,aggregated_output:"ok"}});
    if (prompt.includes("TURN_FAILED_ZERO")) {
      emit({type:"turn.failed",error:{message:"Protocol turn failed"}});
      return;
    }
    if (prompt.includes("ROOT_ERROR_ZERO")) {
      emit({type:"error",message:"Protocol root error"});
      return;
    }
    if (prompt.includes("NO_TERMINAL")) return;
    if (prompt.includes("ITEM_ERROR")) {
      emit({type:"item.completed",item:{id:"item-error-1",type:"error",message:"Recoverable item error"}});
    }
    if (prompt.includes("WAIT")) {
      const timer = setTimeout(() => { emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}); }, 800);
      process.on("SIGTERM", () => { clearTimeout(timer); process.exit(143); });
      return;
    }
    if (prompt.includes("FAIL")) process.exit(7);
    emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
  });
}
`);
  await chmod(executable, 0o755);

  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      project: { rootPaths: [workspace] },
      other: { rootPaths: [otherWorkspace] },
    },
  }));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  database.createProject({ id: "other", name: "Other", workspacePath: null });
  const service = new AiChatService({
    database,
    codexExecutable: executable,
    codexStatePath,
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
    processEnv: {
      ...process.env,
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_DESCENDANT_PATH: descendantPath,
      FAKE_ENVIRONMENT_CAPTURE_PATH: environmentCapturePath,
      CODEX_TASKBOARD_INSTANCE_TOKEN: "must-not-reach-codex",
      CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-reach-codex",
      CODEX_TASKBOARD_PORT: "47823",
      CODEX_TASKBOARD_RUNTIME_FILE: runtimeFile,
      CODEX_TASKBOARD_VERSION: "0.2.0",
    },
    setCodexThreadName: setCodexThreadName ?? (async (input) => {
      nativeNameCalls.push(input);
    }),
    killGraceMs: 50,
  });
  return {
    capturePath,
    database,
    databasePath,
    descendantPath,
    directory,
    environmentCapturePath,
    nativeNameCalls,
    otherWorkspace,
    runtimeFile,
    service,
    workspace,
    async close() {
      await this.service.close();
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events", async () => {
  const fixture = await createFixture();
  try {
    const catalog = await fixture.service.getCatalog("project");
    assert.deepEqual(catalog.models, [{
      slug: "gpt-real",
      displayName: "GPT Real",
      description: "Real fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
      serviceTiers: [{ id: "priority", name: "Fast" }],
    }]);
    assert.deepEqual(catalog.skills, [{
      id: "real-skill",
      label: "Real Skill",
      description: "Real fixture skill",
      path: "/fixture/real-skill/SKILL.md",
      scope: "repo",
    }]);

    const task = fixture.database.createTask({
      projectId: "project",
      title: "Finance 流水账",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.workspacePath, fixture.workspace);
    assert.equal(thread.title, "Taskboard · Finance 流水账");
    assert.equal(thread.taskboardManaged, true);

    const first = await fixture.service.startTurn(thread.id, {
      message: "HIDDEN_SENTINEL \uFFFC first",
      skillIds: ["real-skill"],
    });
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    await waitFor(() => fixture.service.getRun(first.id)?.status !== "running");
    assert.equal(fixture.database.getTask(task.id).status, "in_review");
    assert.equal(fixture.database.getTask(task.id).threadId, "codex-thread-1");
    const second = await fixture.service.startTurn(thread.id, { message: "second" });
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    await waitFor(() => fixture.service.getRun(second.id)?.status !== "running");
    assert.equal(fixture.database.getTask(task.id).status, "in_review");

    const taskBeforeRename = fixture.database.getTask(task.id);
    const renamedTask = fixture.database.updateTask(
      task.id,
      taskBeforeRename.version,
      { title: "Finance 现金流" },
      null,
      { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    fixture.service.syncTaskTitle(renamedTask, task);
    assert.equal(fixture.service.getThread(thread.id).title, "Taskboard · Finance 现金流");
    await waitFor(() => fixture.nativeNameCalls.length === 3);
    assert.deepEqual(fixture.nativeNameCalls, [
      {
        threadId: "codex-thread-1",
        name: "Taskboard · Finance 流水账",
        cwd: fixture.workspace,
      },
      {
        threadId: "codex-thread-1",
        name: "Taskboard · Finance 流水账",
        cwd: fixture.workspace,
      },
      {
        threadId: "codex-thread-1",
        name: "Taskboard · Finance 现金流",
        cwd: fixture.workspace,
      },
    ]);

    const custom = await fixture.service.updateThread(thread.id, { title: "Snow 自定义会话" });
    assert.equal(custom.title, "Snow 自定义会话");
    assert.equal(custom.taskboardManaged, true);
    assert.equal(custom.taskboardAutoName, false);
    const duplicate = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(duplicate.id, thread.id);
    assert.equal(
      fixture.database.listAiChatThreads().filter((item) => item.origin.issueId === task.id).length,
      1,
    );
    const renamedAgain = fixture.database.updateTask(
      renamedTask.id,
      renamedTask.version,
      { title: "Finance 最终" },
      null,
      { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    fixture.service.syncTaskTitle(renamedAgain, renamedTask);
    assert.equal(fixture.service.getThread(thread.id).title, "Snow 自定义会话");
    const nativeNameCallCount = fixture.nativeNameCalls.length;
    const resumed = await fixture.service.startTurn(thread.id, { message: "resume after rename" });
    await waitFor(() => fixture.service.getRun(resumed.id)?.status !== "running");
    assert.equal(fixture.nativeNameCalls.length, nativeNameCallCount);

    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const environmentCaptures = (
      await readFile(fixture.environmentCapturePath, "utf8")
    ).trim().split("\n").map(JSON.parse);
    assert.ok(environmentCaptures.length >= 3);
    const execEnvironmentCaptures = environmentCaptures.filter((entry) => entry.args[0] === "exec");
    const discoveryEnvironmentCaptures = environmentCaptures.filter((entry) => (
      entry.args[0] === "app-server"
      || (entry.args[0] === "debug" && entry.args[1] === "models")
    ));
    assert.ok(execEnvironmentCaptures.length >= 2);
    assert.ok(discoveryEnvironmentCaptures.length >= 1);
    assert.equal(
      execEnvironmentCaptures.every((entry) => (
        entry.launcherKeys.length === 1
        && entry.launcherKeys[0] === "CODEX_TASKBOARD_RUNTIME_FILE"
        && entry.runtimeFile === fixture.runtimeFile
      )),
      true,
    );
    assert.equal(
      discoveryEnvironmentCaptures.every((entry) => entry.launcherKeys.length === 0),
      true,
    );
    assert.deepEqual(captures[0].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "-c", 'approval_policy="on-request"',
      "-c", 'approvals_reviewer="auto_review"',
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "-",
    ]);
    assert.equal(captures[0].args.join(" ").includes("HIDDEN_SENTINEL"), false);
    assert.match(captures[0].prompt, /\[\$manage-taskboard\]\(\/fixture\/manage-taskboard\/SKILL\.md\) e-taskboard/);
    assert.match(
      captures[0].prompt,
      /HIDDEN_SENTINEL \[\$real-skill\]\(\/fixture\/real-skill\/SKILL\.md\) first/,
    );
    assert.match(captures[0].prompt, /taskboard_runtime_file: .*launcher-runtime\.json/);
    assert.match(captures[0].prompt, /do not reuse any runtime path from memory/);
    assert.deepEqual(captures[1].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "-c", 'approval_policy="on-request"',
      "-c", 'approvals_reviewer="auto_review"',
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "resume", "codex-thread-1", "-",
    ]);
    assert.equal(captures[1].args.includes("--last"), false);

    const snapshot = fixture.service.getThreadSnapshot(thread.id);
    assert.equal(snapshot.thread.codexThreadId, "codex-thread-1");
    assert.equal(snapshot.events.some((event) => event.content?.includes("SECRET REASONING")), false);
    assert.equal(snapshot.events.some((event) => event.content === "Visible answer"), true);
    assert.equal(snapshot.events.some((event) => event.type === "command_execution"), true);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("HIDDEN_SENTINEL"), true);
    assert.equal(serialized.includes("<taskboard_context>"), false);
    const persisted = JSON.stringify(
      fixture.database.database.prepare("SELECT * FROM ai_chat_events").all(),
    );
    assert.equal(persisted.includes("<taskboard_context>"), false);
    assert.equal(persisted.includes("SECRET REASONING"), false);
  } finally {
    await fixture.close();
  }
});

test("taskboard-managed issue threads are idempotent across duplicate create calls", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.database.createTask({
      projectId: "project",
      title: "Duplicate dispatch task",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const input = {
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    };
    const threads = await Promise.all([
      fixture.service.createThread(input),
      fixture.service.createThread(input),
    ]);
    assert.equal(threads[0].id, threads[1].id);
    assert.equal(threads[0].taskboardManaged, true);
    assert.equal(
      fixture.database.listAiChatThreads().filter((thread) => thread.origin.issueId === task.id).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("task updates resume the existing managed thread without prematurely clearing blockers", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.database.createTask({
      projectId: "project",
      title: "Resume blocked finance task",
      description: "Wait for the missing statement",
      status: "blocked",
      priority: "none",
      labels: [],
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    const comment = fixture.database.createComment(task.id, {
      body: "两份流水已经补齐，请读取最新附件并继续处理。",
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    });

    const resumed = await fixture.service.resumeTaskFromUpdate(task.id, comment.id);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.thread.id, thread.id);
    assert.equal(fixture.database.listAiChatThreads().length, 1);
    assert.equal(fixture.database.getTask(task.id).status, "blocked");
    await waitFor(() => fixture.service.getRun(resumed.run.id)?.status !== "running");
    assert.equal(fixture.database.getTask(task.id).status, "blocked");

    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.match(captures.at(-1).prompt, new RegExp(comment.id));
    assert.match(captures.at(-1).prompt, /只有确认可以继续时/);
  } finally {
    await fixture.close();
  }
});

test("taskboard-managed native names are serialized and settle on the latest task title", async () => {
  const nativeNameCalls = [];
  const releases = [];
  let visibleNativeName = null;
  const fixture = await createFixture({
    setCodexThreadName: async (input) => {
      nativeNameCalls.push(input);
      await new Promise((resolve) => releases.push(resolve));
      visibleNativeName = input.name;
    },
  });
  try {
    const task = fixture.database.createTask({
      projectId: "project",
      title: "Initial task title",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    fixture.database.updateAiChatThread(thread.id, { codexThreadId: "codex-thread-1" });

    const taskA = fixture.database.updateTask(
      task.id,
      task.version,
      { title: "Task title A" },
      null,
      { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    fixture.service.syncTaskTitle(taskA, task);
    await waitFor(() => nativeNameCalls.length === 1);

    const taskB = fixture.database.updateTask(
      taskA.id,
      taskA.version,
      { title: "Task title B" },
      null,
      { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    fixture.service.syncTaskTitle(taskB, taskA);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nativeNameCalls.length, 1);

    releases.shift()();
    await waitFor(() => nativeNameCalls.length === 2);
    assert.equal(nativeNameCalls[1].name, "Taskboard · Task title B");
    releases.shift()();
    await waitFor(() => visibleNativeName === "Taskboard · Task title B");
  } finally {
    while (releases.length > 0) releases.shift()();
    await fixture.close();
  }
});

test("a native sidebar rename releases management and resume preserves the custom name", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.database.createTask({
      projectId: "project",
      title: "Native rename task",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });

    const firstRun = await fixture.service.startTurn(thread.id, { message: "create native thread" });
    await waitFor(() => fixture.service.getRun(firstRun.id)?.status !== "running");
    await waitFor(() => fixture.nativeNameCalls.length === 1);
    assert.equal(fixture.service.getThread(thread.id).taskboardManaged, true);

    const automaticSnapshot = {
      threadId: "codex-thread-1",
      title: "Taskboard · Native rename task",
      codexProjectId: "project",
      codexProjectName: "Project",
      kind: "local",
      pinned: false,
      active: true,
      running: false,
      nativeUpdatedAt: null,
    };
    fixture.database.upsertCodexThreads([automaticSnapshot]);
    assert.equal(fixture.service.getThread(thread.id).taskboardManaged, true);

    fixture.database.upsertCodexThreads([{
      ...automaticSnapshot,
      title: "Snow 自定义会话",
    }]);
    const released = fixture.service.getThread(thread.id);
    assert.equal(released.taskboardManaged, false);
    assert.equal(released.taskboardAutoName, false);

    const nativeNameCallCount = fixture.nativeNameCalls.length;
    const resumed = await fixture.service.startTurn(thread.id, { message: "resume after native rename" });
    await waitFor(() => fixture.service.getRun(resumed.id)?.status !== "running");
    assert.equal(fixture.nativeNameCalls.length, nativeNameCallCount);
    assert.equal(fixture.database.listCodexThreads()[0].title, "Snow 自定义会话");
  } finally {
    await fixture.close();
  }
});

test("same-thread turns are locked, different threads run concurrently, failures and interrupts settle", async () => {
  const fixture = await createFixture();
  try {
    const firstThread = await fixture.service.createThread({ projectId: "project" });
    const secondThread = await fixture.service.createThread({ projectId: "other" });
    const waiting = await fixture.service.startTurn(firstThread.id, { message: "WAIT" });
    await assert.rejects(
      fixture.service.startTurn(firstThread.id, { message: "must reject" }),
      (error) => error.code === "THREAD_BUSY",
    );
    const parallel = await fixture.service.startTurn(secondThread.id, { message: "normal" });
    await waitFor(() => fixture.service.getRun(parallel.id)?.status === "completed");
    const interrupted = await fixture.service.interrupt(waiting.id);
    assert.equal(interrupted.id, waiting.id);
    await waitFor(() => fixture.service.getRun(waiting.id)?.status === "interrupted");

    const failed = await fixture.service.startTurn(firstThread.id, { message: "FAIL" });
    await waitFor(() => fixture.service.getRun(failed.id)?.status === "failed");
    assert.equal(fixture.service.getRun(failed.id).exitCode, 7);
    assert.equal(
      fixture.service.getThreadSnapshot(firstThread.id).events.some(
        (event) => event.role === "error" && event.content.includes("code 7"),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("a failed taskboard-managed turn moves the owned task to blocked", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.database.createTask({
      projectId: "project",
      title: "Blocked lifecycle",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      threadId: null,
      actor: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
      taskboardManaged: true,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });

    const run = await fixture.service.startTurn(thread.id, { message: "FAIL" });
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    await waitFor(() => fixture.service.getRun(run.id)?.status === "failed");
    assert.equal(fixture.database.getTask(task.id).status, "blocked");
  } finally {
    await fixture.close();
  }
});

test("malformed Codex JSONL fails the run", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "MALFORMED" });
    await waitFor(() => fixture.service.getRun(run.id)?.status === "failed");

    const failed = fixture.service.getRun(run.id);
    assert.equal(failed.error, "Codex emitted malformed JSONL");
    assert.equal(
      fixture.service.getThreadSnapshot(thread.id).events.some(
        (event) => event.role === "error"
          && event.content === "Codex emitted malformed JSONL",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("parser and event callback failures kill a SIGTERM-resistant process group", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedError] of [
      ["MALFORMED_STUBBORN", "Codex emitted malformed JSONL"],
      ["CALLBACK_FATAL_STUBBORN", "Codex returned an unexpected thread id"],
    ]) {
      await rm(fixture.descendantPath, { force: true });
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status === "failed", 700);
      assert.equal(fixture.service.getRun(run.id).error, expectedError);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await assert.rejects(readFile(fixture.descendantPath), (error) => error.code === "ENOENT");
    }
  } finally {
    await fixture.close();
  }
});

test("protocol terminal events determine run success and item errors remain non-fatal", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedStatus] of [
      ["TURN_FAILED_ZERO", "failed"],
      ["ROOT_ERROR_ZERO", "failed"],
      ["NO_TERMINAL", "failed"],
      ["ITEM_ERROR", "completed"],
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status !== "running");
      assert.equal(fixture.service.getRun(run.id).status, expectedStatus, message);
    }
  } finally {
    await fixture.close();
  }
});

test("startTurn revalidates the latest danger sandbox and persisted model settings", async () => {
  const fixture = await createFixture();
  try {
    for (const scenario of [
      {
        changes: { sandbox: "danger-full-access" },
        expectedCode: "DANGER_CONFIRMATION_REQUIRED",
      },
      {
        changes: { model: "retired-model" },
        expectedCode: "INVALID_MODEL",
      },
      {
        changes: { reasoningEffort: "ultra" },
        expectedCode: "INVALID_REASONING_EFFORT",
      },
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const originalGetCatalog = fixture.service.getCatalog.bind(fixture.service);
      let releaseCatalog;
      let catalogRequested = false;
      const catalogGate = new Promise((resolve) => {
        releaseCatalog = resolve;
      });
      fixture.service.getCatalog = async (...args) => {
        catalogRequested = true;
        await catalogGate;
        return originalGetCatalog(...args);
      };

      const pending = fixture.service.startTurn(thread.id, { message: "must not spawn" });
      await waitFor(() => catalogRequested);
      fixture.database.updateAiChatThread(thread.id, scenario.changes);
      releaseCatalog();
      await assert.rejects(pending, (error) => error.code === scenario.expectedCode);
      assert.equal(fixture.database.listAiChatRuns(thread.id).length, 0);
      fixture.service.getCatalog = originalGetCatalog;
    }
  } finally {
    await fixture.close();
  }
});

test("startup marks abandoned runs interrupted while preserving the Codex thread id", async () => {
  const fixture = await createFixture();
  const thread = await fixture.service.createThread({ projectId: "project" });
  fixture.database.database.prepare(
    "UPDATE ai_chat_threads SET codex_thread_id = ?, status = 'running' WHERE id = ?",
  ).run("preserved-session", thread.id);
  fixture.database.database.prepare(`
    INSERT INTO ai_chat_runs (
      id, thread_id, status, exit_code, error, started_at, finished_at
    ) VALUES ('abandoned', ?, 'running', NULL, NULL, ?, NULL)
  `).run(thread.id, new Date().toISOString());
  await fixture.service.close();
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.databasePath);
  const restarted = new AiChatService({
    database: fixture.database,
    codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
    codexStatePath: path.join(fixture.directory, "codex-state.json"),
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
  });
  fixture.service = restarted;
  try {
    assert.equal(restarted.getRun("abandoned").status, "interrupted");
    assert.equal(restarted.getThread(thread.id).codexThreadId, "preserved-session");
  } finally {
    await fixture.close();
  }
});
