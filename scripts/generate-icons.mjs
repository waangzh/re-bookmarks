import sharp from "sharp";
import { readdir, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";

const SIZES = [16, 32, 48, 128];

async function findLogoFile(logoDir) {
  const files = await readdir(logoDir);
  const pngFile = files.find((f) => f.endsWith(".png"));
  if (!pngFile) throw new Error("未找到 PNG 格式的 logo 文件");
  return join(logoDir, pngFile);
}

async function main() {
  const rootDir = resolve(import.meta.dirname, "..");
  const logoDir = join(rootDir, "logo");
  const publicIconsDir = join(rootDir, "public", "icons");

  const logoFile = await findLogoFile(logoDir);
  console.log(`找到 logo 文件: ${logoFile}`);

  if (!existsSync(publicIconsDir)) {
    await mkdir(publicIconsDir, { recursive: true });
  }

  for (const size of SIZES) {
    const outputPath = join(publicIconsDir, `icon${size}.png`);
    await sharp(logoFile)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath);
    console.log(`✓ 生成 icon${size}.png`);
  }

  console.log("图标生成完成！");
}

main().catch(console.error);
