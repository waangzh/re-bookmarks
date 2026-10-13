import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");

// Bundle the actual TypeScript services without a new test dependency or build output.
export async function loadService(path, instance = "") {
  const result = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + "\n// instance: " + instance).toString("base64")}`);
}
