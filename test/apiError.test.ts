import assert from "node:assert/strict";
import test from "node:test";
import {
  WIKI_BASE_URL,
  apiErrorPayload,
  buildHelpLink,
} from "../src/lib/apiError.ts";

test("buildHelpLink points at wiki Errors slug", () => {
  const link = buildHelpLink("MISSING_API_KEY");
  assert.equal(link, `${WIKI_BASE_URL}/Errors/MISSING_API_KEY`);
});

test("apiErrorPayload includes errorCode and helpLink", () => {
  const body = apiErrorPayload("VALIDATION_ERROR", "currency is required");
  assert.equal(body.success, false);
  assert.equal(body.errorCode, "VALIDATION_ERROR");
  assert.equal(body.error, "currency is required");
  assert.ok(body.helpLink.includes("VALIDATION_ERROR"));
});

test("apiErrorPayload falls back to catalog message", () => {
  const body = apiErrorPayload("NOT_FOUND");
  assert.equal(body.error, "The requested resource was not found.");
});
