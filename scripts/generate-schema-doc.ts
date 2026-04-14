#!/usr/bin/env tsx
/**
 * Generate docs/logging-schema.md from src/redactor.ts MANIFEST.
 *
 * Usage:
 *   tsx scripts/generate-schema-doc.ts           # writes the file
 *   tsx scripts/generate-schema-doc.ts --stdout  # writes to stdout
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST } from "../src/redactor.js";

function render(): string {
  const lines: string[] = [];
  lines.push(`# BetterClaw Plugin Logging Schema`);
  lines.push(``);
  lines.push(`> **Generated from \`src/redactor.ts\` MANIFEST. Do not edit by hand.** Run \`pnpm schema:gen\` to regenerate.`);
  lines.push(``);
  lines.push(`**Manifest version:** ${MANIFEST.manifestVersion}`);
  lines.push(``);
  lines.push(`## Conventions`);
  lines.push(``);
  lines.push(`- Source name: \`^plugin\\.[a-z][a-z0-9]*(\\.[a-z0-9]+)*$\``);
  lines.push(`- Event name: \`^[a-z][a-z0-9]*(\\.[a-z0-9]+)*$\``);
  lines.push(`- Data keys: camelCase; JSON-legal scalars only. The \`error.*\` dotted keys are a named carve-out emitted by \`errorFields()\`.`);
  lines.push(`- Levels: \`debug / info / notice / warning / error / critical\`. Plugin emits 4 today; \`notice\` and \`critical\` are reserved slots.`);
  lines.push(`- Timestamps: Unix seconds as float (matches iOS \`TimeInterval\`).`);
  lines.push(``);
  lines.push(`## Sources`);
  lines.push(``);

  const sources = Object.entries(MANIFEST.sources).sort(([a], [b]) => a.localeCompare(b));
  for (const [source, def] of sources) {
    const flmNote = def.fieldLevelMapping ? " — **field-level category mapping enabled**" : "";
    lines.push(`### \`${source}\` — export category \`${def.exportCategory}\`${flmNote}`);
    lines.push(``);
    lines.push(`| event | level | required data |`);
    lines.push(`|---|---|---|`);
    const events = Object.entries(def.events).sort(([a], [b]) => a.localeCompare(b));
    for (const [event, meta] of events) {
      const keys = meta.requiredKeys.length
        ? meta.requiredKeys.map((k: string) => `\`${k}\``).join(", ")
        : "—";
      lines.push(`| \`${event}\` | \`${meta.level}\` | ${keys} |`);
    }
    lines.push(``);
  }

  lines.push(`## Redaction manifest`);
  lines.push(``);
  lines.push(`| key | strategy |`);
  lines.push(`|---|---|`);
  const keys = Object.entries(MANIFEST.keyStrategies).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, s] of keys) {
    lines.push(`| \`${k}\` | \`${s}\` |`);
  }
  lines.push(``);
  lines.push(`## Field-level category implications`);
  lines.push(``);
  lines.push(`| key | implies category |`);
  lines.push(`|---|---|`);
  const impls = Object.entries(MANIFEST.fieldCategoryImplications).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, c] of impls) {
    lines.push(`| \`${k}\` | \`${c}\` |`);
  }
  lines.push(``);

  return lines.join("\n");
}

const content = render();
if (process.argv.includes("--stdout")) {
  process.stdout.write(content);
} else {
  writeFileSync(join(process.cwd(), "docs/logging-schema.md"), content);
  console.log(`wrote docs/logging-schema.md (${content.length} bytes)`);
}
