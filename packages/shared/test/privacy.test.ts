import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findSensitiveKeys, scrubProperties, deviceCategory } from "../src/privacy.ts";

describe("findSensitiveKeys", () => {
  test("flags credential-shaped keys", () => {
    for (const key of [
      "password", "Password", "user_password", "passwd", "pwd", "api_key", "apiKey",
      "authToken", "session_id", "cookie", "credit_card", "card_number", "cvv",
      "ssn", "aadhaar", "passport_no", "private_key", "seed_phrase", "otp",
      "bank_account", "routing_number", "diagnosis", "latitude", "date_of_birth",
    ]) {
      const found = findSensitiveKeys({ [key]: "x" });
      assert.equal(found.length, 1, `expected ${key} to be flagged`);
      assert.equal(found[0]!.reason, "denied_key");
    }
  });

  test("flags credential-shaped values under innocent keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop";
    assert.equal(findSensitiveKeys({ note: jwt })[0]?.reason, "denied_value");
    assert.equal(findSensitiveKeys({ ref: "sk_live_abcdefghijklmnop" })[0]?.reason, "denied_value");
    assert.equal(findSensitiveKeys({ ref: "ghp_abcdefghijklmnopqrstuvwxyz0123" })[0]?.reason, "denied_value");
    assert.equal(findSensitiveKeys({ value: "4111 1111 1111 1111" })[0]?.reason, "denied_value");
  });

  test("leaves legitimate product properties alone", () => {
    const clean = {
      plan: "growth", feature: "first_project", step: 3, completed: true,
      product_version: "2.4.1", device_category: "mobile", country: "IN",
      acquisition_source: "docs", release_id: "rel_123",
    };
    assert.deepEqual(findSensitiveKeys(clean), []);
  });
});

describe("scrubProperties", () => {
  test("removes only the offending keys and reports them", () => {
    const { clean, dropped } = scrubProperties({ plan: "free", password: "hunter2", step: 2 });
    assert.deepEqual(clean, { plan: "free", step: 2 });
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.key, "password");
  });

  test("returns the input untouched when nothing is sensitive", () => {
    const input = { plan: "free" };
    const { clean, dropped } = scrubProperties(input);
    assert.equal(clean, input);
    assert.deepEqual(dropped, []);
  });
});

describe("deviceCategory", () => {
  test("coarsens user agents without storing them", () => {
    assert.equal(deviceCategory("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Mobile/15E148"), "mobile");
    assert.equal(deviceCategory("Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit"), "tablet");
    assert.equal(deviceCategory("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120"), "desktop");
    assert.equal(deviceCategory(null), "unknown");
    assert.equal(deviceCategory("curl/8.4.0"), "unknown");
  });
});
