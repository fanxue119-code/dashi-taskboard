import assert from "node:assert/strict";
import { test } from "node:test";

import { recommendProjectId } from "../web/src/projectRecommendation.ts";

const projects = [
  { id: "local", name: "全局" },
  { id: "finance-python", name: "finance_python" },
  { id: "hills-nova", name: "Hills Nova" },
];
const tasks = [
  { projectId: "finance-python", title: "生成西安森丘流水账", description: "核对银行流水", labels: ["财务"] },
  { projectId: "hills-nova", title: "学生进场顺序", description: "活动现场", labels: ["NOVA"] },
];

test("global creation recommends one project from task history and keeps ambiguous work unassigned", () => {
  assert.equal(recommendProjectId({
    title: "补齐西安银行流水",
    description: "生成八月流水账",
    attachmentNames: ["西安银行.xlsx"],
  }, projects, tasks), "finance-python");
  assert.equal(recommendProjectId({
    title: "写一份新方案",
    description: "",
    attachmentNames: [],
  }, projects, tasks), null);
});
