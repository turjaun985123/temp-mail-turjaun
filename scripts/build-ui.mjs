#!/usr/bin/env node
// =============================================================================
// build-ui.mjs — Temp Mail v2 UI inliner (zero-dependency, Node >= 18)
// =============================================================================
//
// PROBLEM
//   src/worker-v2.js exports a placeholder UI as a single string constant,
//   `export const UI_HTML = ...;`, while the real UI lives in three separate
//   files: ui/index.html, ui/styles.css and ui/app.js. A Cloudflare Worker is
//   deployed as ONE self-contained module — it cannot fetch sibling files at
//   request time — so the UI must be inlined into the Worker source at build
//   time.
//
// WHAT THIS SCRIPT DOES
//   1. Reads ui/index.html, ui/styles.css and ui/app.js.
//   2. Builds one final HTML document from index.html:
//        - the external stylesheet tag (<link ... href="styles.css">) is
//          removed and the full contents of styles.css are inlined in a
//          <style> element inserted immediately before </head>;
//        - the external script tag (<script src="app.js" ...></script>) is
//          removed and the full contents of app.js are inlined in a <script>
//          element inserted immediately before </body>.
//   3. Reads src/worker-v2.js, replaces ONLY the right-hand side of the
//      UI_HTML export with that final HTML (see REPLACEMENT STRATEGY below),
//      and writes the result to src/worker-v2.built.js.
//   The source file src/worker-v2.js is NEVER modified.
//
// USAGE
//   node scripts/build-ui.mjs
//   Inputs are always the pristine ui/* files and src/worker-v2.js, and the
//   output is always src/worker-v2.built.js. No arguments, no config, no
//   network, no dependencies (node:fs / node:path / node:url only).
//
// ESCAPING STRATEGY (why JSON.stringify, not a template literal)
//   The generated HTML/CSS/JS payload may contain backticks (`), `${`
//   sequences, double quotes, backslashes and newlines. Embedding it in a
//   template literal would require escaping every backtick and every `${`,
//   which is fragile: one missed sequence silently becomes a runtime
//   interpolation (or a syntax error). Instead the payload is emitted as
//
//       export const UI_HTML = "<payload as a JSON string>";
//
//   JSON.stringify() produces a valid JavaScript double-quoted string
//   literal: it escapes `"`, `\` and all control characters (including
//   newlines), and backticks / `${` need NO escaping inside a double-quoted
//   string, so they pass through safely as literal characters. Two extra
//   replacements are applied after stringify for older-parser safety:
//   U+2028 / U+2029 are rewritten to their \uXXXX escape forms (they are
//   line terminators in ECMAScript source). A `</script>` sequence inside
//   the payload is harmless here because the output is a .js module served
//   as JavaScript, not an HTML document — it is NOT additionally mangled.
//
//   One related inlining hazard IS handled in the HTML payload itself:
//   app.js is placed inside an HTML <script> element, where the literal
//   text "</script" would terminate the element early. Any such sequence
//   in app.js is rewritten to "<\/script" before inlining (valid and
//   equivalent inside JS string literals and comments, and the current
//   app.js contains none — the count is reported as a warning if it ever
//   appears). styles.css is inlined verbatim; a "</style" sequence in CSS
//   would be reported as a warning, not rewritten (rewriting it would
//   corrupt CSS, and it can only legitimately occur inside a CSS string).
//
// REPLACEMENT STRATEGY (how UI_HTML is located in worker-v2.js)
//   The placeholder is not assumed to have any particular quoting style —
//   in the current source it is a single-line template literal ending in
//   "`;" — so the statement is located by scanning, not by a brittle regex
//   over its contents:
//     a. Find the first occurrence of the exact text `export const UI_HTML`.
//     b. Find the first `=` after it (the assignment).
//     c. Skip whitespace; the next character is the opening delimiter and
//        may be a backtick (`), a single quote (') or a double quote (") —
//        anything else is an error (the RHS is not a plain string literal
//        this script can safely replace).
//     d. Scan forward for the matching closing delimiter, honouring
//        backslash escapes (\` \' \" \\ etc. are skipped as pairs). For a
//        template literal, `${ ... }` interpolations are tracked by brace
//        depth (including nested string literals inside them) so a backtick
//        inside an interpolation cannot be mistaken for the closing one.
//     e. After the closing delimiter, skip whitespace and require a `;` —
//        that semicolon terminates the export statement. (In the current
//        source it directly follows the closing backtick on the same line:
//        "...</html>`;". The scan does not depend on which line it is on,
//        only that it is the first `;` after the closing delimiter and that
//        nothing but whitespace intervenes.)
//     f. Everything before the export statement and everything after that
//        `;` is copied through byte-for-byte; the statement itself is
//        replaced with `export const UI_HTML = <JSON string>;`.
//   If any step fails — marker missing, no `=`, unsupported delimiter,
//   unterminated string, or no terminating `;` — the script prints a clear
//   error naming the step and exits non-zero WITHOUT writing the output
//   file, so the integrator fixes src/worker-v2.js instead of deploying a
//   half-built Worker.
//
// IDEMPOTENCY
//   The build is a pure, deterministic function of the three ui/* files and
//   src/worker-v2.js: no timestamps, no random values, no environment data
//   are embedded, and the input is never the previous output. Running the
//   script twice therefore produces byte-identical src/worker-v2.built.js.
//   It is also safe if the source handed to it already contains an inlined
//   UI: the whole UI_HTML right-hand side is replaced with HTML regenerated
//   from ui/*, never with anything extracted from the old UI_HTML value.
//
// SIZE REPORTING
//   Byte sizes of every input, the generated HTML, and the output are
//   printed. If the built file exceeds 500 KB a warning is printed (the
//   build still succeeds — the warning is a prompt to check for accidental
//   duplication, not a hard limit of this script).
// =============================================================================

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PATHS = {
  html: join(ROOT, "ui", "index.html"),
  css: join(ROOT, "ui", "styles.css"),
  js: join(ROOT, "ui", "app.js"),
  workerSrc: join(ROOT, "src", "worker-v2.js"),
  workerOut: join(ROOT, "src", "worker-v2.built.js"),
};

