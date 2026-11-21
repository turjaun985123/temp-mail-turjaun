// fixtures.mjs — shared parser-parity corpus for Temp Mail v2.
//
// SHARED CORPUS: these exact cases are the contract for BOTH parsers:
//   * JS:  src/worker-v2.js  parseRaw() / extractOTP()
//          (run via tests/parser-parity.mjs)
//   * Rust: rust/mail-parser (parse_email_impl() / extract_otp_impl())
//          — the Rust crate must also pass every fixture here; when a
//          fixture is added/changed, mirror it in the Rust tests in
//          rust/mail-parser/src/lib.rs with the same expectations.
// A parser change that breaks a fixture breaks parity, whichever side
// of the JS/Rust boundary it lands on.
//
// Shape: { name, raw, expect: { subject, fromContains, textContains, otp } }
//   raw          — a complete .eml message (headers + body), CRLF lines.
//   subject      — exact expected parseRaw(raw).subject
//   fromContains — substring expected in parseRaw(raw).from
//   textContains — substring expected in parseRaw(raw).text
//   otp          — expected extractOTP(text + " " + subject), the same
//                  order enrichMail() uses in worker-v2.js, or null.
//
// Deliberate parity choices (so JS and Rust agree byte-for-byte here):
//   * The quoted-printable fixture is ASCII-only. The JS decodeQP()
//     maps =XX to a single Latin-1 char while Rust decodes UTF-8 bytes,
//     so a non-ASCII QP fixture (e.g. café) would legitimately differ.
//   * No fixture puts digits in a subject after a code keyword: OTP is
//     extracted from text-then-subject, so a trailing subject keyword
//     can never steal a body number on either implementation.
//   * The multipart boundary is lowercase ("abc123"). The JS parser
//     lowercases the whole Content-Type value before extracting the
//     boundary, so an uppercase boundary (e.g. Rust's "XYZ" test) is
//     never found in the body by JS, while Rust preserves boundary
//     case and splits correctly. Lowercase keeps the corpus in the
//     intersection both parsers handle identically; the uppercase-
//     boundary divergence is a known JS bug, not a corpus case.

const eml = (...lines) => lines.join("\r\n");

export const FIXTURES = [
  {
    name: "plain text with OTP near keyword",
    raw: eml(
      "From: Acme Accounts <no-reply@acme.example>",
      "To: test123@turjaun.xyz",
      "Subject: Your Acme sign-in code",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Order 1234 shipped yesterday.",
      "Your verification code is 482910. Do not share it.",
      "",
    ),
    expect: {
      subject: "Your Acme sign-in code",
      fromContains: "no-reply@acme.example",
      // The earlier unrelated 1234 must not win over the keyword code.
      textContains: "Your verification code is 482910",
      otp: "482910",
    },
  },
  {
    name: "base64 body",
    // Body is base64 for:
    // "Your verification code is 582914. It expires in 10 minutes."
    raw: eml(
      "From: Base64 Sender <b64@example.com>",
      "To: test123@turjaun.xyz",
      "Subject: Your code inside",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "WW91ciB2ZXJpZmljYXRpb24gY29kZSBpcyA1ODI5MTQuIEl0IGV4cGlyZXMgaW4gMTAgbWludXRlcy4=",
      "",
    ),
    expect: {
      subject: "Your code inside",
      fromContains: "b64@example.com",
      textContains: "Your verification code is 582914",
      otp: "582914",
    },
  },
  {
    name: "quoted-printable body",
    // =20 is a space, =2C is a comma, and "meet=" + CRLF is a soft
    // line break, so the decoded text reads "... and the meeting ...".
    raw: eml(
      "From: QP Sender <qp@example.com>",
      "To: test123@turjaun.xyz",
      "Subject: Meeting and code",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello=20there=2C your code is 246810 and the meet=",
      "ing moved to the big table.",
      "",
    ),
    expect: {
      subject: "Meeting and code",
      fromContains: "qp@example.com",
      textContains: "Hello there, your code is 246810 and the meeting moved",
      otp: "246810",
    },
  },
  {
    name: "multipart text+html",
    raw: eml(
      "From: Multi Sender <multi@example.com>",
      "To: test123@turjaun.xyz",
      "Subject: Multi part mail",
      'Content-Type: multipart/alternative; boundary="abc123"',
      "",
      "--abc123",
      "Content-Type: text/plain",
      "",
      "plain body with passcode 864201 inside",
      "--abc123",
      "Content-Type: text/html",
      "",
      "<p>html body with passcode 864201 inside</p>",
      "--abc123--",
      "",
    ),
    expect: {
      subject: "Multi part mail",
      fromContains: "multi@example.com",
      textContains: "plain body with passcode 864201 inside",
      otp: "864201",
    },
  },
  {
    name: "HTML-only with verification link",
    // The link itself is asserted via the html field / extractLinks in
    // other suites; here text is the tag-stripped derivation and there
    // is deliberately no digit run anywhere, so otp must be null.
    // Link: https://example.com/verify?token=abcdefXYZ
    raw: eml(
      "From: Verify Sender <verify@example.com>",
      "To: test123@turjaun.xyz",
      "Subject: Verify your email address",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><p>Please confirm your account to continue.</p>' +
        '<p><a href="https://example.com/verify?token=abcdefXYZ">Verify your account</a></p></body></html>',
      "",
    ),
    expect: {
      subject: "Verify your email address",
      fromContains: "verify@example.com",
      textContains: "Verify your account",
      otp: null,
    },
  },
  {
    name: "long digit run is not the OTP when a keyword code exists",
    // 1234567890123456 is a 16-digit tracking number: too long to be an
    // OTP on either implementation (JS \b\d{4,8}\b cannot match inside
    // it, Rust rejects >8-digit runs whole). The keyword code must win.
    raw: eml(
      "From: Parcel Tracker <tracking@example.net>",
      "To: test123@turjaun.xyz",
      "Subject: Your parcel and login code",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Tracking number 1234567890123456 is on its way.",
      "Your security code is 731945. Enter it to continue.",
      "",
    ),
    expect: {
      subject: "Your parcel and login code",
      fromContains: "tracking@example.net",
      textContains: "Tracking number 1234567890123456",
      otp: "731945",
    },
  },
];
