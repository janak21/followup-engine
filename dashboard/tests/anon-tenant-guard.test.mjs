import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const FLAG = "ALLOW_ANON_TENANT";
const NODE_ENV = "NODE_ENV";

function snapshot() {
  return { [FLAG]: process.env[FLAG], [NODE_ENV]: process.env[NODE_ENV] };
}

function restore(snap) {
  for (const k of [FLAG, NODE_ENV]) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

const ENV_URL = new URL("../src/utils/env.js", import.meta.url);
const ASSERT_URL = new URL("../src/utils/assertSafeEnv.js", import.meta.url);

const { isAnonTenantAllowed } = await import(ENV_URL.href);
const { assertSafeEnv } = await import(ASSERT_URL.href);

function withEnv(flag, nodeEnv, fn) {
  return async () => {
    const snap = snapshot();
    if (flag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flag;
    if (nodeEnv === undefined) delete process.env[NODE_ENV];
    else process.env[NODE_ENV] = nodeEnv;
    try {
      await fn();
    } finally {
      restore(snap);
    }
  };
}

test("isAnonTenantAllowed(): development + flag on => true", withEnv("1", "development", () => {
  assert.equal(isAnonTenantAllowed(), true);
}));

test("isAnonTenantAllowed(): development without flag => false", withEnv(undefined, "development", () => {
  assert.equal(isAnonTenantAllowed(), false);
}));

test("isAnonTenantAllowed(): production without flag => false", withEnv(undefined, "production", () => {
  assert.equal(isAnonTenantAllowed(), false);
}));

test("isAnonTenantAllowed(): production + flag on => false (function-level)", withEnv("1", "production", () => {
  assert.equal(isAnonTenantAllowed(), false);
}));

test("assertSafeEnv(): development + flag on => no throw", withEnv("1", "development", () => {
  assert.doesNotThrow(() => assertSafeEnv());
}));

test("assertSafeEnv(): production without flag => no throw", withEnv(undefined, "production", () => {
  assert.doesNotThrow(() => assertSafeEnv());
}));

test("assertSafeEnv(): production + flag on => throws with clear message", withEnv("1", "production", () => {
  assert.throws(
    () => assertSafeEnv(),
    /Unsafe environment.*ALLOW_ANON_TENANT.*production/s
  );
}));

test("boot guard: importing env.js with production + flag on crashes at module load", () => {
  let threw = false;
  let stderr = "";
  try {
    stderr = execFileSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(ENV_URL.href)})`],
      { env: { ...process.env, [FLAG]: "1", [NODE_ENV]: "production" }, encoding: "utf8" }
    );
  } catch (err) {
    threw = true;
    stderr = (err.stderr || "") + (err.stdout || "");
  }
  assert.ok(threw, "env.js must crash when imported under production + flag on");
  assert.match(stderr, /Unsafe environment.*ALLOW_ANON_TENANT/s);
});