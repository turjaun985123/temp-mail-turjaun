// parser-parity.mjs — JS side of the shared parser-parity corpus.
//
// Run:  node --test tests/parser-parity.mjs
//
// This script runs every fixture in tests/fixtures.mjs through the JS
// parser in src/worker-v2.js (parseRaw / extractOTP) and asserts the
// subject, sender, body text and OTP.
//
// SHARED CORPUS: fixtures.mjs is not a JS-only test file. The Rust
// crate in rust/mail-parser (parse_email_impl / extract_otp_impl) must
// also pass the SAME fixtures with the SAME expectations — that is
// what makes this a parity corpus rather than two divergent test
// suites. When a fixture changes, update the mirrored Rust tests in
// rust/mail-parser/src/lib.rs in the same change, and vice versa.
//
// OTP is extracted exactly the way the Worker does it in enrichMail()
// (worker-v2.js): extractOTP(text_body + " " + subject).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRaw, extractOTP } from "../src/worker-final.js";
import { FIXTURES } from "./fixtures.mjs";

test("corpus has at least 6 fixtures", () => {
  assert.ok(Array.isArray(FIXTURES), "FIXTURES must be an array");
  assert.ok(FIXTURES.length >= 6, `expected >= 6 fixtures, got ${FIXTURES.length}`);
});

for (const fixture of FIXTURES) {
  test(`parseRaw/extractOTP: ${fixture.name}`, () => {
    const parsed = parseRaw(fixture.raw);

    assert.equal(parsed.subject, fixture.expect.subject, "subject mismatch");
    assert.ok(
      parsed.from.includes(fixture.expect.fromContains),
      `from ${JSON.stringify(parsed.from)} should contain ${JSON.stringify(fixture.expect.fromContains)}`,
    );
    assert.ok(
      parsed.text.includes(fixture.expect.textContains),
      `text ${JSON.stringify(parsed.text)} should contain ${JSON.stringify(fixture.expect.textContains)}`,
    );

    // Same extraction input/order as enrichMail() in worker-v2.js.
    const otp = extractOTP(`${parsed.text} ${parsed.subject}`);
    assert.equal(otp, fixture.expect.otp, "otp mismatch");
  });
}

// The multipart fixture additionally pins the html half of the output:
// both parsers must keep text/plain and text/html in separate fields.
test("multipart fixture keeps html separate from text", () => {
  const fixture = FIXTURES.find((f) => f.name === "multipart text+html");
  assert.ok(fixture, "multipart fixture missing");
  const parsed = parseRaw(fixture.raw);
  assert.ok(
    parsed.html.includes("html body with passcode 864201 inside"),
    `html ${JSON.stringify(parsed.html)} should contain the html part`,
  );
  assert.ok(
    !parsed.text.includes("<p>"),
    `text ${JSON.stringify(parsed.text)} should not contain html tags`,
  );
});

// The HTML-only fixture additionally pins that a verification link
// survives in the html field (where extractLinks reads it), even
// though the derived text carries no OTP.
test("HTML-only fixture keeps verification link in html", () => {
  const fixture = FIXTURES.find((f) => f.name === "HTML-only with verification link");
  assert.ok(fixture, "HTML-only fixture missing");
  const parsed = parseRaw(fixture.raw);
  assert.ok(
    parsed.html.includes("https://example.com/verify?token=abcdefXYZ"),
    `html ${JSON.stringify(parsed.html)} should contain the verification link`,
  );
});
