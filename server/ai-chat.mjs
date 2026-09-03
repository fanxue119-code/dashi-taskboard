import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { discoverAiCatalog, resolveAiWorkspace } from "./ai-chat-catalog.mjs";
import { setCodexThreadName } from "./codex-app-server.mjs";
import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  spawnCodexTurn,
} from "./ai-chat-process.mjs";

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ERROR_CONTENT_LIMIT = 65_536;
const CODEX_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const TASKBOARD_AGENT = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

function signalProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.turnProcessEnv = options.turnProcessEnv ?? this.processEnv;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.setCodexThreadName = options.setCodexThreadName ?? ((input) => setCodexThreadName({
      ...input,
      executable: this.codexExecutable,
      processEnv: this.processEnv,
    }));
    this.onTaskChanged = options.onTaskChanged ?? (() => {});
    this.resolveContext = options.resolveContext ?? (async (projectId, issueId) => {
      const resolved = await resolveAiWorkspace(projectId, this.codexStatePath, this.database);
      let issue;
      if (issueId !== undefined) {
        issue = this.database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return { ...resolved, issue };
    });
    this.active = new Map();
    this.listeners = new Map();
    this.completions = new Map();
    this.codexThreadNameQueues = new Map();
  }

  listThreads() {
    return this.database.listAiChatThreads();
  }

  getThread(threadId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(
        404,
        "AI_CHAT_THREAD_NOT_FOUND",
        `AI chat thread '${threadId}' does not exist`,
      );
    }
    return thread;
  }

  getThreadSnapshot(threadId) {
    const thread = this.getThread(threadId);
    return {
      thread,
      events: this.database.listAiChatEvents(threadId),
      runs: this.database.listAiChatRuns(threadId),
    };
  }

  getRun(runId) {
    const run = this.database.getAiChatRun(runId);
    if (!run) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${runId}' does not exist`);
    }
    return run;
  }

  subscribe(threadId, listener) {
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  async #catalogForWorkspace(workspacePath) {
    return discoverAiCatalog({
      codexExecutable: this.codexExecutable,
      workspacePath,
      processEnv: this.processEnv,
    });
  }

  async getCatalog(projectId, resolvedContext) {
    const resolved = resolvedContext ?? await this.resolveContext(projectId);
    return this.#catalogForWorkspace(resolved.workspacePath);
  }

  async createThread(input) {
    const resolved = await this.resolveContext(input.projectId, input.issueId);
    const catalog = await this.getCatalog(input.projectId, resolved);
    const model = this.#resolveModel(catalog, input.model);
    const reasoningEffort = input.reasoningEffort ?? model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const sandbox = input.sandbox ?? "workspace-write";
    this.#validateSandbox(sandbox);

    const issue = resolved.issue;
    const taskboardManaged = input.taskboardManaged === true && Boolean(issue);
    const threadInput = {
      title: input.title ?? (issue ? `Taskboard · ${issue.title}` : "New conversation"),
      origin: {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        workspacePath: resolved.workspacePath,
        ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}),
      },
      taskboardManaged,
      taskboardAutoName: taskboardManaged,
      model: model.slug,
      reasoningEffort,
      sandbox,
    };

    return taskboardManaged
      ? this.database.createOrGetTaskboardManagedAiChatThread(threadInput)
      : this.database.createAiChatThread(threadInput);
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    const changesSettings = ["model", "reasoningEffort", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const wasActive = changesSettings && this.#threadIsActive(thread);

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (Object.hasOwn(changes, "model") || Object.hasOwn(changes, "reasoningEffort")) {
      const catalog = await this.getCatalog(thread.origin.projectId);
      thread = this.getThread(threadId);
      const model = this.#resolveModel(catalog, changes.model ?? thread.model);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
    }
    if (wasActive || (changesSettings && this.#threadIsActive(thread))) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }

    return this.database.updateAiChatThread(threadId, {
      ...changes,
      ...(Object.hasOwn(changes, "title") ? { taskboardAutoName: false } : {}),
    });
  }

  deleteThread(threadId) {
    const thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    return this.database.deleteAiChatThread(threadId);
  }

  syncTaskTitle(task, previousTask = null) {
    if (!task?.id || !task.title) return;
    const name = `Taskboard · ${task.title}`;
    for (const thread of this.database.listAiChatThreads()) {
      if (
        thread.origin.issueId !== task.id
        || !thread.taskboardManaged
        || !thread.taskboardAutoName
      ) continue;
      const updated = this.database.updateAiChatThread(thread.id, { title: name });
      if (updated.codexThreadId) {
        void this.#syncCodexThreadName(updated, updated.codexThreadId, updated.currentRun?.id ?? null);
      }
    }
  }

  async syncManagedThreadTitles() {
    const pending = [];
    for (const thread of this.database.listAiChatThreads()) {
      const issueId = thread.origin.issueId;
      const legacyAutomaticName = thread.title.startsWith("自动认领 · ");
      if (
        !issueId
        || !thread.taskboardManaged
        || (!thread.taskboardAutoName && !legacyAutomaticName)
      ) continue;
      const task = this.database.getTask(issueId);
      if (
        !task
        || task.projectId !== thread.origin.projectId
        || task.archivedAt != null
      ) continue;
      const updated = this.database.updateAiChatThread(thread.id, {
        title: `Taskboard · ${task.title}`,
        taskboardAutoName: true,
      });
      if (updated.codexThreadId) {
        pending.push(this.#syncCodexThreadName(
          updated,
          updated.codexThreadId,
          updated.currentRun?.id ?? null,
        ));
      }
    }
    await Promise.all(pending);
  }

  async startTurn(threadId, input) {
    let thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const resolved = await this.resolveContext(
      thread.origin.projectId,
      thread.origin.issueId,
    );
    const catalog = await this.getCatalog(thread.origin.projectId, resolved);

    thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    const model = this.#resolveModel(catalog, thread.model);
    this.#validateReasoningEffort(model, thread.reasoningEffort);
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }

    const skillIds = input.skillIds ?? [];
    const availableSkills = new Map(
      catalog.skills
        .filter((skill) => skill.id !== "manage-taskboard")
        .map((skill) => [skill.id, skill]),
    );
    for (const skillId of skillIds) {
      if (!availableSkills.has(skillId)) {
        throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
      }
    }
    const selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
      imagePaths,
    } = await this.#writeTurnAttachments(attachments);
    try {
      const args = buildCodexArgs(thread, resolved.addDirectories, imagePaths);
      const prompt = buildCodexPrompt(
        thread,
        {
          message: input.message,
          skills: selectedSkills,
          attachmentPaths,
          runtimeFilePath: this.turnProcessEnv.CODEX_TASKBOARD_RUNTIME_FILE,
        },
        this.manageTaskboardSkillPath,
      );
      this.#transitionManagedTask(thread, ["todo", "in_review"], "in_progress");
      const run = this.database.createAiChatRun({ threadId });
      this.#emit(threadId, { type: "ai.run", run });
      const userEventData = {};
      if (skillIds.length > 0) userEventData.skillIds = skillIds;
      if (attachments.length > 0) {
        userEventData.attachments = attachments.map(({ filename, contentType, size }) => ({
          filename,
          contentType,
          size,
        }));
      }
      const userEvent = this.database.insertAiChatEvent({
        threadId,
        runId: run.id,
        type: "user_message",
        role: "user",
        content: input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      });
      this.#emit(threadId, { type: "ai.event", event: userEvent });

      if (thread.codexThreadId) {
        void this.#syncCodexThreadName(thread, thread.codexThreadId, run.id);
      }

      const resumingThreadId = thread.codexThreadId;
      let startedThreadId = null;
      let terminalOutcome = null;
      let terminalError = "";
      const { child, completion } = spawnCodexTurn({
        executable: this.codexExecutable,
        args,
        prompt,
        env: this.turnProcessEnv,
        onRawEvent: (raw) => {
          const normalized = normalizeCodexEvent(raw);
          if (!normalized) return;
          if (normalized.kind === "thread.started") {
            if (
              (resumingThreadId && normalized.threadId !== resumingThreadId)
              || (startedThreadId && normalized.threadId !== startedThreadId)
            ) {
              throw new Error("Codex returned an unexpected thread id");
            }
            startedThreadId = normalized.threadId;
            this.database.updateAiChatThread(threadId, { codexThreadId: normalized.threadId });
            this.#linkManagedTaskThread(thread, normalized.threadId);
            void this.#syncCodexThreadName(thread, normalized.threadId, run.id);
            return;
          }
          const event = this.database.insertAiChatEvent({
            threadId,
            runId: run.id,
            type: normalized.type,
            role: normalized.role,
            content: normalized.content,
            data: normalized.data,
          });
          if (raw.type === "turn.completed" && terminalOutcome === null) {
            terminalOutcome = "completed";
          } else if (raw.type === "turn.failed" || raw.type === "error") {
            terminalOutcome = "failed";
            terminalError ||= normalized.content;
          }
          this.#emit(threadId, { type: "ai.event", event });
        },
      });

      const active = { child, threadId, interrupted: false, temporaryDirectory };
      this.active.set(run.id, active);
      const finalization = completion.then(
        (result) => this.#finishRun({
          run,
          active,
          result,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
        }),
        (error) => this.#finishRun({
          run,
          active,
          error,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
        }),
      );
      this.completions.set(run.id, finalization);
      void finalization.finally(() => this.completions.delete(run.id)).catch(() => {});
      return run;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async resumeTaskFromUpdate(taskId, commentId) {
    const task = this.database.getTask(taskId);
    if (!task || task.archivedAt != null) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    }
    if (task.status !== "blocked" && task.status !== "in_review") {
      return { resumed: false, reason: "task_not_waiting", thread: null, run: null };
    }

    const thread = this.database.getTaskboardManagedAiChatThread(task.projectId, task.id);
    if (!thread) {
      return { resumed: false, reason: "no_managed_thread", thread: null, run: null };
    }
    if (this.#threadIsActive(thread)) {
      return { resumed: false, reason: "already_running", thread, run: thread.currentRun };
    }

    const blockedInstructions = task.status === "blocked"
      ? "任务当前处于 blocked。先读取最新评论和附件，确认新增材料是否真正解除阻碍；只有确认可以继续时，才用 taskctl 将任务移到 in_progress。若仍缺材料，保持 blocked，并评论清楚还缺什么。"
      : "这是用户对待确认结果的补充或修改要求；本轮启动会自动把任务恢复为 in_progress。";
    const run = await this.startTurn(thread.id, {
      message: [
        `Taskboard 任务 ${task.identifier} 收到了用户的新评论或附件（评论 ID：${commentId}）。`,
        "请先用 taskctl 重新读取任务、最新评论及该评论的全部附件，只处理这次新增要求，并复用当前主执行会话继续。",
        blockedInstructions,
        "当前会话已经是本任务的主执行会话。若 Taskboard 在执行途中暂时不可用，不要因此停止本任务范围内的工作；明确告知用户状态同步已延后，并在入口恢复后再补写评论和状态。只有绑定冲突、任务范围不明确或高风险动作需要确认时才停止。",
        "完成可验证工作后评论结果；成功结束本轮时 Taskboard 会自动进入 in_review。不要创建或接管其他会话。",
      ].join("\n"),
    });
    return { resumed: true, reason: null, thread: this.getThread(thread.id), run };
  }

  async interrupt(runId) {
    let run = this.getRun(runId);
    if (run.status !== "running") return run;

    const active = this.active.get(runId);
    if (!active) {
      run = this.database.updateAiChatRun(runId, {
        status: "interrupted",
        error: "Interrupted",
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run });
      return run;
    }

    active.interrupted = true;
    signalProcessGroup(active.child, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
    }, this.killGraceMs);
    timer.unref();

    const completion = this.completions.get(runId);
    if (completion) {
      await Promise.race([completion.catch(() => {}), wait(this.killGraceMs + 25)]);
    }
    return this.getRun(runId);
  }

  async close() {
    const entries = [...this.active.entries()];
    for (const [, active] of entries) {
      active.interrupted = true;
      signalProcessGroup(active.child, "SIGTERM");
    }

    const completions = entries
      .map(([runId]) => this.completions.get(runId))
      .filter(Boolean);
    if (completions.length > 0) {
      const settled = Promise.allSettled(completions);
      await Promise.race([settled, wait(this.killGraceMs)]);
      for (const [runId, active] of entries) {
        if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
      }
      await settled;
    }
    this.listeners.clear();
  }

  #resolveModel(catalog, requestedModel) {
    const model = requestedModel === undefined
      ? catalog.models[0]
      : catalog.models.find((candidate) => candidate.slug === requestedModel);
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        requestedModel === undefined
          ? "Codex did not provide an available model"
          : `Unknown model '${requestedModel}'`,
      );
    }
    return model;
  }

  #validateReasoningEffort(model, reasoningEffort) {
    if (!model.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
  }

  #validateSandbox(sandbox) {
    if (!SANDBOXES.has(sandbox)) {
      throw new ApiError(
        400,
        "INVALID_SANDBOX",
        "'sandbox' must be read-only, workspace-write, or danger-full-access",
      );
    }
  }

  #validateTurnInput(input) {
    if (
      !input
      || typeof input.message !== "string"
      || input.message.length > 100_000
      || (
        input.message.trim() === ""
        && (!Array.isArray(input.attachments) || input.attachments.length === 0)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_MESSAGE",
        "A message or at least one attachment is required",
      );
    }
    if (
      input.skillIds !== undefined
      && (
        !Array.isArray(input.skillIds)
        || input.skillIds.length > 20
        || input.skillIds.some((skillId) => typeof skillId !== "string" || !skillId)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        "'skillIds' must contain at most 20 skill ids",
      );
    }
  }

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [], imagePaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codex-taskboard-ai-turn-"),
    );
    try {
      const attachmentPaths = [];
      const imagePaths = [];
      for (const [index, attachment] of attachments.entries()) {
        const attachmentPath = path.join(
          temporaryDirectory,
          `attachment-${index + 1}-${attachment.filename}`,
        );
        await writeFile(attachmentPath, attachment.data, { flag: "wx", mode: 0o600 });
        attachmentPaths.push(attachmentPath);
        if (CODEX_IMAGE_TYPES.has(attachment.contentType)) imagePaths.push(attachmentPath);
      }
      return { temporaryDirectory, attachmentPaths, imagePaths };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #syncCodexThreadName(thread, codexThreadId, runId) {
    if (!codexThreadId) return;
    const previous = this.codexThreadNameQueues.get(codexThreadId);
    const run = () => this.#syncCodexThreadNameNow(thread, codexThreadId, runId);
    const next = previous
      ? previous.catch(() => {}).then(run)
      : run();
    this.codexThreadNameQueues.set(codexThreadId, next);
    const cleanup = () => {
      if (this.codexThreadNameQueues.get(codexThreadId) === next) {
        this.codexThreadNameQueues.delete(codexThreadId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async #syncCodexThreadNameNow(thread, codexThreadId, runId) {
    const currentThread = this.database.getAiChatThread(thread.id);
    const issueId = currentThread?.origin.issueId;
    if (
      !currentThread?.taskboardManaged
      || !currentThread.taskboardAutoName
      || !issueId
      || !codexThreadId
    ) return;
    const task = this.database.getTask(issueId);
    if (!task || task.projectId !== currentThread.origin.projectId || task.archivedAt != null) return;

    const name = `Taskboard · ${task.title}`;
    try {
      await this.setCodexThreadName({
        threadId: codexThreadId,
        name,
        cwd: currentThread.origin.workspacePath,
      });
    } catch (error) {
      try {
        const event = this.database.insertAiChatEvent({
          threadId: thread.id,
          runId,
          type: "error",
          role: "error",
          content: `原生 Codex 会话名称同步失败：${cappedError(error) || "未知错误"}`,
          data: { status: "failed" },
        });
        this.#emit(thread.id, { type: "ai.event", event });
      } catch {}
    }
  }

  #threadIsActive(thread) {
    return Boolean(thread.currentRun)
      || [...this.active.values()].some((active) => active.threadId === thread.id);
  }

  #transitionManagedTask(thread, allowedStatuses, status, codexThreadId) {
    const issueId = thread?.origin?.issueId;
    if (!thread?.taskboardManaged || !issueId) return null;
    const task = this.database.getTask(issueId);
    if (
      !task
      || task.projectId !== thread.origin.projectId
      || task.archivedAt != null
      || !allowedStatuses.includes(task.status)
    ) return task;
    const updated = this.database.updateTask(
      task.id,
      task.version,
      { status },
      codexThreadId,
      TASKBOARD_AGENT,
    );
    this.onTaskChanged("task.updated", updated);
    return updated;
  }

  #linkManagedTaskThread(thread, codexThreadId) {
    const issueId = thread?.origin?.issueId;
    if (!thread?.taskboardManaged || !issueId || !codexThreadId) return null;
    const task = this.database.getTask(issueId);
    if (
      !task
      || task.projectId !== thread.origin.projectId
      || task.archivedAt != null
      || task.threadId === codexThreadId
    ) return task;
    const updated = this.database.updateTask(
      task.id,
      task.version,
      {},
      codexThreadId,
      TASKBOARD_AGENT,
    );
    this.onTaskChanged("task.updated", updated);
    return updated;
  }

  async #finishRun({
    run,
    active,
    result,
    error,
    resumingThreadId,
    startedThreadId,
    terminalOutcome,
    terminalError,
  }) {
    let status;
    let publicError = null;
    if (active.interrupted) {
      status = "interrupted";
      publicError = "Interrupted";
    } else if (error) {
      status = "failed";
      publicError = cappedError(error) || "Codex turn failed";
    } else if (terminalOutcome() === "failed") {
      status = "failed";
      publicError = terminalError() || "Codex reported a failed turn";
    } else if (result.exitCode !== 0) {
      status = "failed";
      publicError = result.exitCode === null
        ? `Codex exited due to signal ${result.signal ?? "unknown"}`
        : `Codex exited with code ${result.exitCode}`;
    } else if (terminalOutcome() !== "completed") {
      status = "failed";
      publicError = "Codex exited without reporting turn completion";
    } else if (!resumingThreadId && !startedThreadId()) {
      status = "failed";
      publicError = "Codex did not provide a thread id";
    } else {
      status = "completed";
    }

    try {
      if (status === "failed" && terminalOutcome() !== "failed") {
        const errorEvent = this.database.insertAiChatEvent({
          threadId: run.threadId,
          runId: run.id,
          type: "error",
          role: "error",
          content: cappedError(publicError),
          data: { status: "failed" },
        });
        this.#emit(run.threadId, { type: "ai.event", event: errorEvent });
      }
      const updated = this.database.updateAiChatRun(run.id, {
        status,
        exitCode: result?.exitCode ?? null,
        error: publicError === null ? null : cappedError(publicError),
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run: updated });
      const thread = this.database.getAiChatThread(run.threadId);
      if (status === "completed") {
        this.#transitionManagedTask(thread, ["in_progress"], "in_review", thread?.codexThreadId);
      } else if (status === "failed") {
        this.#transitionManagedTask(thread, ["in_progress"], "blocked", thread?.codexThreadId);
      }
      return updated;
    } finally {
      this.active.delete(run.id);
      if (active.temporaryDirectory) {
        await rm(active.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  #emit(threadId, event) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
