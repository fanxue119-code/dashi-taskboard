import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import { TaskboardIcon } from "./TaskboardIcon";

type AutomationStatus = "ACTIVE" | "PAUSED";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
}

export interface GlobalAutomationProject {
  id: string;
  name: string;
  automation?: Partial<AutomationState>;
  unavailableReason: string | null;
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  globalProjects?: GlobalAutomationProject[];
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
  onGlobalProjectChange?: (projectId: string, options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高 (xhigh)",
  max: "最高",
  ultra: "极高 (ultra)",
};

export function ProjectAutomationMenu({
  automation,
  globalProjects,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
  onGlobalProjectChange,
}: ProjectAutomationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const isGlobal = globalProjects !== undefined;
  const activeProjectCount = globalProjects?.filter((project) => (
    project.automation?.enabledByUser && project.automation.status === "ACTIVE"
  )).length ?? 0;
  const status = isGlobal
    ? (activeProjectCount > 0 ? "ACTIVE" : "PAUSED")
    : automation?.status ?? "PAUSED";
  const stateLabel = !automation?.enabledByUser
    ? "已暂停"
    : status === "ACTIVE"
      ? "运行中"
      : "等待新任务";
  const disabled = pending || Boolean(unavailableReason);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={isGlobal ? "全局自动认领设置" : "自动认领待办设置"}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      {isGlobal ? (
        <>
          <div className="project-automation-menu-heading">
            <strong>全局自动认领</strong>
            <span className={activeProjectCount > 0 ? "is-active" : "is-paused"}>
              {activeProjectCount > 0 ? `已开启 ${activeProjectCount} 个项目` : "全部暂停"}
            </span>
          </div>
          <p className="project-automation-note project-automation-global-note">
            自动认领仍按项目隔离。你可在这里逐个开关，不会一次性放出所有项目。
          </p>
          <div className="project-automation-project-list">
            {globalProjects.length > 0 ? globalProjects.map((project) => {
              const options = { ...DEFAULT_OPTIONS, ...project.automation };
              const projectDisabled = pending || Boolean(project.unavailableReason);
              return (
                <div className="project-automation-project" key={project.id}>
                  <span>
                    <strong>{project.name}</strong>
                    {project.unavailableReason && <small>{project.unavailableReason}</small>}
                  </span>
                  <button
                    type="button"
                    className={`board-setting-switch${options.enabledByUser ? " is-on" : ""}`}
                    role="switch"
                    aria-label={`${project.name}自动认领`}
                    aria-checked={options.enabledByUser}
                    disabled={projectDisabled}
                    onClick={() => onGlobalProjectChange?.(project.id, {
                      ...options,
                      enabledByUser: !options.enabledByUser,
                    })}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
              );
            }) : (
              <p className="project-automation-empty">暂无已有任务或已配置自动认领的项目。</p>
            )}
          </div>
          {error && <p className="project-automation-error" role="alert">{error}</p>}
        </>
      ) : (
        <>
          <div className="project-automation-menu-heading">
            <strong>自动认领待办</strong>
            <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
              {stateLabel}
            </span>
          </div>
          <div className="project-automation-switch">
            <span>自动认领开关</span>
            <button
              type="button"
              className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
              role="switch"
              aria-checked={draft.enabledByUser}
              disabled={disabled}
              onClick={() => submitChange({
                ...draft,
                enabledByUser: !draft.enabledByUser,
              })}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          <p className="project-automation-note">
            任务进入“待认领”后立即触发；MVP 不使用定时扫描或额度自动切换。
          </p>
          <label className="project-automation-field">
            <span>模型</span>
            <select
              value={draft.model}
              disabled={disabled}
              onChange={(event) => submitChange(withAutomationModel(draft, event.target.value as AutomationModel))}
            >
              {AUTOMATION_MODELS.map((model) => (
                <option key={model.slug} value={model.slug}>{model.label}</option>
              ))}
            </select>
          </label>
          <label className="project-automation-field">
            <span>推理强度</span>
            <select
              value={draft.reasoningEffort}
              disabled={disabled}
              onChange={(event) => submitChange({
                ...draft,
                reasoningEffort: event.target.value as AutomationReasoningEffort,
              })}
            >
              {getAutomationModel(draft.model).efforts.map((effort) => (
                <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
              ))}
            </select>
          </label>
          {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
          {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
        </>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : isGlobal ? "is-global" : "is-paused"}`}
        aria-label={isGlobal ? "全局自动认领设置" : status === "ACTIVE" ? "自动认领中" : "自动化"}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={isGlobal ? "全局自动认领设置" : status === "ACTIVE" ? "自动认领中" : "自动化"}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{isGlobal
          ? activeProjectCount > 0 ? `自动认领 ${activeProjectCount}` : "自动认领设置"
          : status === "ACTIVE" ? "自动认领中" : "自动化"}</span>
      </button>
      {menu}
    </>
  );
}
