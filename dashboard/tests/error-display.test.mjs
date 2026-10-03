import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getErrorAffectedLabel,
  getErrorIssueDisplay,
  getErrorStatusDisplay,
} from "../src/lib/errorDisplay.ts";

test("error issue display maps raw signatures to readable titles", () => {
  assert.equal(
    getErrorIssueDisplay({ signature: "dispatch_pending_actions:inline:http_request" }).label,
    "Webhook step failed"
  );
  assert.equal(
    getErrorIssueDisplay({ signature: "action_failed_permanent" }).label,
    "Follow-up action failed"
  );
  assert.equal(
    getErrorIssueDisplay({ error_message: "journey not found for lead" }).label,
    "Journey not found"
  );
});

test("error display preserves raw values for developer details", () => {
  const display = getErrorIssueDisplay({ signature: "dispatcher_lock_expired" });
  assert.equal(display.label, "Processing lock expired");
  assert.equal(display.rawValue, "dispatcher_lock_expired");
});

test("error status and affected labels are readable", () => {
  assert.deepEqual(pick(getErrorStatusDisplay("investigating")), {
    label: "Investigating",
    variant: "info",
  });
  assert.equal(
    getErrorAffectedLabel({ workflow_name: "Renewal journey", node_name: "Send email" }),
    "Renewal journey · Send email"
  );
});

function pick(display) {
  return {
    label: display.label,
    variant: display.variant,
  };
}


test("explainActionFailure maps provider errors to cause + suggestion", async () => {
  const { explainActionFailure } = await import("../src/lib/errorDisplay.ts");

  // Twilio STOP / blacklist
  const stop = explainActionFailure("Twilio error 21610: Attempt to send to unsubscribed recipient");
  assert.match(stop.cause, /STOP/);
  assert.match(stop.suggestion, /START/);

  // Invalid number
  assert.match(explainActionFailure("Error 21211: The 'To' number is not a valid phone number.").cause, /not a valid/);

  // Carrier filtering
  assert.match(explainActionFailure("30007 message filtered by carrier").cause, /filtered/i);

  // Hard bounce
  assert.match(explainActionFailure("550 5.1.1 mailbox not found").cause, /does not exist/);

  // OAuth expiry
  assert.match(explainActionFailure("invalid_grant: token has been revoked").suggestion, /Reconnect/);

  // Rate limit
  assert.match(explainActionFailure("429 rate limit exceeded").cause, /quota|rate/i);

  // Suppression wins over other matches
  assert.match(explainActionFailure("lead is suppressed (opt_out)").cause, /suppressed/);

  // Timeouts
  assert.match(explainActionFailure("fetch failed: ETIMEDOUT").suggestion, /transient|retry/i);

  // Unknown → null (caller falls back to raw message)
  assert.equal(explainActionFailure("some totally novel failure"), null);
  assert.equal(explainActionFailure(""), null);
  assert.equal(explainActionFailure(null), null);
});
