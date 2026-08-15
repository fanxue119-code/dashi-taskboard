import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const iconSource = await readFile(
  new URL("../web/src/components/TaskboardIcon.tsx", import.meta.url),
  "utf8",
);
const playIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-play.svg", import.meta.url),
  "utf8",
);
const pauseIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-pause.svg", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("project automation state is device-local and scoped by taskboard project", () => {
  assert.match(appSource, /const PROJECT_AUTOMATIONS_KEY = "taskboard\.projectAutomations\.v1"/);
  assert.match(appSource, /type ProjectAutomationStatus = "ACTIVE" \| "PAUSED"/);
  assert.match(appSource, /automationId\?: string/);
  assert.match(appSource, /codexProjectId: string/);
  assert.match(appSource, /type AutomationIntervalMinutes = 5 \| 10 \| 15 \| 30 \| 60/);
  assert.match(appSource, /DEFAULT_AUTOMATION_OPTIONS[\s\S]*?model: "gpt-5\.6-luna"[\s\S]*?reasoningEffort: "max"/);
  assert.match(appSource, /taskboardStorage\.getItem\(PROJECT_AUTOMATIONS_KEY\)/);
  assert.match(appSource, /taskboardStorage\.setItem\(PROJECT_AUTOMATIONS_KEY, JSON\.stringify\(next\)\)/);
  assert.match(appSource, /projectAutomations\[selectedProjectId\]/);
});

