import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(
    skillSource,
    /first run `issue get` and `comment list`[\s\S]*Read the description and latest comments before deciding whether to start[\s\S]*If they say to wait, not execute, or not start now, stop and report without changing the status/i,
  );
  assert.match(skillSource, /Treat comments as current requirements, including returned work/i);
  assert.match(
    skillSource,
    /If work may start[\s\S]*before reading code, downloading attachments, analyzing the implementation, or doing any other task work[\s\S]*Move a claimable `todo` to `in_progress` with its current `version`[\s\S]*Do not continue until the move succeeds/i,
  );
  assert.match(skillSource, /returned work is in `in_review`[\s\S]*move it back to `in_progress`/i);
  assert.match(
    skillSource,
    /STALE_RUNTIME_ENDPOINT[\s\S]*Before a successful claim or when the binding is unknown, stop business work[\s\S]*already successfully established as the issue's primary execution thread[\s\S]*board synchronization is deferred/i,
  );
  assert.match(
    skillSource,
    /If the move conflicts because the `version` is stale[\s\S]*Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description and latest comments are unchanged[\s\S]*If it was claimed, its status or requirements changed, it is archived, a permanent API error occurs, or the retry fails, stop and report[\s\S]*Never loop/i,
  );

  assert.match(
    skillSource,
    /Verify the requested operation path[\s\S]*Add a comment with the changes, verification result, outcome, and remaining risks[\s\S]*Read the issue again, then move it to `in_review` with its current `version`/i,
  );
});
