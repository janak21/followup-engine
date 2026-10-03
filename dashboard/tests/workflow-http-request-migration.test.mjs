import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

function loadHttpMigration() {
  const file = readdirSync(migrationsDir).find((name) =>
    name.endsWith("_event_workflow_http_request.sql")
  );
  assert.ok(file, "event workflow HTTP request migration should exist");
  return readFileSync(join(migrationsDir, file), "utf8");
}

function loadEdgeDispatchMigration() {
  const file = readdirSync(migrationsDir).find((name) =>
    name.endsWith("_event_workflow_http_edge_dispatch.sql")
  );
  assert.ok(file, "event workflow HTTP edge dispatch migration should exist");
  return readFileSync(join(migrationsDir, file), "utf8");
}

test("event workflow HTTP request migration is event-native and guarded", () => {
  const sql = loadHttpMigration();

  assert.match(sql, /create or replace function public\.process_workflow_http_request_action\(/i);
  assert.match(sql, /create or replace function public\.process_workflow_http_response_collector\(/i);
  assert.match(sql, /create or replace function public\.workflow_http_url_check\(/i);
  assert.match(sql, /create or replace function public\.resolve_workflow_template\(/i);
  assert.match(sql, /public\.resolve_workflow_expr/i);
  assert.match(sql, /net\.http_post/i);
  assert.match(sql, /net\.http_get/i);
  assert.match(sql, /net\.http_delete/i);
  assert.match(sql, /net\._http_response/i);
  assert.match(sql, /blocked_private_ip/i);
  assert.match(sql, /blocked_internal_host/i);
  assert.match(sql, /url_credentials_not_allowed/i);
  assert.match(sql, /ipv6_literal_not_allowed/i);
  assert.match(sql, /'http_request'/i);
  assert.match(sql, /public\.advance_workflow_run\(v_action\.id, 'default'\)/i);
  assert.doesNotMatch(sql, /dispatch_pending_actions\(/i);
  assert.doesNotMatch(sql, /gmail|twilio|retell|openai/i);
});

test("event workflow HTTP edge dispatch migration stops direct user URL egress from SQL", () => {
  const sql = loadEdgeDispatchMigration();

  assert.match(sql, /dispatch-workflow-http-request/i);
  assert.match(sql, /prepared_request/i);
  assert.match(sql, /edge_dispatch_request_id/i);
  assert.match(sql, /public\.get_internal_dispatch_key\(\)/i);
  assert.match(sql, /net\.http_post\(\s*url := v_edge_url/i);
  assert.doesNotMatch(sql, /net\.http_get/i);
  assert.doesNotMatch(sql, /net\.http_delete/i);
  assert.doesNotMatch(sql, /url := v_url/i);
});