test("MVP automation stores a local project policy and pauses legacy cron before migration", () => {
  const reconcileSource = appSource.slice(
    appSource.indexOf("const reconcileProjectAutomation"),
    appSource.indexOf("const saveProjectAutomation"),
  );
  const saveSource = appSource.slice(
    appSource.indexOf("const saveProjectAutomation"),
    appSource.indexOf("function openTaskDetail"),
  );
  assert.match(reconcileSource, /automationId: undefined/);
  assert.match(reconcileSource, /quotaAware: false/);
  assert.match(reconcileSource, /pauseLegacyAutomation\(selectedProjectId, stored\)/);
  assert.match(saveSource, /writeProjectAutomation\(selectedProjectId/);
  assert.match(saveSource, /automationId: undefined/);
  assert.match(saveSource, /status: options\.enabledByUser \? "ACTIVE" : "PAUSED"/);
  assert.match(saveSource, /stored\?\.automationId/);
  assert.match(saveSource, /setAutomaticDispatchRevision/);
  assert.match(appSource, /sendAutomationRequest\(\s*projectId,\s*"pause"/);
  assert.match(appSource, /response\.item\.status !== "PAUSED"/);
  assert.match(appSource, /保留原记录/);
});

test("project mapping is based on exact ids and workspace paths, never project names", () => {
  assert.match(appSource, /hostContext\?\.projects\?\.find\([\s\S]*?candidate\.id === projectId/);
  assert.match(appSource, /deviceWorkspacePaths\[project\.id\] === workspacePath/);
  assert.match(appSource, /请先在 Codex 中添加并映射该项目目录/);
  assert.doesNotMatch(appSource, /project\.name === selectedProject\.name/);
});

test("the project navigation automation menu owns the icon, fields, and accessible popover", () => {
  assert.match(menuSource, /status === "ACTIVE" \? "automationPause" : "automationPlay"/);
  assert.doesNotMatch(menuSource, /statusStarted|statusTodo/);
  assert.match(menuSource, /aria-busy=\{pending/);
  assert.match(menuSource, /自动认领/);
  assert.match(menuSource, /status === "ACTIVE" \? "自动认领中" : "自动化"/);
  assert.match(menuSource, /status === "ACTIVE"\s*\? "运行中"\s*:\s*"等待新任务"/);
  assert.doesNotMatch(menuSource, /已开启自动认领|自动认领未开启/);
  assert.match(menuSource, /自动认领开关/);
  assert.match(menuSource, /任务进入“待认领”后立即触发/);
  assert.doesNotMatch(menuSource, /根据额度启用\/关闭/);
  assert.doesNotMatch(menuSource, /<span>间隔<\/span>/);
  assert.match(menuSource, /AUTOMATION_MODELS\.map/);
  assert.match(menuSource, /EFFORT_LABELS\[effort\]/);
  assert.match(menuSource, /createPortal/);
  assert.match(menuSource, /window\.addEventListener\("resize"/);
  assert.match(menuSource, /window\.addEventListener\("scroll", closeFromViewportChange, true\)/);
  assert.match(menuSource, /no-drag/);
  assert.doesNotMatch(menuSource, /event\.key === "Tab"/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /<ProjectAutomationMenu[\s\S]*?<button[\s\S]*?header-create-button/);
  assert.doesNotMatch(appSource, /toolbar-connection/);
  assert.match(appSource, /仅本地任务面板可用/);
});

test("automation status uses the exported Taskboard play and pause icon assets", () => {
  assert.match(iconSource, /import automationPause from "\.\.\/assets\/figma-taskboard\/automation-pause\.svg"/);
  assert.match(iconSource, /import automationPlay from "\.\.\/assets\/figma-taskboard\/automation-play\.svg"/);
  assert.match(iconSource, /const TASKBOARD_ICONS = \{[\s\S]*?automationPause,[\s\S]*?automationPlay,/);
});

test("automation play and pause retain the exported 16px presentation", () => {
  assert.match(playIcon, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(pauseIcon, /width="16" height="16" viewBox="0 0 16 16"/);
});

test("the automation menu reuses the board switches and keeps form focus chrome suppressed", () => {
  assert.match(menuSource, /className=\{`board-setting-switch\$\{draft\.enabledByUser \? " is-on" : ""\}`\}/);
  assert.match(menuSource, /role="switch"/);
  assert.match(menuSource, /aria-checked=\{draft\.enabledByUser\}/);
  assert.doesNotMatch(menuSource, /draft\.quotaAware \?/);
  assert.doesNotMatch(menuSource, /type="checkbox"/);
  assert.match(styles, /\.project-automation-field select:focus-visible\s*\{[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(styles, /\.project-automation-switch input:focus-visible/);
});

test("unavailable automation state has one notice, clears stale errors, and cannot change", () => {
  assert.match(menuSource, /error && error !== unavailableReason/);
  assert.match(menuSource, /const disabled = pending \|\| Boolean\(unavailableReason\)/);
  assert.equal(menuSource.match(/disabled=\{disabled\}/g)?.length, 3);
  const reconcileSource = appSource.slice(
    appSource.indexOf("const reconcileProjectAutomation"),
    appSource.indexOf("const saveProjectAutomation"),
  );
  assert.match(
    reconcileSource,
    /automationProjectContext\.unavailableReason[\s\S]*?\) \{\s*setAutomationError\(null\);\s*return;/,
  );
  assert.doesNotMatch(reconcileSource, /setAutomationError\(automationProjectContext\.unavailableReason/);
});

test("automation changes submit immediately with model-specific effort normalization", () => {
  assert.match(menuSource, /onChange: \(options: AutomationOptions\) => void/);
  assert.match(menuSource, /const disabled = pending \|\| Boolean\(unavailableReason\)/);
  assert.match(menuSource, /const submitChange = \(next: AutomationOptions\) => \{[\s\S]*?setDraft\(next\);[\s\S]*?onChange\(next\);[\s\S]*?\}/);
  assert.match(menuSource, /submitChange\(withAutomationModel\(draft, event\.target\.value as AutomationModel\)\)/);
  assert.match(menuSource, /getAutomationModel\(draft\.model\)\.efforts\.map/);
  assert.match(menuSource, /<option key=\{effort\} value=\{effort\}>\{EFFORT_LABELS\[effort\]\}<\/option>/);
  assert.match(menuSource, /low: "轻度"/);
  assert.match(menuSource, /xhigh: "极高 \(xhigh\)"/);
  assert.match(menuSource, /max: "最高"/);
  assert.match(menuSource, /ultra: "极高 \(ultra\)"/);
  assert.doesNotMatch(menuSource, />取消</);
  assert.doesNotMatch(menuSource, />保存</);
  assert.doesNotMatch(menuSource, /project-automation-actions/);
  assert.doesNotMatch(menuSource, /onSave/);
  assert.doesNotMatch(styles, /\.project-automation-actions/);
});

test("pending completion reconciles the optimistic draft to confirmed host state", () => {
  assert.match(menuSource, /const wasPendingRef = useRef\(pending\)/);
  assert.match(
    menuSource,
    /if \(wasPendingRef\.current && !pending\) \{\s*setDraft\(\{ \.\.\.DEFAULT_OPTIONS, \.\.\.automation \}\);\s*\}/,
  );
  assert.match(menuSource, /wasPendingRef\.current = pending/);
  assert.match(menuSource, /disabled=\{disabled\}/);
});

test("opening settings and changing projects reconcile the local event-driven policy", () => {
  const reconcileSource = appSource.slice(
    appSource.indexOf("const reconcileProjectAutomation"),
    appSource.indexOf("const saveProjectAutomation"),
  );
  const saveSource = appSource.slice(
    appSource.indexOf("const saveProjectAutomation"),
    appSource.indexOf("function openTaskDetail"),
  );
  assert.match(reconcileSource, /writeProjectAutomation\(selectedProjectId, \{/);
  assert.match(reconcileSource, /status: latest\.enabledByUser \? "ACTIVE" : "PAUSED"/);
  assert.match(reconcileSource, /latest\.automationId !== stored\.automationId/);
  assert.match(saveSource, /writeProjectAutomation\(selectedProjectId, \{/);
  assert.match(saveSource, /quotaAware: false/);
  assert.match(saveSource, /pauseLegacyAutomation\(selectedProjectId, stored\)/);
});

test("todo tasks dispatch through local AI immediately and remain serialized", () => {
  assert.match(appSource, /const resolveAutomationProjectContext = useCallback\(\(projectId: string\)/);
  assert.match(appSource, /const automaticDispatchesRef = useRef\(new Map<string, AutomaticDispatchEntry>\(\)\)/);
  assert.match(appSource, /automaticTaskKey\(task\)/);
  assert.match(appSource, /chooseAutomaticDispatch\(/);
  assert.match(appSource, /if \(!localAiChatAvailable \|\| !aiChatThreadsHydrated\) return/);
  assert.match(appSource, /recordAutomaticSkip\(skip\)/);
  assert.match(appSource, /createAiChatThread\(\{[\s\S]*?issueId: task\.id/);
  assert.match(appSource, /startAiChatTurn\(thread\.id/);
  assert.match(appSource, /subscribeAiChatThread\(/);
  assert.match(appSource, /自动认领不会接管已有会话/);
  assert.match(appSource, /scheduleAutomaticDispatchRecovery\(/);
  assert.match(appSource, /stopAutomaticDispatchMonitoring\(/);
  assert.doesNotMatch(appSource, /const wakeAutomationForTodo/);
  assert.equal(appSource.match(/void wakeAutomationForTodo\(/g)?.length ?? 0, 0);
});
