export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];

export const DEFAULT_PROJECT_ID = "local";
export const GLOBAL_TASK_TODO_BLOCKED_MESSAGE = "全局任务不能进入“待认领”，请先选择所属项目，或改为“待立项”。";

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(value);
}

export function isGlobalTaskTodo(projectId, status) {
  return projectId === DEFAULT_PROJECT_ID && status === "todo";
}
