const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const target = process.argv[2] ?? "chromium";
const buildTargets = {
  chromium: {
    manifestPath: path.resolve(rootDir, "manifest.json"),
    distDir: path.resolve(rootDir, "dist"),
  },
  firefox: {
    manifestPath: path.resolve(rootDir, "manifests", "firefox.json"),
    distDir: path.resolve(rootDir, "dist-firefox"),
  },
};
const buildTarget = buildTargets[target];

if (!buildTarget) {
  throw new Error("未知构建目标：" + target);
}

const publicIconsDir = path.resolve(rootDir, "public", "icons");
const logoDir = path.resolve(rootDir, "logo");

function outputPath(value) {
  return value.replace(/^(?:dist|dist-firefox)\//, "");
}

function outputIconPaths() {
  return {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  };
}

if (fs.existsSync(buildTarget.manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(buildTarget.manifestPath, "utf-8"));

  if (manifest.action?.default_popup) {
    manifest.action.default_popup = outputPath(manifest.action.default_popup);
  }
  if (manifest.options_page) {
    manifest.options_page = outputPath(manifest.options_page);
  }
  if (manifest.options_ui?.page) {
    manifest.options_ui.page = outputPath(manifest.options_ui.page);
  }
  if (manifest.side_panel?.default_path) {
    manifest.side_panel.default_path = outputPath(manifest.side_panel.default_path);
  }
  if (manifest.sidebar_action?.default_panel) {
    manifest.sidebar_action.default_panel = outputPath(manifest.sidebar_action.default_panel);
  }
  if (manifest.background?.service_worker) {
    manifest.background.service_worker = outputPath(manifest.background.service_worker);
  }
  if (manifest.background?.scripts) {
    manifest.background.scripts = manifest.background.scripts.map(outputPath);
  }
  if (manifest.action) {
    manifest.action.default_icon = outputIconPaths();
  }
  if (manifest.sidebar_action) {
    manifest.sidebar_action.default_icon = outputIconPaths();
  }
  manifest.icons = outputIconPaths();

  fs.writeFileSync(
    path.resolve(buildTarget.distDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log("✓ " + target + " manifest.json copied and updated");
}

const distIconsDir = path.resolve(buildTarget.distDir, "icons");
fs.mkdirSync(distIconsDir, { recursive: true });

[16, 32, 48, 128].forEach((size) => {
  const srcPath = path.join(publicIconsDir, "icon" + size + ".png");
  const destPath = path.join(distIconsDir, "icon" + size + ".png");
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log("✓ Copied: icon" + size + ".png");
  } else {
    console.warn("⚠ Missing: icon" + size + ".png (run 'node scripts/generate-icons.mjs' to generate)");
  }
});

const distLogoDir = path.resolve(buildTarget.distDir, "logo");
if (fs.existsSync(logoDir)) {
  fs.mkdirSync(distLogoDir, { recursive: true });
  fs.readdirSync(logoDir)
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .forEach((file) => {
      fs.copyFileSync(path.join(logoDir, file), path.join(distLogoDir, file));
      console.log("Copied logo: " + file);
    });
}

console.log("✓ " + target + " build post-processing complete");
