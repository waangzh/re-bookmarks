// Run with: npm exec --yes --package=playwright@1.65.1 -- node scripts/record-demo.cjs
const { createDemo, root } = require('./demo/support.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

const workDir = path.join(root, 'output/playwright');
const outputDir = path.join(root, 'pic');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const syncColors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0], [128, 0, 255], [32, 80, 140]];

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${executable} exited ${code}: ${stderr.slice(-3000)}`)));
  });
}

function xml(text) { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

async function makeFrame(segment, index, total) {
  const icon = (await fs.readFile(path.join(root, 'public/icons/icon128.png'))).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="900">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#f4f7ff"/><stop offset="1" stop-color="#eaf1fd"/></linearGradient></defs>
    <rect width="1120" height="900" fill="url(#bg)"/>
    <rect x="337" y="37" width="766" height="826" rx="12" fill="#dce5f5"/>
    <rect x="340" y="40" width="760" height="820" fill="#f7faff"/>
    <image href="data:image/png;base64,${icon}" x="34" y="47" width="44" height="44"/>
    <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">
      <text x="90" y="78" font-size="30" font-weight="700" fill="#142847">ReMarks</text>
      <text x="36" y="124" font-size="15" fill="#62738c">AI 辅助书签整理</text>
      <text x="34" y="245" font-size="42" font-weight="700" fill="#142847">收藏有序</text>
      <text x="34" y="304" font-size="42" font-weight="700" fill="#315bd8">找回轻松</text>
      <path d="M36 367H290" stroke="#cfdbef"/>
      <text x="36" y="413" font-size="14" letter-spacing="2" fill="#6f83a5">${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</text>
      <text x="34" y="467" font-size="27" font-weight="700" fill="#142847">${xml(segment.title)}</text>
      ${segment.lines.map((line, n) => `<text x="36" y="${510 + n * 28}" font-size="16" fill="#586d8c">${xml(line)}</text>`).join('')}
      <rect x="36" y="688" width="123" height="28" rx="14" fill="#e0e9ff"/>
      <text x="48" y="707" font-size="12" fill="#315bd8">扩展页面实际操作</text>
      <text x="36" y="771" font-size="12" fill="#6c7e98">示例书签 · 固定分类响应</text>
      <text x="36" y="793" font-size="12" fill="#6c7e98">移动、备份与撤销实际执行</text>
      <text x="36" y="843" font-size="12" fill="#8494ac">Chrome / Edge / Firefox</text>
    </g>
  </svg>`;
  const frame = path.join(workDir, `frame-${index}.png`);
  await sharp(Buffer.from(svg)).png().toFile(frame);
  return frame;
}

