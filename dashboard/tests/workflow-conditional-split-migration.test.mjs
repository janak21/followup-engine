import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

function loadConditionalSplitMigration() {
  const file = readdirSync(migrationsDir).find((name) =>
    name.endsWith("_event_workflow_conditional_split.sql")
  );
  assert.ok(file, "event workflow conditional split migration should exist");
  return readFileSync(join(migrationsDir, file), "utf8");
}

function loadConditionalSplitBracedFieldMigration() {
  const file = readdirSync(migrationsDir).find((name) =>
    name.endsWith("_event_workflow_conditional_split_braced_field.sql")
  );
  assert.ok(file, "event workflow conditional split braced-field migration should exist");
  return readFileSync(join(migrationsDir, file), "utf8");
}

function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

test("event workflow conditional split runs on workflow_actions without providers", () => {
  const sql = loadConditionalSplitMigration();
  const uncommentedSql = stripSqlComments(sql);

  assert.match(sql, /create or replace function public\.evaluate_workflow_condition\(/i);
  assert.match(sql, /create or replace function public\.process_workflow_conditional_split_action\(/i);
  assert.match(sql, /from public\.workflow_actions/i);
  assert.match(sql, /from public\.journey_runs/i);
  assert.match(sql, /public\.resolve_workflow_expr/i);
  assert.match(sql, /v_outcome := 'yes'/i);
  assert.match(sql, /v_outcome := 'no'/i);
  assert.match(sql, /public\.advance_workflow_run\(v_action\.id, v_outcome\)/i);
  assert.match(sql, /dispatch_workflow_run_actions/i);
  assert.match(sql, /dispatch_pending_workflow_actions/i);
  assert.match(sql, /process_journey_webhook/i);
  assert.doesNotMatch(uncommentedSql, /public\.dispatch_pending_actions\(/i);
  assert.doesNotMatch(uncommentedSql, /net\.http|http_post|twilio|gmail|retell|openai|edge/i);
});

test("event workflow conditional split supports payload json alias and future left source rules", () => {
  const sql = loadConditionalSplitMigration();

  assert.match(sql, /v_rule #>> '\{left,source\}'/i);
  assert.match(sql, /left\(v_field, 6\) = '\$json\.'/i);
  assert.match(sql, /left\(v_field, 8\) = 'payload\.'/i);
  assert.match(sql, /left\(v_field, 8\) = 'context\.'/i);
  assert.match(sql, /left\(v_right, 6\) = '\$json\.'/i);
});

test("event workflow conditional split accepts braced json aliases on the left side", () => {
  const sql = loadConditionalSplitBracedFieldMigration();

  assert.match(sql, /create or replace function public\.evaluate_workflow_condition\(/i);
  assert.match(sql, /v_field ~ '\^\\\{\\\{.\*\\\}\\\}\$'/i);
  assert.match(sql, /substring\(v_field from 3 for char_length\(v_field\) - 4\)/i);
  assert.match(sql, /left\(v_field, 6\) = '\$json\.'/i);
  assert.doesNotMatch(stripSqlComments(sql), /net\.http|http_post|twilio|gmail|retell|openai|edge/i);
});
