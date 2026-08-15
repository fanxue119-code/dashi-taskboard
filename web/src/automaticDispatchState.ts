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

function sortTodoTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => task.status === "todo")
    .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
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

  const projectThreads = input.aiThreads.filter((thread) => thread.origin.projectId === input.projectId);
  if (projectThreads.some(isRunningThread)) {
    return { kind: "wait", reason: "running-thread", skipped: [] };
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
