import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VIEWPORT, WORK_DIR, demoCopyFor, parseCliArgs } from './config.mjs';
import { runOrThrow } from './lib.mjs';
import { createDemoWorkspace } from './workspace.mjs';
import { preflight } from './preflight.mjs';

const MODEL_TIMEOUT_MS = 660_000;

function elapsedMs(origin) {
  return Date.now() - origin;
}

async function installPresentationLayer(page, lang) {
  await page.addStyleTag({ content: `
    #sessionList { visibility: hidden !important; }
    body { cursor: none !important; }
    #demo-pointer {
      position: fixed; left: 0; top: 0; z-index: 2147483647; width: 24px; height: 24px;
      pointer-events: none; transform: translate(-100px, -100px); transition: transform 260ms ease-out;
      filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));
    }
    #demo-pointer::before {
      content: ''; display: block; width: 0; height: 0;
      border-top: 22px solid #f7f8fa; border-right: 13px solid transparent;
      transform: rotate(-12deg); filter: drop-shadow(0 0 1px #111);
    }
    .demo-pulse {
      position: fixed; z-index: 2147483646; width: 18px; height: 18px; border-radius: 50%;
      pointer-events: none; border: 3px solid rgba(230,80,60,.9);
      animation: demo-pulse .48s ease-out forwards;
    }
    @keyframes demo-pulse { from { transform: translate(-50%,-50%) scale(.4); opacity: 1; }
      to { transform: translate(-50%,-50%) scale(2.8); opacity: 0; } }
    #demo-terminal {
      position: fixed; inset: 88px 120px; z-index: 2147483600; border-radius: 18px;
      background: #111418; color: #d7e1e8; border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 28px 80px rgba(0,0,0,.45); padding: 0; overflow: hidden;
      font: 25px/1.5 Consolas, 'Cascadia Mono', monospace;
    }
    #demo-terminal .term-head { padding: 14px 20px; background: #1d2228; color: #aebbc5; font: 16px/1.2 system-ui; }
    #demo-terminal pre { margin: 0; padding: 28px 34px; white-space: pre-wrap; }
    #demo-terminal .prompt { color: #64d98b; }
    #demo-terminal .proof { color: #8fbaff; }
  ` });
  await page.evaluate(lang => {
    const pointer = document.createElement('div');
    pointer.id = 'demo-pointer';
    document.body.appendChild(pointer);
    if (lang !== 'en') return;

    // Roundtable 的静态 UI 已支持英文，但少量工作台事件文本来自服务端中文状态。
    // 这里只本地化录制页的展示文本，不修改会话数据、API 响应或产品代码。
    const localize = root => {
      const scope = root?.querySelectorAll ? root : document;
      const select = selector => [
        ...(root?.matches?.(selector) ? [root] : []),
        ...scope.querySelectorAll(selector),
      ];
      for (const node of select('.chat-name')) {
        const translated = node.textContent
          .replace(/^用户\b|^用户(?=\s|→|$)/, 'User')
          .replaceAll('、', ', ')
          .replace(/\s*动手$/, ' build');
        if (translated !== node.textContent) node.textContent = translated;
      }
      for (const node of select('.wb-sys')) {
        let translated = node.textContent;
        translated = translated
          .replace(/^互聊开始：/, 'Relay started: ')
          .replace(/，至多\s*(\d+)\s*轮$/, ', up to $1 rounds')
          .replace(/^互聊结束（完成）$/, 'Relay finished (complete)')
          .replace(/^(.+?) 开始动手（隔离副本，主工作区零接触）…$/, '$1 started building in an isolated copy; the main worktree is untouched…')
          .replace(/^已应用\s*(\d+)\s*个文件到主工作区（未提交——commit 权在你自己的 git 流程里）$/, 'Applied $1 file to the main worktree (not committed—commits remain in your git workflow).');
        if (translated !== node.textContent) node.textContent = translated;
      }
      for (const option of select('#tpl option')) {
        if (option.textContent.startsWith('协作开发')) {
          option.textContent = 'Collaborative development';
        }
      }
    };
    localize(document);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData' && record.target.parentElement) localize(record.target.parentElement);
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) localize(node);
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    window.__roundtableDemoI18nObserver = observer;
  }, lang);
}

async function hold(page, ms) {
  await page.waitForTimeout(ms);
}

