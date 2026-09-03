import type {
  AiChatRun,
  AiChatThread,
  AiChatTodoProgress,
  Task,
} from "./types";

export interface TaskConversationItem {
  key: string;
  kind: "native" | "local-ai";
  title: string;
  source: "task" | "comment" | "local-ai";
  nativeThreadId: string | null;
  aiThreadId: string | null;
  updatedAt: string;
  currentRun: AiChatRun | null;
  latestTodo: AiChatTodoProgress | null;
}

export interface TaskProcessingPresentation {
  running: boolean;
  completed: number | null;
  total: number | null;
  startedAt: string | null;
}

export interface TaskCardPresentation {
  conversations: TaskConversationItem[];
  processing: TaskProcessingPresentation;
  summary: {
    goal: string;
    currentStage: string;
    lastCompleted: string | null;
    nextStep: string;
  };
  unread: boolean;
}

function compactSummary(value: string, limit = 110) {
  const compact = value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[[^\]]+\]\([^)]*\)/g, (match) => match.replace(/^\[|\]\([^)]*\)$/g, ""))
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function progressItems(value: unknown): Array<{ text: string; completed: boolean }> {
  if (!value || typeof value !== "object" || !("items" in value)) return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is { text: string; completed: boolean } => (
    Boolean(item)
    && typeof item === "object"
    && typeof (item as { text?: unknown }).text === "string"
    && typeof (item as { completed?: unknown }).completed === "boolean"
  ));
}

export function normalizeCodexThreadId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.replace(/^(?:local|cloud):/i, "").trim();
}

function newerTimestamp(left: string, right: string) {
  return left > right ? left : right;
}

export function taskConversations(task: Task, aiThreads: AiChatThread[]) {
  const items = new Map<string, TaskConversationItem>();

  for (const ref of task.conversationRefs ?? []) {
    const normalizedId = normalizeCodexThreadId(ref.threadId);
    if (!normalizedId) continue;
    const key = `codex:${normalizedId}`;
    const current = items.get(key);
    const next: TaskConversationItem = {
      key,
      kind: "native",
      title: ref.title || task.title,
      source: ref.source,
      nativeThreadId: ref.threadId,
      aiThreadId: null,
      updatedAt: ref.updatedAt,
      currentRun: null,
      latestTodo: null,
    };
    if (!current || next.updatedAt >= current.updatedAt) items.set(key, next);
  }

  for (const thread of aiThreads) {
    if (thread.origin.projectId !== task.projectId || thread.origin.issueId !== task.id) continue;
    const normalizedId = normalizeCodexThreadId(thread.codexThreadId);
    const key = normalizedId ? `codex:${normalizedId}` : `ai:${thread.id}`;
    const current = items.get(key);
    const threadActivityUpdatedAt = [
      thread.updatedAt,
      thread.currentRun?.startedAt ?? "",
      thread.latestTodo?.updatedAt ?? "",
    ].reduce(newerTimestamp);
    const candidate: TaskConversationItem = {
      key,
      kind: "local-ai",
      title: thread.title || thread.origin.issueIdentifier || task.title,
      source: "local-ai",
      nativeThreadId: current?.nativeThreadId ?? thread.codexThreadId,
      aiThreadId: thread.id,
      updatedAt: current?.kind === "native"
        ? newerTimestamp(current.updatedAt, threadActivityUpdatedAt)
        : threadActivityUpdatedAt,
      currentRun: thread.currentRun ?? null,
      latestTodo: thread.latestTodo ?? null,
    };
    if (current?.kind === "local-ai") {
      const currentRunning = current.currentRun?.status === "running";
      const candidateRunning = candidate.currentRun?.status === "running";
      if (currentRunning && !candidateRunning) continue;
      if (currentRunning === candidateRunning && current.updatedAt > threadActivityUpdatedAt) continue;
    }
    items.set(key, candidate);
  }

  return [...items.values()].sort((left, right) => {
    const leftRunning = left.currentRun?.status === "running" ? 1 : 0;
    const rightRunning = right.currentRun?.status === "running" ? 1 : 0;
    if (leftRunning !== rightRunning) return rightRunning - leftRunning;
    if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.key.localeCompare(right.key);
  });
}

export function taskCardPresentation(
  task: Task,
  aiThreads: AiChatThread[],
  unread: boolean,
  runningNativeThreadId: string | null = null,
  runningNativeTodoProgress: { completed: number; total: number } | null = null,
  taskNativeSession: {
    completed: number | null;
    total: number | null;
    running: boolean;
  } | null | undefined = undefined,
): TaskCardPresentation {
  const conversations = taskConversations(task, aiThreads);
  const runningAi = conversations
    .filter((conversation) => conversation.currentRun?.status === "running")
    .sort((left, right) => (
      (right.currentRun?.startedAt ?? "").localeCompare(left.currentRun?.startedAt ?? "")
    ))[0];
  const normalizedRunningNativeThreadId = normalizeCodexThreadId(runningNativeThreadId);
  const runningNative = task.status === "in_progress" && normalizedRunningNativeThreadId
    ? conversations.find((conversation) => (
        normalizeCodexThreadId(conversation.nativeThreadId) === normalizedRunningNativeThreadId
      ))
    : undefined;
  const running = runningAi ?? runningNative;
  const taskNativeTodoProgress = taskNativeSession
    && taskNativeSession.completed !== null
    && taskNativeSession.total !== null
    ? { completed: taskNativeSession.completed, total: taskNativeSession.total }
    : null;
  const latestTodo = runningAi
    ? runningAi.latestTodo
    : runningNative
      ? taskNativeTodoProgress ?? runningNativeTodoProgress ?? null
      : taskNativeSession !== undefined
        ? taskNativeTodoProgress
        : conversations.find((conversation) => conversation.latestTodo)?.latestTodo ?? null;
  const todoItems = progressItems(latestTodo);
  const incompleteItems = todoItems.filter((item) => !item.completed);
  const completedItems = todoItems.filter((item) => item.completed);
  const currentStage = incompleteItems[0]?.text
    ?? (task.status === "in_review"
      ? "结果已提交，等待确认"
      : task.status === "blocked"
        ? "遇到阻碍，等待补充"
        : task.status === "todo"
          ? "等待自动认领"
          : task.status === "in_progress" && (Boolean(running) || taskNativeSession?.running)
            ? "正在执行"
            : task.status === "in_progress"
              ? "执行会话暂时空闲"
              : "尚未开始");
  const nextStep = incompleteItems[1]?.text
    ?? (task.status === "in_review"
      ? "确认结果，或提出修改意见"
      : task.status === "blocked"
        ? "补充卡片中标明的材料或决定"
        : task.status === "todo"
          ? "由 Codex 认领并开始执行"
          : "完成当前阶段并提交可验收结果");
  return {
    conversations,
    unread,
    summary: {
      goal: compactSummary(task.description) || task.title,
      currentStage: compactSummary(currentStage),
      lastCompleted: completedItems.length > 0
        ? compactSummary(completedItems[completedItems.length - 1].text)
        : task.status === "in_review"
          ? "已提交本轮结果"
          : null,
      nextStep: compactSummary(nextStep),
    },
    processing: {
      running: task.status === "in_progress"
        && (Boolean(running) || taskNativeSession?.running === true),
      completed: latestTodo?.completed ?? null,
      total: latestTodo?.total ?? null,
      startedAt: runningAi?.currentRun?.startedAt ?? null,
    },
  };
}
