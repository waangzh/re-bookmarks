import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const directory = process.argv[2];
if (!directory) throw new Error("请指定隔离测试证据目录");
await mkdir(directory, { recursive: true });
await build({ entryPoints: ["tests/extension-concurrency-probe.ts"], bundle: true, platform: "browser", format: "esm",
  outfile: directory + "/concurrency-probe.js" });
await writeFile(directory + "/concurrency-loader.js", 'import * as probe from "./concurrency-probe.js";window.probe=probe;');
await writeFile(directory + "/concurrency-probe.html", '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隔离并发测试</title><body>测试页面<script type="module" src="./concurrency-loader.js"></script></body></html>');
