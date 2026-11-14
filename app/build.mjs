// Builds the app into dist/ (esbuild, no other bundler).
// node build.mjs production build
// node build.mjs --serve dev server on http://localhost:8000 (rebuilds on change); writes
// dist/config.js from RUSTDESK_ID_SERVER / RUSTDESK_KEY
// Outputs: app.js (the UI + core), video-worker.js (core/src/video/worker.ts, its own bundle as
// the core requires), audio-worklet.js (the audio worklet's source), index.html, styles.css, the PWA files (manifest, icons, sw.js). The
// deployed image writes config.js at start-up.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const serve = process.argv.includes("--serve");
mkdirSync(out, { recursive: true });

const copyStatic = {
  name: "copy-static",
  setup(b) {
    b.onEnd(() => {
      mkdirSync(join(out, "icons"), { recursive: true });
      for (const f of STATIC) copyFileSync(join(here, "src", f), join(out, f));
      writeServiceWorker();
    });
  },
};

const STATIC = [
  "index.html",
  "styles.css",
  "favicon.svg",
  "favicon.ico",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// The offline shell, precached by sw.js; its version is a hash of these files, so every deploy
// that changes the app replaces the cache.
function writeServiceWorker() {
  const shell = [
    "./",
    ...STATIC.filter((f) => f !== "index.html"),
    "app.js",
    "video-worker.js",
    "audio-worklet.js",
  ];
  const h = createHash("sha256");
  for (const f of shell)
    h.update(readFileSync(join(out, f === "./" ? "index.html" : f)));
  const sw = readFileSync(join(here, "src/sw.js"), "utf8")
    .replace('"__VERSION__"', JSON.stringify(h.digest("hex").slice(0, 16)))
    // config.js is the container's (server settings): precached too, or an offline start that
    // never fetched it through the worker has no config and renders nothing (seen in Chromium),
    // but not hashed, as it is not part of the build.
    .replace("__SHELL__", JSON.stringify([...shell, "config.js"]));
  writeFileSync(join(out, "sw.js"), sw);
}

// The audio worklet as a file of its own (AudioPlayerOptions.workletUrl), so the page's CSP needs
// no blob: scripts. Its source is a string in the core (core/src/audio/worklet.ts).
async function writeAudioWorklet() {
  const r = await esbuild.build({
    stdin: {
      contents: 'export { WORKLET_SOURCE } from "./worklet.ts";',
      resolveDir: join(here, "../core/src/audio"),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`
  );
  writeFileSync(join(out, "audio-worklet.js"), mod.WORKLET_SOURCE);
}
await writeAudioWorklet();

const options = {
  entryPoints: {
    app: join(here, "src/main.tsx"),
    "video-worker": join(here, "../core/src/video/worker.ts"),
  },
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  alias: { "@rustdesk-web/core": join(here, "../core/src/index.ts") },
  minify: !serve,
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
  plugins: [copyStatic],
};

if (serve) {
  writeFileSync(
    join(out, "config.js"),
    `window.RUSTDESK_WEB_CONFIG = ${JSON.stringify({
      idServer: process.env.RUSTDESK_ID_SERVER ?? "",
      key: process.env.RUSTDESK_KEY ?? "",
      wss: true, // the dev server is plain http; real servers are behind TLS
    })};\n`,
  );
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, port: 8000 });
  console.log(`dev server: http://localhost:${port}/`);
} else {
  await esbuild.build(options);
}
