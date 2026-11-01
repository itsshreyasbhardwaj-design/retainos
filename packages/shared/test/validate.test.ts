import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateProperties, eventNameAdvice, EVENT_NAME_RE, type EventSpec } from "../src/validate.ts";

const spec: EventSpec = {
  name: "core_action_completed",
  version: 1,
  properties: [
    { name: "feature", type: "string", required: true },
    { name: "duration_ms", type: "number", required: false },
    { name: "first_time", type: "boolean", required: false },
    { name: "plan", type: "string", required: false, allowed: ["free", "starter", "growth"] },
  ],
  allowUnknownProperties: false,
};

describe("validateProperties", () => {
  test("accepts a well-formed payload", () => {
    const r = validateProperties({ feature: "first_project", duration_ms: 1200, first_time: true }, spec);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { feature: "first_project", duration_ms: 1200, first_time: true });
  });

  test("rejects a missing required property", () => {
    const r = validateProperties({ duration_ms: 10 }, spec);
    assert.equal(r.ok, false);
    const issues = (!r.ok && (r.error.detail?.issues as any[])) || [];
    assert.ok(issues.some((i) => i.field === "feature" && /required/.test(i.problem)));
  });

  test("rejects a wrong property type instead of coercing it", () => {
    const r = validateProperties({ feature: "x", duration_ms: "1200" }, spec);
    assert.equal(r.ok, false);
    const issues = (!r.ok && (r.error.detail?.issues as any[])) || [];
    assert.ok(issues.some((i) => i.field === "duration_ms" && /expected number/.test(i.problem)));
  });

  test("rejects values outside a closed allowed set", () => {
    const r = validateProperties({ feature: "x", plan: "enterprise" }, spec);
    assert.equal(r.ok, false);
  });

  test("rejects undeclared properties when the schema is closed", () => {
    const r = validateProperties({ feature: "x", sneaky: "1" }, spec);
    assert.equal(r.ok, false);
  });

  test("allows undeclared properties when the schema is open", () => {
    const open: EventSpec = { ...spec, allowUnknownProperties: true };
    const r = validateProperties({ feature: "x", extra: "1" }, open);
    assert.equal(r.ok, true);
  });

  test("accepts anything well-typed when no schema is registered", () => {
    const r = validateProperties({ anything: "goes", n: 1, b: false }, null);
    assert.equal(r.ok, true);
  });

  test("rejects non-scalar values", () => {
    assert.equal(validateProperties({ nested: { a: 1 } } as any, null).ok, false);
    assert.equal(validateProperties({ list: [1, 2] } as any, null).ok, false);
    assert.equal(validateProperties({ bad: NaN }, null).ok, false);
    assert.equal(validateProperties({ bad: Infinity }, null).ok, false);
  });

  test("treats null and undefined as absent rather than invalid", () => {
    const r = validateProperties({ feature: "x", duration_ms: null, first_time: undefined } as any, spec);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { feature: "x" });
  });

  test("rejects oversized strings", () => {
    const r = validateProperties({ feature: "a".repeat(1025) }, spec);
    assert.equal(r.ok, false);
  });

  test("rejects too many properties", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 65; i++) props[`p_${i}`] = i;
    const r = validateProperties(props, null);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, "validation_failed");
  });

  test("rejects malformed property names", () => {
    assert.equal(validateProperties({ "Bad-Name": 1 }, null).ok, false);
    assert.equal(validateProperties({ " leading": 1 }, null).ok, false);
  });
});

describe("event naming", () => {
  test("regex accepts lower_snake_case only", () => {
    assert.ok(EVENT_NAME_RE.test("signup_completed"));
    assert.ok(EVENT_NAME_RE.test("project2_created"));
    assert.ok(!EVENT_NAME_RE.test("Signup_Completed"));
    assert.ok(!EVENT_NAME_RE.test("signup-completed"));
    assert.ok(!EVENT_NAME_RE.test("signup__completed"));
    assert.ok(!EVENT_NAME_RE.test("_signup"));
  });

  test("advice is empty for a well-named event", () => {
    assert.deepEqual(eventNameAdvice("signup_completed"), []);
  });

  test("advice flags interaction-style names", () => {
    const notes = eventNameAdvice("clicked_button");
    assert.ok(notes.some((n) => /outcome names/.test(n)));
  });
});