async function main() {
  await fs.mkdir(workDir, { recursive: true });
  const demo = await createDemo({ record: true });
  const { page } = demo;
  const segments = [];
  const evidence = { fixture: true, bookmarkCount: 9 };
  const video = page.video();
  let finished = false;
  try {
    // Only a pointer overlay is injected; product layout and business behavior are unchanged.
    await page.evaluate(() => {
      const pointer = document.createElement('div');
      pointer.id = 'remarks-demo-pointer';
      pointer.style.cssText = 'position:fixed;left:0;top:0;width:25px;height:30px;pointer-events:none;z-index:2147483647;transform:translate(24px,24px);filter:drop-shadow(0 2px 3px #18396a55)';
      pointer.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 30"><path d="M3 2L3 24L9 18L14 28L18 26L13 16L22 15Z" fill="#2349a9" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
      document.documentElement.append(pointer);
      const sync = document.createElement('div');
      sync.id = 'remarks-demo-sync';
      sync.style.cssText = 'position:fixed;left:0;top:0;width:12px;height:12px;pointer-events:none;z-index:2147483647';
      document.documentElement.append(sync);
      window.addEventListener('mousemove', (e) => { pointer.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; });
      window.addEventListener('mousedown', (e) => {
        const ring = document.createElement('div');
        ring.style.cssText = `position:fixed;left:${e.clientX - 16}px;top:${e.clientY - 16}px;width:32px;height:32px;border:2px solid #527cf4;border-radius:50%;background:#527cf422;pointer-events:none;z-index:2147483646`;
        document.documentElement.append(ring);
        const animation = ring.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 650 });
        animation.onfinish = () => ring.remove();
      });
    });
    const click = async (locator, hold = 550) => {
      await locator.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await pause(450);
      const box = await locator.boundingBox();
      if (!box) throw new Error('Demo control is not visible');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
      await pause(150);
      await locator.click();
      await pause(hold);
    };
    const chapter = async (title, lines, targetSeconds, action) => {
      await page.evaluate((color) => { document.getElementById('remarks-demo-sync').style.background = `rgb(${color.join(',')})`; }, syncColors[segments.length]);
      const start = Date.now();
      await action();
      segments.push({ title, lines, targetSeconds, start, end: Date.now() });
      console.log(`Captured: ${title}`);
    };
    await pause(500);
    await chapter('按用途找回书签', ['忘记网站名字也没关系', '输入「图片压缩」即可查找'], 8, async () => {
      await pause(1300);
      const input = page.locator('input[aria-label="搜索书签"]');
      await click(input, 200);
      await input.pressSequentially('图片压缩', { delay: 280 });
      await page.getByText('查看全部 2 条结果', { exact: true }).waitFor();
      await pause(2700);
      await page.screenshot({ path: path.join(workDir, 'search.png') });
    });
    await chapter('生成分类建议', ['选择本次要整理的书签', '生成建议时不会移动书签'], 7, async () => {
      await click(page.getByRole('button', { name: '清除搜索', exact: true }), 200);
      await click(page.getByRole('link', { name: '开始智能整理', exact: true }), 1200);
      await click(page.getByRole('button', { name: '开始分类 (9 个书签)', exact: true }), 200);
      await page.getByText('审核整理方案', { exact: true }).waitFor({ timeout: 60000 });
      await pause(1600);
    });
    await chapter('先确认目录结构', ['新建目录需要先审核', '采用结构后，再审核书签'], 7, async () => {
      await pause(1000);
      await click(page.getByRole('button', { name: '采用此目录', exact: true }).first(), 900);
      await click(page.getByRole('button', { name: '采用此目录', exact: true }).first(), 1400);
    });
    await chapter('分类可以随时修正', ['把 Dribbble 调整到设计灵感', '这里只改方案，还没有移动'], 9, async () => {
      const card = page.locator('article.review-item').filter({ has: page.getByRole('heading', { name: 'Dribbble', exact: true }) });
      await click(card.getByRole('button', { name: '修改目标目录', exact: true }), 650);
      const input = page.getByPlaceholder('例如：开发 / 文档');
      await click(input, 150);
      await input.fill('');
      await input.pressSequentially('设计灵感', { delay: 220 });
      await pause(900);
      await click(page.getByRole('button', { name: '确认修改', exact: true }), 1300);
    });
    await chapter('审核后再批准移动', ['支持批量处理待决定建议', '执行前仍可检查完整移动清单'], 7, async () => {
      await click(page.getByRole('button', { name: '全选待决定', exact: true }), 850);
      await click(page.getByRole('button', { name: '同意移动所选', exact: true }), 1000);
      await click(page.locator('summary').filter({ hasText: '执行清单与目标树' }), 1600);
      const tree = await page.evaluate(() => chrome.bookmarks.getTree());
      const source = tree[0].children.flatMap((node) => node.children || []).find((node) => node.title === '待整理');
      if (source?.children?.length !== 9) throw new Error('Bookmarks changed before confirmation');
      evidence.unchangedBeforeConfirmation = true;
    });
    await chapter('确认后先备份再执行', ['再次核对移动与新建目录数量', '备份失败时会停止执行'], 6, async () => {
      await click(page.getByRole('button', { name: '检查并应用（9 条）', exact: true }), 2100);
      await click(page.getByRole('button', { name: '确认移动 9 个书签', exact: true }), 200);
      await page.waitForURL(/#\/report$/);
      await page.getByText('整理完成', { exact: true }).waitFor();
      await pause(1300);
    });
    await chapter('每次整理都有记录', ['9 个书签归入 3 个目标目录', '查看执行报告与自动备份'], 8, async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await pause(1600);
      await page.screenshot({ path: path.join(workDir, 'report.png') });
      const state = await page.evaluate(async () => {
        const storage = await chrome.storage.local.get(['remarks.backupHistory', 'remarks.lastReport']);
        const report = storage['remarks.lastReport'];
        const tree = await chrome.bookmarks.getTree();
        const folders = tree[0].children.flatMap((node) => node.children || []).filter((node) => !node.url);
        return { backupCount: storage['remarks.backupHistory']?.length || 0, movedCount: report.movedCount, failedCount: report.failedItems.length, folders: folders.map((node) => ({ title: node.title, bookmarkCount: node.children?.length || 0 })) };
      });
      if (state.backupCount < 1 || state.failedCount !== 0 || state.folders.filter((node) => node.bookmarkCount === 3).length !== 3) throw new Error('Organize verification failed');
      evidence.organize = state;
      await page.goto(`chrome-extension://${demo.extensionId}/sidebar/index.html#/backups`);
      await page.getByRole('heading', { name: '书签备份', exact: true }).waitFor();
      await pause(2200);
    });
    await chapter('需要时，可以撤销', ['将最近一次整理移回原目录', '保留执行记录，方便核对'], 8, async () => {
      await page.goto(`chrome-extension://${demo.extensionId}/sidebar/index.html#/report`);
      await page.getByRole('button', { name: '撤销本次整理', exact: true }).waitFor();
      page.once('dialog', (dialog) => dialog.accept());
      await click(page.getByRole('button', { name: '撤销本次整理', exact: true }), 300);
      await page.getByText('撤销完成', { exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await pause(2800);
      evidence.undo = await page.evaluate(async () => {
        const tree = await chrome.bookmarks.getTree();
        const source = tree[0].children.flatMap((node) => node.children || []).find((node) => node.title === '待整理');
        const report = (await chrome.storage.local.get('remarks.lastReport'))['remarks.lastReport'];
        return { sourceTitle: source?.title, restoredCount: source?.children?.length || 0, failedCount: report.failedItems.length };
      });
      if (evidence.undo.restoredCount !== 9 || evidence.undo.failedCount !== 0) throw new Error('Undo verification failed');
      await page.screenshot({ path: path.join(workDir, 'undo.png') });
    });
    evidence.fixtureRequests = demo.requests;
    await page.evaluate((color) => { document.getElementById('remarks-demo-sync').style.background = `rgb(${color.join(',')})`; }, syncColors[segments.length]);
    await pause(250);
    await page.close();
    const rawPath = await video.path();
    await demo.close();
    finished = true;
    // Recover exact scene boundaries from recorded pixels, rather than assuming
    // wall-clock time and video presentation timestamps share the same origin.
    const syncFile = path.join(workDir, 'sync.rgb');
    await command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawPath, '-vf', 'fps=25,crop=2:2:4:4,format=rgb24', '-f', 'rawvideo', syncFile]);
    const samples = await fs.readFile(syncFile);
    const boundaries = [];
    for (let frame = 0; frame * 12 < samples.length && boundaries.length < syncColors.length; frame++) {
      const rgb = [0, 0, 0];
      for (let pixel = 0; pixel < 4; pixel++) for (let channel = 0; channel < 3; channel++) rgb[channel] += samples[frame * 12 + pixel * 3 + channel] / 4;
      const expected = syncColors[boundaries.length];
      if (rgb.every((value, channel) => Math.abs(value - expected[channel]) < 55)) boundaries.push(frame / 25);
    }
    if (boundaries.length !== segments.length + 1) throw new Error('Could not recover all recording scene boundaries');
    evidence.rawVideo = rawPath;
    evidence.videoBoundaries = boundaries;
    const files = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const duration = boundaries[i + 1] - boundaries[i];
      const speed = Math.max(1, duration / segment.targetSeconds);
      const clipDuration = duration / speed;
      segment.outputDuration = clipDuration;
      const frame = await makeFrame(segment, i, segments.length);
      const file = path.join(workDir, `chapter-${i}.mp4`);
      await command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(boundaries[i]), '-t', String(duration), '-i', rawPath, '-loop', '1', '-i', frame, '-filter_complex', `[0:v]setpts=(PTS-STARTPTS)/${speed},fps=30,drawbox=x=0:y=0:w=12:h=12:color=0xf7faff:t=fill[page];[1:v][page]overlay=340:40:shortest=1,format=yuv420p[out]`, '-map', '[out]', '-t', String(clipDuration), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30', file]);
      files.push(file);
      console.log(`Rendered: ${segment.title}`);
    }
    const list = path.join(workDir, 'concat.txt');
    await fs.writeFile(list, files.map((file) => `file '${file.replaceAll('\\', '/')}'`).join('\n'));
    const master = path.join(outputDir, 'demo.mp4');
    await command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', master]);
    await command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', files[0], '-i', files[4], '-i', files[6], '-filter_complex', '[0:v]trim=start=1.8:duration=5,setpts=PTS-STARTPTS[a];[1:v]trim=start=1:duration=4,setpts=PTS-STARTPTS[b];[2:v]trim=start=0:duration=4,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,fps=10,scale=896:-1:flags=lanczos,split[v][p];[p]palettegen=max_colors=128:stats_mode=diff[palette];[v][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]', '-map', '[out]', '-loop', '0', path.join(outputDir, 'demo.gif')]);
    await command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '4', '-i', master, '-frames:v', '1', path.join(outputDir, 'demo-cover.png')]);
    const metadata = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate', '-of', 'json', master]));
    await fs.writeFile(path.join(workDir, 'verification.json'), JSON.stringify({ ...evidence, metadata, segments }, null, 2));
    console.log(JSON.stringify({ output: master, metadata, verification: path.join(workDir, 'verification.json') }, null, 2));
  } finally {
    if (!finished) await demo.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