async function pointAt(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('目标控件不可见，无法录制点击');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const pointer = document.querySelector('#demo-pointer');
    pointer.style.transform = `translate(${x}px, ${y}px)`;
  }, point);
  await hold(page, 320);
  return point;
}

async function visualClick(page, locator) {
  const point = await pointAt(page, locator);
  // 部分 checkbox 被可点击 label 包裹，Playwright 严格命中会认为 label 拦截事件。
  // 目标已在 pointAt 中确认可见；force 仍向真实目标派发浏览器点击，不走 JS 伪造状态。
  await locator.click({ force: true });
  await page.evaluate(({ x, y }) => {
    const pulse = document.createElement('div');
    pulse.className = 'demo-pulse';
    pulse.style.left = `${x}px`;
    pulse.style.top = `${y}px`;
    document.body.appendChild(pulse);
    setTimeout(() => pulse.remove(), 600);
  }, point);
  await hold(page, 280);
}

async function visualFill(page, locator, text) {
  await pointAt(page, locator);
  await locator.fill('');
  const step = Math.max(1, Math.ceil(text.length / 28));
  for (let end = step; end < text.length; end += step) {
    await locator.fill(text.slice(0, end));
    await hold(page, 24);
  }
  await locator.fill(text);
  await hold(page, 220);
}

async function setChecked(page, locator, checked) {
  if ((await locator.isChecked()) !== checked) await visualClick(page, locator);
}

async function waitForBusySignal(page, { previousAgentMessages, previousBuildCards = 0 }) {
  await page.waitForFunction(({ previousAgentMessages, previousBuildCards }) => (
    document.querySelector('.chat-typing')
    || document.querySelector('.build-live')
    || document.querySelector('#wbSend')?.disabled
    // mock 或极快 CLI 可能在下一帧前已回到 idle；出现新结果同样证明动作已触发。
    || document.querySelectorAll('.chat-msg.chat-agent:not(.chat-typing)').length > previousAgentMessages
    || document.querySelectorAll('.build-card').length > previousBuildCards
  ), { previousAgentMessages, previousBuildCards }, { timeout: 20_000 });
}

async function waitForWorkbenchResult(page, { minAgentMessages, minBuildCards = 0, previousErrorCount }) {
  const handle = await page.waitForFunction(({ minAgentMessages, minBuildCards, previousErrorCount }) => {
    const errors = [...document.querySelectorAll('.wb-error')];
    if (errors.length > previousErrorCount) return { error: errors.at(-1).textContent };
    const idle = !document.querySelector('#wbSend')?.disabled;
    const agentMessages = document.querySelectorAll('.chat-msg.chat-agent:not(.chat-typing)').length;
    const buildCards = document.querySelectorAll('.build-card').length;
    if (idle && agentMessages >= minAgentMessages && buildCards >= minBuildCards) return { ok: true };
    return false;
  }, { minAgentMessages, minBuildCards, previousErrorCount }, { timeout: MODEL_TIMEOUT_MS });
  const result = await handle.jsonValue();
  if (result.error) throw new Error(result.error);
}

async function showTerminalProof(page, status, diff, diffCommand, heading) {
  await page.evaluate(({ status, diff, diffCommand, heading }) => {
    document.querySelector('#demo-terminal')?.remove();
    const panel = document.createElement('section');
    panel.id = 'demo-terminal';
    const head = document.createElement('div');
    head.className = 'term-head';
    head.textContent = heading;
    const pre = document.createElement('pre');
    const p1 = document.createElement('span');
    p1.className = 'prompt';
    p1.textContent = '$ git status --short\n';
    const s1 = document.createTextNode(status.trimEnd() + '\n\n');
    const p2 = document.createElement('span');
    p2.className = 'prompt';
    p2.textContent = `$ ${diffCommand}\n`;
    const s2 = document.createElement('span');
    s2.className = 'proof';
    s2.textContent = diff.trimEnd();
    pre.append(p1, s1, p2, s2);
    panel.append(head, pre);
    document.body.appendChild(panel);
  }, { status, diff, diffCommand, heading });
}

