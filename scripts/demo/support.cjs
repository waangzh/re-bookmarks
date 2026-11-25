const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const root = path.resolve(__dirname, '../..');
const bookmarks = [
  ['React', 'https://react.dev/', '开发文档', '用于构建用户界面的 React 官方文档', ['前端开发', 'React 文档', '组件开发']],
  ['MDN Web Docs', 'https://developer.mozilla.org/zh-CN/', '开发文档', '提供 HTML、CSS 与 JavaScript 的开发参考', ['Web 文档', '前端开发', 'JavaScript']],
  ['TypeScript', 'https://www.typescriptlang.org/docs/', '开发文档', '提供 TypeScript 类型系统与语言使用指南', ['类型系统', '开发文档', 'TypeScript']],
  ['Figma', 'https://www.figma.com/', '设计灵感', '用于界面设计、原型制作与团队协作', ['界面设计', '交互原型', '设计工具']],
  ['Dribbble', 'https://dribbble.com/', '设计灵感', '汇集设计作品，可用于创作参考和寻找灵感', ['设计灵感', '作品展示', '界面参考']],
  ['Unsplash', 'https://unsplash.com/', '设计灵感', '提供摄影图片素材，可用于设计与创作参考', ['图片素材', '摄影图片', '设计素材']],
  ['Squoosh', 'https://squoosh.app/', '实用工具', '在浏览器中压缩图片并转换图像格式', ['图片压缩', '图像优化', 'WebP 转换']],
  ['TinyPNG', 'https://tinypng.com/', '实用工具', '在线压缩 PNG 与 JPEG，减少图片体积', ['图片压缩', 'PNG 压缩', '图像优化']],
  ['Excalidraw', 'https://excalidraw.com/', '实用工具', '绘制手绘风格流程图、草图和架构示意图', ['在线白板', '流程图', '架构图']],
];

function loadPlaywright() {
  if (process.env.REMARKS_PLAYWRIGHT_MODULE) return require(process.env.REMARKS_PLAYWRIGHT_MODULE);
  const searchPaths = [root, ...(process.env.PATH || '').split(path.delimiter)
    .filter((entry) => /node_modules[\\/]\.bin[\\/]?$/.test(entry))
    .map((entry) => path.resolve(entry, '..'))];
  return require(require.resolve('playwright', { paths: searchPaths }));
}

async function createDemo({ record = false, executablePath, headless = true, playwright, viewport = { width: 760, height: 820 } } = {}) {
  const workDir = path.join(root, 'output/playwright');
  await fs.mkdir(workDir, { recursive: true });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'demo-fixture', owned_by: '示例响应' }] }));
      return;
    }
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const content = body.messages.findLast((message) => message.role === 'user').content;
      const input = JSON.parse(content.slice(content.indexOf('\n') + 1));
      if (!Array.isArray(input) || input.some((item) => !item.id || !item.sanitizedUrl)) throw new Error('Unexpected fixture request');
      requests.push({ count: input.length, ids: input.map((item) => item.id) });
      const results = input.map((item) => {
        const row = bookmarks.find((entry) => new URL(entry[1]).hostname === new URL(item.sanitizedUrl).hostname);
        if (!row) throw new Error('No fixture for demo bookmark');
        return { id: item.id, decision: row[2] === '开发文档' ? 'existing_folder' : 'new_folder', categoryPath: [row[2]], confidence: 0.88, reason: row[3], keywords: row[4] };
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      res.end(JSON.stringify({ id: 'demo-fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ results }) }, finish_reason: 'stop' }] }));
    } catch (error) {
      console.error('Fixture request failed:', error.message);
      res.writeHead(400); res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const profile = await fs.mkdtemp(path.join(workDir, 'profile-'));
  let context;
  try {
    const { chromium } = playwright || loadPlaywright();
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless, executablePath,
      viewport, deviceScaleFactor: 1,
      locale: 'zh-CN', colorScheme: 'light',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--disable-background-networking'],
      ...(record ? { recordVideo: { dir: path.join(workDir, 'raw'), size: viewport } } : {}),
    });
    console.log('Demo browser started');
    context.setDefaultTimeout(20000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    console.log('Demo extension loaded');
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidebar/index.html`);
    console.log('Demo page opened');
    const seed = await page.evaluate(async ({ endpoint, bookmarks }) => {
      await chrome.storage.local.set({ 'remarks.settings': {
        onboardingCompleted: true, enableHistory: false, sendFullUrl: false,
        provider: { type: 'custom', apiKey: 'demo-placeholder-not-a-real-key', model: 'demo-fixture', endpoint, enabled: false },
      } });
      const tree = await chrome.bookmarks.getTree();
      const parentId = tree[0].children.find((node) => node.id === '1')?.id || tree[0].children[0].id;
      const source = await chrome.bookmarks.create({ parentId, title: '待整理' });
      await chrome.bookmarks.create({ parentId, title: '开发文档' });
      const created = [];
      for (const [title, url] of bookmarks) created.push(await chrome.bookmarks.create({ parentId: source.id, title, url }));
      // Enable only after seeding so background bookmark listeners cannot classify during setup.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const settings = (await chrome.storage.local.get('remarks.settings'))['remarks.settings'];
      await chrome.storage.local.set({ 'remarks.settings': { ...settings, provider: { ...settings.provider, enabled: true } } });
      return { sourceId: source.id, bookmarkIds: created.map((node) => node.id) };
    }, { endpoint, bookmarks });
    await page.reload();
    await page.locator('#root > *').waitFor({ state: 'attached' });
    return { context, page, server, profile, extensionId, seed, requests, workDir,
      async close() { await context.close(); await new Promise((resolve) => server.close(resolve)); } };
  } catch (error) {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

module.exports = { createDemo, root, bookmarks };
