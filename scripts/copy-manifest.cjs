const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const publicIconsDir = path.resolve(rootDir, "public", "icons");

// 复制 manifest.json
const manifestSrc = path.resolve(rootDir, "manifest.json");
const manifestDest = path.resolve(distDir, "manifest.json");

if (fs.existsSync(manifestSrc)) {
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, "utf-8"));

  // 调整 manifest 中的路径
  if (manifest.action.default_popup) {
    manifest.action.default_popup = "popup/index.html";
  }
  manifest.options_page = "options/index.html";
  manifest.background.service_worker = "background.js";
  if (manifest.content_scripts) {
    manifest.content_scripts = manifest.content_scripts.map((script) => ({
      ...script,
      js: script.js.map((file) => file.replace(/^dist\//, "")),
    }));
  }
  if (manifest.web_accessible_resources) {
    manifest.web_accessible_resources = manifest.web_accessible_resources.map((resource) => ({
      ...resource,
      resources: resource.resources.map((file) => file.replace(/^dist\//, "")),
    }));
  }
  manifest.action.default_icon = {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  };
  manifest.icons = {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  };

  fs.writeFileSync(manifestDest, JSON.stringify(manifest, null, 2));
  console.log("✓ manifest.json copied and updated");
}

// 确保 icons 目录存在
const distIconsDir = path.resolve(distDir, "icons");
if (!fs.existsSync(distIconsDir)) {
  fs.mkdirSync(distIconsDir, { recursive: true });
}

// 从 public/icons 复制图标到 dist/icons
[16, 32, 48, 128].forEach((size) => {
  const srcPath = path.join(publicIconsDir, `icon${size}.png`);
  const destPath = path.join(distIconsDir, `icon${size}.png`);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`✓ Copied: icon${size}.png`);
  } else {
    console.warn(`⚠ Missing: icon${size}.png (run 'node scripts/generate-icons.mjs' to generate)`);
  }
});

console.log("✓ Build post-processing complete");