async function verifyAppliedChange(workspace) {
  const status = (await runOrThrow('git', ['status', '--short'], { cwd: workspace.repoPath })).stdout;
  const unstagedDiff = (await runOrThrow('git', ['diff', '--', 'README.md'], { cwd: workspace.repoPath })).stdout;
  const stagedDiff = (await runOrThrow('git', ['diff', '--cached', '--', 'README.md'], { cwd: workspace.repoPath })).stdout;
  const diff = unstagedDiff.trim() ? unstagedDiff : stagedDiff;
  const diffCommand = unstagedDiff.trim() ? 'git diff -- README.md' : 'git diff --cached -- README.md';
  const readme = await readFile(path.join(workspace.repoPath, 'README.md'), 'utf8');
  const head = (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: workspace.repoPath })).stdout.trim();
  if (!status.includes('README.md')) throw new Error('审批后 git status 未显示 README.md 改动');
  if (!readme.includes(workspace.expectedLine)) throw new Error('审批后的 README.md 未包含预期项目简介');
  if (!diff.trim()) throw new Error('审批后 git diff 为空，无法证明改动已落地主工作区');
  if (head !== workspace.initialHead) throw new Error('演示仓库出现了自动 commit，录制已停止');
  return { status, diff, diffCommand };
}

export async function recordDemo(options, workspace) {
  const copy = demoCopyFor(options.lang);
  const { chromium } = await import('playwright');
  const rawDir = path.join(WORK_DIR, 'raw');
  await mkdir(rawDir, { recursive: true });
  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: rawDir, size: VIEWPORT },
    colorScheme: 'dark',
    locale: copy.locale,
  });
  const page = await context.newPage();
  await page.addInitScript(lang => localStorage.setItem('rt-lang', lang), options.lang);
  const video = page.video();
  const videoOrigin = Date.now();
  const segments = [];
  let workbenchId = null;
  let completed = false;

  const segment = async (cueId, label, action) => {
    const item = { cueId, label, startMs: Math.max(0, elapsedMs(videoOrigin) - 120) };
    await action();
    item.endMs = elapsedMs(videoOrigin) + 120;
    if (item.endMs - item.startMs < 300) item.endMs = item.startMs + 300;
    segments.push(item);
  };

  try {
    await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30_000 });
    await installPresentationLayer(page, options.lang);
    await hold(page, 600);

    await segment('shot-1', '打开并创建工作台', async () => {
      await visualClick(page, page.locator('#newBenchBtn'));
      await page.locator('#wbSetup').waitFor({ state: 'visible' });
      const participantBoxes = page.locator('#wbParticipants input[type=checkbox]');
      for (let index = 0; index < await participantBoxes.count(); index += 1) {
        const box = participantBoxes.nth(index);
        const id = await box.getAttribute('value');
        await setChecked(page, box, ['claude', 'codex'].includes(id));
      }
      await visualFill(page, page.locator('#wbName'), copy.workbenchName);
      await visualFill(page, page.locator('#wbWorkspace'), workspace.displayPath);
      await visualClick(page, page.locator('#wbCreate'));
      await page.locator('#workbench').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForFunction(name => document.querySelector('#wbTitle')?.textContent.includes(name), copy.workbenchName);
      workbenchId = await page.evaluate(() => (typeof wbId === 'string' ? wbId : null));
      await hold(page, 1600);
    });

    const recipients = {
      claude: page.locator('#wbRecipients input[value=claude]'),
      codex: page.locator('#wbRecipients input[value=codex]'),
    };
    const errorsBeforeChat = await page.locator('.wb-error').count();
    const messagesBeforeChat = await page.locator('.chat-msg.chat-agent:not(.chat-typing)').count();
    await segment('shot-2', '向两个模型发消息', async () => {
      await setChecked(page, recipients.claude, true);
      await setChecked(page, recipients.codex, true);
      await visualFill(page, page.locator('#wbInput'), copy.chatPrompt);
      await visualClick(page, page.locator('#wbSend'));
      await waitForBusySignal(page, { previousAgentMessages: messagesBeforeChat });
      await hold(page, 900);
    });
    await waitForWorkbenchResult(page, {
      minAgentMessages: 2,
      previousErrorCount: errorsBeforeChat,
    });
    await segment('shot-2', '展示两个模型的真实回复', async () => {
      await page.locator('#wbLog').evaluate(node => (node.scrollTop = node.scrollHeight));
      await hold(page, 4200);
    });

    const beforeRelay = await page.locator('.chat-msg.chat-agent:not(.chat-typing)').count();
    const errorsBeforeRelay = await page.locator('.wb-error').count();
    await segment('shot-2', '启动两轮互聊', async () => {
      await page.locator('#wbRounds').fill('2');
      await visualClick(page, page.locator('#wbRelay'));
      await waitForBusySignal(page, { previousAgentMessages: beforeRelay });
      await hold(page, 900);
    });
    await waitForWorkbenchResult(page, {
      minAgentMessages: beforeRelay + 1,
      previousErrorCount: errorsBeforeRelay,
    });
    await segment('shot-2', '展示互相点名与反驳', async () => {
      await page.locator('#wbLog').evaluate(node => (node.scrollTop = node.scrollHeight));
      await hold(page, 4400);
    });

    const buildsBefore = await page.locator('.build-card').count();
    const messagesBeforeBuild = await page.locator('.chat-msg.chat-agent:not(.chat-typing)').count();
    const errorsBeforeBuild = await page.locator('.wb-error').count();
    await segment('shot-3', '让 Codex 在隔离副本动手', async () => {
      await setChecked(page, recipients.claude, false);
      await setChecked(page, recipients.codex, true);
      await visualFill(page, page.locator('#wbInput'), copy.buildPrompt);
      await visualClick(page, page.locator('#wbBuild'));
      await waitForBusySignal(page, { previousAgentMessages: messagesBeforeBuild, previousBuildCards: buildsBefore });
      await hold(page, 1400);
    });
    await waitForWorkbenchResult(page, {
      minAgentMessages: messagesBeforeBuild + 1,
      minBuildCards: buildsBefore + 1,
      previousErrorCount: errorsBeforeBuild,
    });
    const buildCard = page.locator('.build-card').last();
    await segment('shot-3', '展开真实 diff', async () => {
      await buildCard.scrollIntoViewIfNeeded();
      const details = buildCard.locator('.build-file details').first();
      if (!(await details.evaluate(node => node.open))) await visualClick(page, details.locator('summary'));
      await hold(page, 5200);
    });

    await segment('shot-4', '逐文件审批应用', async () => {
      const apply = buildCard.locator('.build-file summary').first()
        .getByRole('button', { name: copy.applyLabel, exact: true });
      await visualClick(page, apply);
      await page.waitForFunction(() => (
        [...document.querySelectorAll('.build-card .bf-st')].some(node => node.dataset.st === 'applied')
      ), null, { timeout: 30_000 });
      await hold(page, 2200);
      const proof = await verifyAppliedChange(workspace);
      await showTerminalProof(page, proof.status, proof.diff, proof.diffCommand, copy.terminalHeading);
      await hold(page, 5200);
    });

    await segment('outro', '切到正式会议入口', async () => {
      await page.evaluate(() => document.querySelector('#demo-terminal')?.remove());
      await visualClick(page, page.locator('#newSessionBtn'));
      await page.locator('#setup').waitFor({ state: 'visible' });
      await hold(page, 3000);
    });
    completed = true;
  } finally {
    // 删除当前活动工作台是软删除：服务会把它移入 sessions/.trash，可恢复；动作在保留片段之外。
    if (completed && workbenchId) {
      await page.evaluate(async id => {
        try { await fetch(`/api/workbenches/${id}`, { method: 'DELETE' }); } catch { /* best effort */ }
      }, workbenchId).catch(() => {});
    }
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!completed) throw new Error('浏览器录制未完成');
  const generatedPath = await video.path();
  const rawVideo = path.join(rawDir, 'roundtable-raw.webm');
  if (path.resolve(generatedPath) !== path.resolve(rawVideo)) await copyFile(generatedPath, rawVideo);
  const timeline = {
    version: 1,
    source: rawVideo,
    viewport: VIEWPORT,
    segments,
    recordedAt: new Date().toISOString(),
    mode: options.mock ? 'mock' : 'real',
    lang: options.lang,
  };
  const timelinePath = path.join(WORK_DIR, 'timeline.json');
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf8');
  console.log(`[record] 原始录屏与剪辑点已生成：${timelinePath}`);
  return { rawVideo, timelinePath, timeline };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const options = parseCliArgs();
  let workspace;
  try {
    await preflight(options);
    workspace = await createDemoWorkspace(options);
    await recordDemo(options, workspace);
  } catch (error) {
    console.error('[record] ' + error.message);
    process.exitCode = 1;
  } finally {
    await workspace?.cleanup();
  }
}
