import type { AiChatThread, Task } from "./types";

export type AutomaticDispatchPhase = "starting" | "running" | "completed" | "failed";

export interface AutomaticDispatchEntry {
  taskId: string;
  taskKey: string;
  projectId: string;
  phase: AutomaticDispatchPhase;
  thread: AiChatThread | null;
  runId: string | null;
  error: string | null;
}

export type AutomaticDispatchWaitReason =
  | "hydrating"
  | "legacy-automation-pending"
  | "running-thread"
  | "dispatch-in-flight"
  | "task-transition";

export type AutomaticDispatchSkipReason =
  | "failed-task-version"
  | "existing-local-thread"
  | "bound-thread";

export interface AutomaticDispatchSkip {
  task: Task;
  taskKey: string;
  reason: AutomaticDispatchSkipReason;
  thread?: AiChatThread;
}

export type AutomaticDispatchSelection =
  | {
    kind: "wait";
    reason: AutomaticDispatchWaitReason;
    skipped: AutomaticDispatchSkip[];
  }
  | {
    kind: "dispatch";
    task: Task;
    taskKey: string;
    skipped: AutomaticDispatchSkip[];
  }
  | {
    kind: "none";
    skipped: AutomaticDispatchSkip[];
  };

export function automaticTaskKey(task: Pick<Task, "id" | "version">): string {
  return `${task.id}:${task.version}`;
}

function isRunningThread(thread: AiChatThread): boolean {
  return thread.status === "running" || thread.currentRun?.status === "running";
}

const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 } as const;

function day(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function compareAutomaticDispatchTasks(left: Task, right: Task, today = day(new Date())): number {
  const leftDueNow = Boolean(left.dueDate && left.dueDate <= today);
  const rightDueNow = Boolean(right.dueDate && right.dueDate <= today);
  if (leftDueNow !== rightDueNow) return leftDueNow ? -1 : 1;
  if (left.dueDate !== right.dueDate) {
    if (!left.dueDate) return 1;
    if (!right.dueDate) return -1;
    return left.dueDate.localeCompare(right.dueDate);
  }
  const priorityDifference = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
  return priorityDifference || left.createdAt.localeCompare(right.createdAt);
}

function sortTodoTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => task.status === "todo")
    .sort((left, right) => compareAutomaticDispatchTasks(left, right));
}

function normalizedWorkspacePath(value: string | null | undefined): string | null {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized || null;
}

function taskWorkspacePath(task: Task, projectWorkspacePaths: Record<string, string | null | undefined>): string | null {
  return normalizedWorkspacePath(
    task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : projectWorkspacePaths[task.projectId],
  );
}

export function chooseAutomaticDispatchBatch(input: {
  candidates: Task[];
  tasks: Task[];
  aiThreads: AiChatThread[];
  dispatches: Iterable<AutomaticDispatchEntry>;
  projectWorkspacePaths: Record<string, string | null | undefined>;
  maxConcurrent?: number;
}): Task[] {
  const maxConcurrent = input.maxConcurrent ?? 3;
  const activeTaskIds = new Set(
    input.tasks.filter((task) => task.status === "in_progress").map((task) => task.id),
  );
  const occupiedPaths = new Set<string>();
  for (const task of input.tasks) {
    if (task.status !== "in_progress") continue;
    const workspacePath = taskWorkspacePath(task, input.projectWorkspacePaths);
    if (workspacePath) occupiedPaths.add(workspacePath);
  }
  for (const thread of input.aiThreads) {
    if (!isRunningThread(thread)) continue;
    if (thread.origin.issueId) activeTaskIds.add(thread.origin.issueId);
    const workspacePath = normalizedWorkspacePath(thread.origin.workspacePath);
    if (workspacePath) occupiedPaths.add(workspacePath);
  }
  for (const entry of input.dispatches) {
    if (entry.phase !== "starting" && entry.phase !== "running") continue;
    activeTaskIds.add(entry.taskId);
    const entryTask = input.tasks.find((task) => task.id === entry.taskId);
    const workspacePath = normalizedWorkspacePath(entry.thread?.origin.workspacePath)
      ?? (entryTask
        ? taskWorkspacePath(entryTask, input.projectWorkspacePaths)
        : normalizedWorkspacePath(input.projectWorkspacePaths[entry.projectId]));
    if (workspacePath) occupiedPaths.add(workspacePath);
  }

  let capacity = Math.max(0, maxConcurrent - activeTaskIds.size);
  const selected: Task[] = [];
  for (const task of [...input.candidates].sort((left, right) => compareAutomaticDispatchTasks(left, right))) {
    if (capacity === 0) break;
    const workspacePath = taskWorkspacePath(task, input.projectWorkspacePaths);
    if (!workspacePath || occupiedPaths.has(workspacePath)) continue;
    selected.push(task);
    occupiedPaths.add(workspacePath);
    capacity -= 1;
  }
  return selected;
}

export function chooseAutomaticDispatch(input: {
  projectId: string;
  tasks: Task[];
  aiThreads: AiChatThread[];
  dispatches: Iterable<AutomaticDispatchEntry>;
  hydrated: boolean;
  automationId?: string;
}): AutomaticDispatchSelection {
  if (!input.hydrated) return { kind: "wait", reason: "hydrating", skipped: [] };
  if (input.automationId !== undefined) {
    return { kind: "wait", reason: "legacy-automation-pending", skipped: [] };
  }

  const entries = new Map<string, AutomaticDispatchEntry>();
  for (const entry of input.dispatches) {
    if (entry.projectId === input.projectId) entries.set(entry.taskKey, entry);
  }

  const skipped: AutomaticDispatchSkip[] = [];
  for (const task of sortTodoTasks(input.tasks.filter((candidate) => candidate.projectId === input.projectId))) {
    const taskKey = automaticTaskKey(task);
    const entry = entries.get(taskKey);
    if (entry?.phase === "starting" || entry?.phase === "running") {
      return { kind: "wait", reason: "dispatch-in-flight", skipped };
    }
    if (entry?.phase === "failed") {
      skipped.push({ task, taskKey, reason: "failed-task-version" });
      continue;
    }
    if (entry?.phase === "completed") {
      return { kind: "wait", reason: "task-transition", skipped };
    }

    const existingThread = input.aiThreads.find((thread) => thread.origin.issueId === task.id);
    if (existingThread) {
      if (isRunningThread(existingThread)) {
        return { kind: "wait", reason: "running-thread", skipped };
      }
      if (existingThread.taskboardManaged && existingThread.origin.projectId === task.projectId) {
        return { kind: "dispatch", task, taskKey, skipped };
      }
      skipped.push({ task, taskKey, reason: "existing-local-thread", thread: existingThread });
      continue;
    }
    if (task.threadId) {
      skipped.push({ task, taskKey, reason: "bound-thread" });
      continue;
    }
    return { kind: "dispatch", task, taskKey, skipped };
  }
  return { kind: "none", skipped };
}
