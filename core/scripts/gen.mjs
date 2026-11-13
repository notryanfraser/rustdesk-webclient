// Regenerates src/gen/ from the vendored upstream protos (rustdesk 1.5.3).
// Usage: npm run gen
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PROTO_VERSION = "1.5.3";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "src/gen");

execFileSync(
  "npx",
  [
    "--no-install",
    "buf",
    "generate",
    `protos/${PROTO_VERSION}`,
    "--template",
    "buf.gen.yaml",
  ],
  { cwd: root, stdio: "inherit" },
);

const header =
  `// GENERATED FILE. DO NOT EDIT. Regenerate with \`npm run gen\` in core/.\n` +
  `// Source: core/protos/${PROTO_VERSION}/ (rustdesk/rustdesk tag ${PROTO_VERSION}), via protoc-gen-es.\n\n`;

for (const f of readdirSync(out)) {
  if (!f.endsWith(".ts")) continue;
  const p = join(out, f);
  writeFileSync(p, header + readFileSync(p, "utf8"));
}
