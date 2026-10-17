/**
 * 零依赖 Chrome DevTools Protocol 驱动（纯 Node 内置模块）。
 *
 * ## 为什么不用 Playwright / Puppeteer
 *
 * 这是一次性走查工具：装 Playwright 会给项目引入 ~300MB 浏览器下载与新的
 * devDependency，而仓库已有本机 Chrome。Node 22+ 自带全局 `WebSocket`，
 * 因此直接讲 CDP 协议即可，**不新增任何依赖**、不改 `package.json`。
 *
 * ## 能力
 *
 * - 启动/连接 headless Chrome（独立 user-data-dir，不碰用户浏览器配置）
 * - 登录（走真实 HTTP 拿 Cookie，再用 `Network.setCookie` 注入）
 * - 真实鼠标事件（`Input.dispatchMouseEvent`）—— 不是 DOM 里 `.click()` 的伪交互，
 *   能真正触发 React 的事件委托、遮罩层拦截、disabled 判定等
 * - 真实键盘输入（`Input.insertText` / `Input.dispatchKeyEvent`）
 * - 收集 console 消息、未捕获异常、失败请求（走查要能"看见错误"）
 * - 整页截图、可视区截图
 *
 * 所有导航都等待 `Page.loadEventFired` + 一小段稳定期，避免取到半渲染状态。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge 可执行文件');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome 启动后轮询 /json/version 直到就绪 */
async function waitForDevTools(port, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`DevTools 未就绪: ${lastError}`);
}

export class Browser {
  constructor({ proc, port, userDataDir, version }) {
    this.proc = proc;
    this.port = port;
    this.userDataDir = userDataDir;
    this.version = version;
    this.pages = [];
  }

  static async launch({ port = 9333, headless = true } = {}) {
    const exe = findChrome();
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'erp-walkthrough-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--window-size=1600,1000',
      '--hide-scrollbars',
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new');
    const proc = spawn(exe, args, { stdio: 'ignore', detached: false });
    const version = await waitForDevTools(port);
    const browser = new Browser({ proc, port, userDataDir, version });
    browser._browserWs = version.webSocketDebuggerUrl;
    return browser;
  }

  /** 新建一个页签并接入 */
  async newPage() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, {
      method: 'PUT',
    });
    const target = await res.json();
    const page = new Page(target.webSocketDebuggerUrl, target.id, this);
    await page.connect();
    this.pages.push(page);
    return page;
  }

  async close() {
    for (const page of this.pages) {
      try {
        await page.close();
      } catch {
        /* 忽略关闭失败 */
      }
    }
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    await sleep(300);
    try {
      rmSync(this.userDataDir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔句柄未释放，忽略 */
    }
  }
}

