import type { Project, Task } from "./types";

const GLOBAL_PROJECT_ID = "local";
const COMMON_TERMS = new Set(["任务", "项目", "处理", "完成", "新增", "修改", "检查", "整理", "相关"]);

function terms(value: string): string[] {
  const normalized = value.toLowerCase();
  const result = new Set(normalized.match(/[a-z0-9_-]{2,}/g) ?? []);
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      result.add(sequence.slice(index, index + 2));
    }
  }
  return [...result].filter((term) => !COMMON_TERMS.has(term));
}

export function recommendProjectId(
  input: { title: string; description: string; attachmentNames: string[] },
  projects: Project[],
  tasks: Task[],
): string | null {
  const query = [input.title, input.description, ...input.attachmentNames].join(" ").toLowerCase();
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return null;

  const ranked = projects
    .filter((project) => project.id !== GLOBAL_PROJECT_ID)
    .map((project) => {
      const identity = `${project.id} ${project.name}`.toLowerCase();
      const history = tasks
        .filter((task) => task.projectId === project.id)
        .map((task) => `${task.title} ${task.description} ${task.labels.join(" ")}`)
        .join(" ")
        .toLowerCase();
      let score = query.includes(project.id.toLowerCase()) || query.includes(project.name.toLowerCase())
        ? 20
        : 0;
      for (const term of queryTerms) {
        if (identity.includes(term)) score += 6;
        else if (history.includes(term)) score += 1;
      }
      return { id: project.id, score };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (!ranked[0] || ranked[0].score < 2 || ranked[0].score === ranked[1]?.score) return null;
  return ranked[0].id;
}
