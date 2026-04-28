const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");

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
const iconsDir = path.resolve(distDir, "icons");
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// 创建占位 PNG 图标（如不存在）
const minPng = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xD7, 0x63, 0x38, 0x68, 0xF8, 0x0F,
  0x00, 0x01, 0x04, 0x01, 0x80, 0x36, 0x1B, 0xB4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82
]);

[16, 32, 48, 128].forEach((size) => {
  const iconPath = path.join(iconsDir, `icon${size}.png`);
  if (!fs.existsSync(iconPath)) {
    fs.writeFileSync(iconPath, minPng);
    console.log(`✓ Created placeholder: icon${size}.png`);
  }
});

console.log("✓ Build post-processing complete");
console.log("Note: Replace placeholder icons with actual icons before publishing");