export class Page {
  constructor(wsUrl, targetId, browser) {
    this.wsUrl = wsUrl;
    this.targetId = targetId;
    this.browser = browser;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleLogs = [];
    this.exceptions = [];
    this.failedRequests = [];
    this.httpErrors = [];
    this.requests = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (event) =>
        reject(new Error(`CDP 连接失败: ${event.message ?? 'unknown'}`))
      );
      ws.addEventListener('message', (event) => this._onMessage(event.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
        else waiter.resolve(msg.result);
      }
      return;
    }
    const handlers = this.listeners.get(msg.method);
    if (handlers) for (const h of handlers) h(msg.params);
    this._record(msg.method, msg.params);
  }

  /** 把走查期间"看得见的错误"沉淀下来（console/异常/网络） */
  _record(method, params) {
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      this.consoleLogs.push({ type: params.type, text });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {};
      this.exceptions.push({
        text: d.text ?? '',
        description: d.exception?.description ?? '',
        url: d.url ?? '',
        line: d.lineNumber,
      });
    } else if (method === 'Network.requestWillBeSent') {
      this.requests.push({ url: params.request?.url, method: params.request?.method });
    } else if (method === 'Network.loadingFailed') {
      this.failedRequests.push({
        errorText: params.errorText,
        type: params.type,
        requestId: params.requestId,
      });
    } else if (method === 'Network.responseReceived') {
      const status = params.response?.status ?? 0;
      if (status >= 400 && !String(params.response?.url ?? '').includes('favicon')) {
        this.httpErrors.push({
          status,
          url: params.response.url,
          method: this.requests.find((r) => r.url === params.response.url)?.method ?? '',
        });
      }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  /** 等待某个 CDP 事件（带超时），用于等 load 完成 */
  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const handler = (params) => {
        clearTimeout(timer);
        const list = this.listeners.get(method) ?? [];
        this.listeners.set(
          method,
          list.filter((h) => h !== handler)
        );
        resolve(params);
      };
      const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
      this.on(method, handler);
    });
  }

  send(method, params = {}, timeoutMs = 45000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('DOM.enable');
    await this.send('CSS.enable');
  }

  /** 重置每页的错误采集（每个用例开始前调用，避免串味） */
  resetDiagnostics() {
    this.consoleLogs = [];
    this.exceptions = [];
    this.failedRequests = [];
    this.httpErrors = [];
    this.requests = [];
  }

  async setViewport(width, height, scale = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
  }

  async setCookie({ name, value, domain = '127.0.0.1', url }) {
    const params = { name, value, path: '/', httpOnly: true, sameSite: 'Lax' };
    if (url) params.url = url;
    else params.domain = domain;
    await this.send('Network.setCookie', params);
  }

  async clearCookies() {
    await this.send('Network.clearBrowserCookies');
  }

  async goto(url, { settleMs = 700, timeoutMs = 40000 } = {}) {
    const loaded = this.once('Page.loadEventFired', timeoutMs).catch(() => null);
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(settleMs);
  }

  /** 在页面里求值（awaitPromise 便于等 fetch） */
  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `页面求值异常: ${result.exceptionDetails.text} ${
          result.exceptionDetails.exception?.description ?? ''
        }`
      );
    }
    return result.result?.value;
  }

  async text(selector) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.innerText : null; })()`
    );
  }

  async waitForText(substring, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const body = await this.evaluate('document.body ? document.body.innerText : ""');
      if (body && body.includes(substring)) return true;
      await sleep(200);
    }
    return false;
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = await this.evaluate(
        `!!document.querySelector(${JSON.stringify(selector)})`
      );
      if (found) return true;
      await sleep(150);
    }
    return false;
  }

  /** 元素中心点坐标（视口坐标系），供真实鼠标事件使用 */
  async centerOf(selector, { index = 0 } = {}) {
    return this.evaluate(
      `(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        const el = els[${index}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                 top: r.top, left: r.left, w: r.width, h: r.height };
      })()`
    );
  }

  /**
   * 真实点击：先滚动到可视区，再用 CDP 派发 mouseMoved/Pressed/Released。
   *
   * 为什么不用 `el.click()`：那不会经过浏览器命中测试，遮罩层挡住、
   * 元素被 disabled、或不在视口内时**依然会"成功"**，产生假绿灯。
   */
  async click(selector, { index = 0, settleMs = 450 } = {}) {
    const box = await this.centerOf(selector, { index });
    if (!box) throw new Error(`找不到可点击元素: ${selector}[${index}]`);
    // 保证在视口内
    await this.evaluate(
      `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)});
        els[${index}]?.scrollIntoView({ block: 'center', inline: 'center' }); })()`
    );
    await sleep(120);
    const pos = await this.centerOf(selector, { index });
    const x = pos?.x ?? box.x;
    const y = pos?.y ?? box.y;
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(settleMs);
    return { x, y };
  }

  /** 按文本内容点击（先在页面里定位到该文本最近的 button/a/[role=tab]） */
  async clickByText(text, { selector = 'button, a, [role="tab"], [role="menuitem"]', settleMs = 450 } = {}) {
    const json = JSON.stringify(text);
    const sel = JSON.stringify(selector);
    const found = await this.evaluate(
      `(() => {
        const nodes = [...document.querySelectorAll(${sel})];
        const hit = nodes.find(n => (n.innerText || '').trim() === ${json})
                 ?? nodes.find(n => (n.innerText || '').includes(${json}));
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center', inline: 'center' });
        window.__wtTarget = hit;
        return true;
      })()`
    );
    if (!found) throw new Error(`找不到文本为「${text}」的可点击元素`);
    await sleep(120);
    const box = await this.evaluate(
      `(() => { const r = window.__wtTarget.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`
    );
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(settleMs);
  }

  /** 聚焦元素并输入文本（insertText 走真实输入管线） */
  async fill(selector, value, { index = 0, settleMs = 150 } = {}) {
    const ok = await this.evaluate(
      `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)});
        const el = els[${index}]; if (!el) return false;
        el.scrollIntoView({ block: 'center' }); el.focus();
        return true; })()`
    );
    if (!ok) throw new Error(`找不到输入框: ${selector}[${index}]`);
    await sleep(80);
    // 清空（React 受控输入需要走原生 setter + input 事件）
    await this.evaluate(
      `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)});
        const el = els[${index}];
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
    await this.send('Input.insertText', { text: String(value) });
    await this.evaluate(
      `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)});
        els[${index}]?.dispatchEvent(new Event('input', { bubbles: true }));
        els[${index}]?.dispatchEvent(new Event('change', { bubbles: true })); })()`
    );
    await sleep(settleMs);
  }

  /** 选择下拉（原生 <select>） */
  async selectNative(selector, value) {
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true; })()`
    );
    await sleep(300);
  }

  async pressKey(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      text: key === 'Enter' ? '\r' : undefined,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await sleep(300);
  }

  /** 整页截图（captureBeyondViewport 才能拿到滚动区全貌） */
  async screenshot(filePath, { fullPage = true } = {}) {
    const params = { format: 'png', captureBeyondViewport: fullPage };
    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        await this.setViewport(Math.ceil(size.width), Math.ceil(size.height));
        await sleep(200);
      }
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  /** 页面概览：URL、标题、可见文本长度、主要元素统计 —— 走查断言的基础 */
  async snapshot() {
    return this.evaluate(`(() => ({
      url: location.pathname + location.search,
      title: document.title,
      textLength: (document.body?.innerText || '').length,
      text: (document.body?.innerText || '').slice(0, 4000),
      buttons: [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean),
      inputs: [...document.querySelectorAll('input,textarea,select')].map(i => ({
        tag: i.tagName.toLowerCase(), type: i.type || '', name: i.name || '',
        placeholder: i.placeholder || '', id: i.id || '',
        disabled: !!i.disabled,
      })),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      tables: document.querySelectorAll('table').length,
      cards: document.querySelectorAll('[class*="rounded"]').length,
    }))()`);
  }

  async close() {
    try {
      await this.send('Page.close');
    } catch {
      /* 忽略 */
    }
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

export { sleep };