const SIZE_WARN_BYTES = 500 * 1024; // 500 KB

function fail(message) {
  console.error(`build-ui: error: ${message}`);
  console.error(
    "build-ui: no output written. Fix src/worker-v2.js / ui/* and re-run; " +
      "see the REPLACEMENT STRATEGY comment at the top of scripts/build-ui.mjs."
  );
  process.exit(1);
}

function readInput(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`cannot read ${label} at ${path}: ${err.message}`);
  }
}

function fmtBytes(n) {
  return n >= 1024 ? `${n} B (${(n / 1024).toFixed(1)} KiB)` : `${n} B`;
}

// ---------------------------------------------------------------------------
// Step 1 — build the final, self-contained HTML document.
// ---------------------------------------------------------------------------
function buildHtml(indexHtml, css, js) {
  let html = indexHtml;

  // 1a. Strip the external stylesheet link (any attribute order / quoting,
  //     optional leading "./"). Warn if absent: index.html may already be
  //     inlined, or the tag may have been renamed — either way we still
  //     inject the CSS below, so this is not fatal.
  const linkRe =
    /[ \t]*<link\b[^>]*\bhref\s*=\s*["'](?:\.\/)?styles\.css["'][^>]*>\r?\n?/gi;
  const linkCount = (html.match(linkRe) || []).length;
  html = html.replace(linkRe, "");
  if (linkCount === 0) {
    console.warn(
      'build-ui: warning: no <link ... href="styles.css"> tag found in ui/index.html; ' +
        "CSS will still be inlined before </head>."
    );
  }

  // 1b. Strip the external script tag for app.js (with its closing tag).
  const scriptRe =
    /[ \t]*<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?app\.js["'][^>]*>\s*<\/script>\r?\n?/gi;
  const scriptCount = (html.match(scriptRe) || []).length;
  html = html.replace(scriptRe, "");
  if (scriptCount === 0) {
    console.warn(
      'build-ui: warning: no <script src="app.js"></script> tag found in ui/index.html; ' +
        "JS will still be inlined before </body>."
    );
  }

  // 1c. Guard the JS payload against an early </script> terminator, and
  //     check the CSS payload for a </style> sequence (warning only, see
  //     the header comment for why CSS is not rewritten).
  const scriptTermCount = (js.match(/<\/script/gi) || []).length;
  let jsPayload = js;
  if (scriptTermCount > 0) {
    jsPayload = js.replace(/<\/script/gi, "<\\/script");
    console.warn(
      `build-ui: warning: ui/app.js contains ${scriptTermCount} "</script" sequence(s); ` +
        'rewritten to "<\\/script" in the inlined copy so the HTML parser cannot end the script early.'
    );
  }
  const styleTermCount = (css.match(/<\/style/gi) || []).length;
  if (styleTermCount > 0) {
    console.warn(
      `build-ui: warning: ui/styles.css contains ${styleTermCount} "</style" sequence(s); ` +
        "inlined verbatim — check it only occurs inside a CSS string."
    );
  }

  // 1d. Inline the CSS immediately before </head>.
  if (!/<\/head>/i.test(html)) {
    fail("ui/index.html has no </head> tag; cannot inline ui/styles.css.");
  }
  html = html.replace(
    /<\/head>/i,
    `<style>\n/* --- inlined: ui/styles.css (scripts/build-ui.mjs) --- */\n${css}\n</style>\n</head>`
  );

  // 1e. Inline the JS immediately before </body>. If there is no </body>,
  //     append at the end with a warning rather than dropping the script.
  const scriptBlock =
    `<script>\n/* --- inlined: ui/app.js (scripts/build-ui.mjs) --- */\n${jsPayload}\n</script>\n`;
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${scriptBlock}</body>`);
  } else {
    console.warn(
      "build-ui: warning: ui/index.html has no </body> tag; appending the inlined script at the end."
    );
    html = `${html}\n${scriptBlock}`;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Step 2 — locate and replace the UI_HTML export in the Worker source.
// See the REPLACEMENT STRATEGY comment at the top of this file.
// ---------------------------------------------------------------------------

// Scan a string literal starting at `start` (source[start] is the opening
// delimiter: `, ' or "). Returns the index just past the closing delimiter,
// or -1 if unterminated. Handles \-escapes and, for template literals,
// ${ ... } interpolation nesting (brace depth + nested literals).
function scanStringLiteral(source, start) {
  const delim = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2; // escaped character pair — never a delimiter
      continue;
    }
    if (delim === "`" && ch === "$" && source[i + 1] === "{") {
      // Template interpolation: skip to its matching close brace.
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        else if (c === "`" || c === "'" || c === '"') {
          const end = scanStringLiteral(source, i);
          if (end === -1) return -1;
          i = end;
          continue;
        }
        i += 1;
      }
      if (depth !== 0) return -1;
      continue;
    }
    if (ch === delim) return i + 1;
    if (delim !== "`" && (ch === "\n" || ch === "\r")) return -1; // unterminated '- or "-string
    i += 1;
  }
  return -1;
}

