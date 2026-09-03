const RUNTIME_FILE_ENV = "CODEX_TASKBOARD_RUNTIME_FILE";

export function withoutTaskboardLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("CODEX_TASKBOARD_")),
  );
}

export function withTaskboardRuntimeFileEnvironment(environment = process.env) {
  const sanitized = withoutTaskboardLauncherEnvironment(environment);
  const runtimeFile = environment[RUNTIME_FILE_ENV];
  if (typeof runtimeFile === "string" && runtimeFile.trim()) {
    sanitized[RUNTIME_FILE_ENV] = runtimeFile;
  }
  return sanitized;
}
