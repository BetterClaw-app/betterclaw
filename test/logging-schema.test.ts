import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";
import { MANIFEST } from "../src/redactor.js";

const SOURCE_RE = /^plugin\.[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;
const EVENT_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;
const VALID_STRATEGIES = new Set(["hmacHost", "hmacUrlHost", "hmacId", "allowPlain", "drop"]);

// Direct-surface call: X.LEVEL("source", "event", ...) with any X identifier.
const DIRECT_CALL_RE = /\.(debug|info|notice|warning|warn|error|critical)\s*\(\s*"(plugin\.[^"]+)"\s*,\s*"([^"]+)"/g;

// Scoped-source call: .scoped("plugin.X")
const SCOPED_CALL_RE = /\.scoped\s*\(\s*"(plugin\.[^"]+)"/g;

// Console ban sentinel
const ALLOW_CONSOLE_RE = /\/\/\s*schema-lint:\s*allow-console/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("schema lint — static MANIFEST checks", () => {
  it("every source name matches the regex", () => {
    for (const source of Object.keys(MANIFEST.sources)) {
      expect(source, source).toMatch(SOURCE_RE);
    }
  });

  it("every event name matches the regex", () => {
    for (const [source, def] of Object.entries(MANIFEST.sources)) {
      for (const event of Object.keys(def.events)) {
        expect(event, `${source}::${event}`).toMatch(EVENT_RE);
      }
    }
  });

  it("every key strategy is valid", () => {
    for (const [k, s] of Object.entries(MANIFEST.keyStrategies)) {
      expect(VALID_STRATEGIES.has(s), `${k} → ${s}`).toBe(true);
    }
  });

  it("manifestVersion is a positive integer", () => {
    expect(Number.isInteger(MANIFEST.manifestVersion)).toBe(true);
    expect(MANIFEST.manifestVersion).toBeGreaterThan(0);
  });
});

describe("schema lint — call-site scan", () => {
  const srcFiles = walk(join(process.cwd(), "src"));
  const declaredPairs = new Set<string>();
  for (const [source, def] of Object.entries(MANIFEST.sources)) {
    for (const event of Object.keys(def.events)) declaredPairs.add(`${source}::${event}`);
  }
  const scopedSources = new Set(
    Object.entries(MANIFEST.sources)
      .filter(([, def]) => def.events.info && def.events.warn && def.events.error)
      .map(([s]) => s)
  );

  it("every direct dlog call's (source, event) pair is declared in MANIFEST", () => {
    const undeclared: string[] = [];
    for (const file of srcFiles) {
      if (file.endsWith("redactor.ts") || file.endsWith("diagnostic-logger.ts")) continue;
      const content = readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      DIRECT_CALL_RE.lastIndex = 0;
      while ((m = DIRECT_CALL_RE.exec(content)) !== null) {
        const pair = `${m[2]}::${m[3]}`;
        if (!declaredPairs.has(pair)) {
          undeclared.push(`${relative(process.cwd(), file)} — ${pair}`);
        }
      }
    }
    expect(undeclared, `Undeclared direct call sites:\n${undeclared.join("\n")}`).toEqual([]);
  });

  it("every .scoped(\"plugin.X\") source has info/warn/error events declared", () => {
    const missing: string[] = [];
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      SCOPED_CALL_RE.lastIndex = 0;
      while ((m = SCOPED_CALL_RE.exec(content)) !== null) {
        if (!scopedSources.has(m[1])) {
          missing.push(`${relative(process.cwd(), file)} — scoped source ${m[1]} missing info/warn/error`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });
});

describe("schema lint — message must be a literal", () => {
  // Matches the opening of a `dlog.LEVEL(` or `diagnosticLogger.LEVEL(` call
  // where the first two args are string literals. Captures the first
  // non-whitespace character of the third argument (the `message`).
  // If that character is `"` the message is a plain literal (OK). Anything
  // else — backtick (template), identifier, open paren (function call),
  // concatenation on a naked identifier — fails the lint. This is the
  // key-based redactor's safety property: `message` is never redacted,
  // so it MUST be static.
  const MESSAGE_ARG_RE =
    /\b(?:dlog|diagnosticLogger)\.(debug|info|notice|warning|warn|error|critical)\s*\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*(\S)/g;

  it("every direct dlog / diagnosticLogger call's message arg is a string literal", () => {
    const srcFiles = walk(join(process.cwd(), "src"));
    const violations: string[] = [];
    for (const file of srcFiles) {
      if (file.endsWith("diagnostic-logger.ts")) continue;
      const content = readFileSync(file, "utf-8");
      const rel = relative(process.cwd(), file);
      let m: RegExpExecArray | null;
      MESSAGE_ARG_RE.lastIndex = 0;
      while ((m = MESSAGE_ARG_RE.exec(content)) !== null) {
        const firstChar = m[2];
        if (firstChar !== '"') {
          // Compute 1-based line number of the match.
          const line = content.slice(0, m.index).split("\n").length;
          violations.push(`${rel}:${line} — message arg starts with \`${firstChar}\` (expected string literal)`);
        }
      }
    }
    expect(
      violations,
      `Non-literal message args (must be a plain "..." string):\n${violations.join("\n")}`
    ).toEqual([]);
  });
});

describe("schema lint — console.* carve-out", () => {
  it("bans console.(log|warn|error|info|debug) outside annotated lines", () => {
    const srcFiles = walk(join(process.cwd(), "src"));
    const violations: string[] = [];
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      const rel = relative(process.cwd(), file);
      content.split("\n").forEach((line, idx) => {
        if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line) && !ALLOW_CONSOLE_RE.test(line)) {
          violations.push(`${rel}:${idx + 1} ${line.trim()}`);
        }
      });
    }
    expect(violations, `Unannotated console.* calls:\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("schema lint — doc regeneration", () => {
  it("regenerates identically from MANIFEST", () => {
    const docPath = join(process.cwd(), "docs/logging-schema.md");
    const committed = readFileSync(docPath, "utf-8");
    // Invoke the generator directly via tsx — bypasses pnpm arg-forwarding quirks.
    const regenerated = execSync("npx tsx scripts/generate-schema-doc.ts --stdout", { encoding: "utf-8" });
    expect(regenerated).toBe(committed);
  });
});