function replaceUiHtml(workerSource, finalHtml) {
  const MARKER = "export const UI_HTML";
  const markerIdx = workerSource.indexOf(MARKER);
  if (markerIdx === -1) {
    fail(
      `\`${MARKER}\` not found in src/worker-v2.js — the integrator must restore ` +
        "the UI_HTML export in the Worker source before this build can run."
    );
  }

  const eqIdx = workerSource.indexOf("=", markerIdx + MARKER.length);
  if (eqIdx === -1) {
    fail("found `export const UI_HTML` but no `=` after it in src/worker-v2.js.");
  }

  // First non-whitespace character after `=` must be the opening delimiter.
  let openIdx = eqIdx + 1;
  while (openIdx < workerSource.length && /\s/.test(workerSource[openIdx])) openIdx += 1;
  const delim = workerSource[openIdx];
  if (delim !== "`" && delim !== "'" && delim !== '"') {
    fail(
      `UI_HTML right-hand side in src/worker-v2.js does not start with a string ` +
        `delimiter (\`, ' or ") — found ${JSON.stringify(delim ?? "<eof>")}. ` +
        "This build only replaces a plain string-literal UI_HTML; convert the " +
        "export back to a string literal or update scripts/build-ui.mjs."
    );
  }

  const closeEnd = scanStringLiteral(workerSource, openIdx);
  if (closeEnd === -1) {
    fail(
      `unterminated string literal for UI_HTML in src/worker-v2.js ` +
        `(opening ${delim} at offset ${openIdx} has no closing delimiter).`
    );
  }

  // The statement must be terminated by the first `;` after the closing
  // delimiter, with only whitespace in between.
  let semiIdx = closeEnd;
  while (semiIdx < workerSource.length && /\s/.test(workerSource[semiIdx])) semiIdx += 1;
  if (workerSource[semiIdx] !== ";") {
    fail(
      "no terminating `;` found after the UI_HTML string literal in " +
        "src/worker-v2.js — the export statement is not in the expected " +
        "`export const UI_HTML = <string>;` form."
    );
  }

  // JSON.stringify is the escaping strategy: see the header comment.
  const literal =
    JSON.stringify(finalHtml)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");

  return (
    workerSource.slice(0, markerIdx) +
    `${MARKER} = ${literal};` +
    workerSource.slice(semiIdx + 1)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const indexHtml = readInput(PATHS.html, "ui/index.html");
  const css = readInput(PATHS.css, "ui/styles.css");
  const js = readInput(PATHS.js, "ui/app.js");
  const workerSrc = readInput(PATHS.workerSrc, "src/worker-v2.js");

  const finalHtml = buildHtml(indexHtml, css, js);
  const built = replaceUiHtml(workerSrc, finalHtml);

  writeFileSync(PATHS.workerOut, built, "utf8");

  const outBytes = statSync(PATHS.workerOut).size;
  const byteLen = (s) => Buffer.byteLength(s, "utf8");
  console.log("build-ui: inputs");
  console.log(`  ui/index.html      ${fmtBytes(byteLen(indexHtml))}`);
  console.log(`  ui/styles.css      ${fmtBytes(byteLen(css))}`);
  console.log(`  ui/app.js          ${fmtBytes(byteLen(js))}`);
  console.log(`  src/worker-v2.js   ${fmtBytes(byteLen(workerSrc))}`);
  console.log(`build-ui: generated HTML  ${fmtBytes(byteLen(finalHtml))}`);
  console.log(`build-ui: output src/worker-v2.built.js  ${fmtBytes(outBytes)}`);
  if (outBytes > SIZE_WARN_BYTES) {
    console.warn(
      `build-ui: warning: built file is ${fmtBytes(outBytes)}, over the 500 KB ` +
        "warning threshold — check for accidental duplication before deploying."
    );
  }
  console.log("build-ui: done (re-running produces byte-identical output).");
}

main();
