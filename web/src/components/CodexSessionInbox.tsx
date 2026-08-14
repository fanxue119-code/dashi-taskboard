import { LinearIcon } from "./LinearIcon";
import type { CodexThreadRecord, Project, Task } from "../types";

interface CodexSessionInboxProps {
  threads: CodexThreadRecord[];
  tasks: Task[];
  selectedProject: Project | null;
  selectedProjectId: string;
  hostConnected: boolean;
  liveThreadIds: Set<string>;
  linkingThreadId: string | null;
  onLink: (threadId: string, taskId: string | null) => void;
  onOpenThread: (threadId: string) => void;
}

function sessionTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function CodexSessionInbox({
  threads,
  tasks,
  selectedProject,
  selectedProjectId,
  hostConnected,
  liveThreadIds,
  linkingThreadId,
  onLink,
  onOpenThread,
}: CodexSessionInboxProps) {
  const candidateMatchesProject = (thread: CodexThreadRecord) => (
    selectedProjectId === "local"
      ? thread.codexProjectId === null
      : thread.codexProjectId === selectedProjectId
  );
  const unlinked = hostConnected
    ? threads.filter((thread) => (
        !thread.taskId
        && liveThreadIds.has(thread.threadId)
        && candidateMatchesProject(thread)
      ))
    : [];
  const linked = threads.filter((thread) => thread.taskProjectId === selectedProjectId);

  const renderThread = (thread: CodexThreadRecord) => (
    <article className="codex-session-row" key={thread.threadId}>
      <button
        className="codex-session-main"
        type="button"
        onClick={() => onOpenThread(thread.threadId)}
      >
        <span className="codex-session-title">{thread.title}</span>
        <span className="codex-session-meta">
          <span><LinearIcon name="folder" />{thread.codexProjectName ?? "未识别代码项目"}</span>
          {thread.nativeUpdatedAt && <time dateTime={thread.nativeUpdatedAt}>{sessionTime(thread.nativeUpdatedAt)}</time>}
          {thread.pinned && <b>置顶</b>}
          {thread.active && <b className="is-current">当前</b>}
          {thread.running && <b className="is-running">运行中</b>}
        </span>
      </button>
      <select
        className="codex-session-project"
        aria-label={`将“${thread.title}”关联到任务`}
        value={thread.taskId ?? ""}
        disabled={linkingThreadId === thread.threadId}
        onChange={(event) => onLink(thread.threadId, event.target.value || null)}
      >
        <option value="">未关联任务</option>
        {thread.taskId && !tasks.some((task) => task.id === thread.taskId) && (
          <option value={thread.taskId}>{thread.taskIdentifier ?? "已归档任务"}</option>
        )}
        {tasks.map((task) => (
          <option value={task.id} key={task.id}>{task.identifier} · {task.title}</option>
        ))}
      </select>
      <button
        className="codex-session-open"
        type="button"
        aria-label={`打开“${thread.title}”原会话`}
        title="打开原会话"
        onClick={() => onOpenThread(thread.threadId)}
      >
        <LinearIcon name="openExternal" />
      </button>
    </article>
  );

  return (
    <div className="codex-session-inbox">
      <header className="codex-session-heading">
        <div>
          <span>Codex sessions</span>
          <h1>{selectedProject?.name ?? "当前项目"} · 会话</h1>
        </div>
        <strong>{unlinked.length} 条待关联</strong>
      </header>

      {!hostConnected && (
        <div className="codex-session-host-note" role="status">
          <LinearIcon name="conversation" />
          <span>请在注入的 Codex 窗口使用；这里仅显示已保存的任务关联。</span>
        </div>
      )}

      <section className="codex-session-section" aria-labelledby="codex-session-unlinked">
        <header>
          <h2 id="codex-session-unlinked">待关联会话</h2>
          <span>{unlinked.length}</span>
        </header>
        <div className="codex-session-list">
          {unlinked.map(renderThread)}
          {hostConnected && unlinked.length === 0 && (
            <p className="codex-session-empty">当前项目没有待关联会话。</p>
          )}
          {!hostConnected && (
            <p className="codex-session-empty">未读取 Codex 侧栏，因此不判断是否存在待关联会话。</p>
          )}
        </div>
      </section>

      <section className="codex-session-section" aria-labelledby="codex-session-linked">
        <header>
          <h2 id="codex-session-linked">已关联任务</h2>
          <span>{linked.length}</span>
        </header>
        <div className="codex-session-list">
          {linked.map(renderThread)}
          {linked.length === 0 && (
            <p className="codex-session-empty">当前项目还没有关联会话。</p>
          )}
        </div>
      </section>
    </div>
  );
}
