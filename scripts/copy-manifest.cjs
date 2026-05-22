const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const publicIconsDir = path.resolve(rootDir, "public", "icons");
const logoDir = path.resolve(rootDir, "logo");

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
  if (manifest.side_panel?.default_path) {
    manifest.side_panel.default_path = manifest.side_panel.default_path.replace(/^dist\//, "");
  }
  manifest.background.service_worker = "background.js";
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

const distLogoDir = path.resolve(distDir, "logo");
if (fs.existsSync(logoDir)) {
  fs.mkdirSync(distLogoDir, { recursive: true });
  fs.readdirSync(logoDir)
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .forEach((file) => {
      fs.copyFileSync(path.join(logoDir, file), path.join(distLogoDir, file));
      console.log(`Copied logo: ${file}`);
    });
}

console.log("✓ Build post-processing complete");
