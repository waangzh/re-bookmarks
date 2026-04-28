const fs = require("fs");
const path = require("path");

// 简单的蓝色方块 PNG 图标 (base64)
const createPng = (size) => {
  // 这是一个最简单的有效 PNG 文件结构
  // 实际使用时应该用真实图标
  const { createCanvas } = require("canvas");
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // 蓝色背景
  ctx.fillStyle = "#3b82f6";
  ctx.fillRect(0, 0, size, size);

  // 白色书签图标
  ctx.fillStyle = "#ffffff";
  const padding = size * 0.25;
  ctx.fillRect(padding, padding, size - padding * 2, size - padding * 2);

  return canvas.toBuffer("image/png");
};

// 如果没有 canvas 包，创建占位 PNG
const createPlaceholderPng = (size) => {
  // 最小的有效 PNG 文件 (1x1 像素)
  // 实际项目需要替换为真实图标
  return Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, size > 127 ? 0x80 : size, 0x00, 0x00, 0x00, size > 127 ? 0x80 : size,
    0x08, 0x02, 0x00, 0x00, 0x00,
    // 简化的 PNG 数据
  ]);
};

const iconsDir = path.resolve(__dirname, "../dist/icons");

const sizes = [16, 32, 48, 128];

sizes.forEach((size) => {
  const filename = `icon${size}.png`;
  const filepath = path.join(iconsDir, filename);

  // 创建一个简单的占位文件
  // 实际项目需要用设计好的图标
  const placeholder = Buffer.alloc(100);
  fs.writeFileSync(filepath, placeholder);
  console.log(`Created placeholder: ${filename}`);
});

console.log("✓ Icon placeholders created");
console.log("Note: Replace with actual PNG icons before publishing");
