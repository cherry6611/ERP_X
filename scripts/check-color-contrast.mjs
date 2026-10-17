#!/usr/bin/env node
/**
 * F3 / P1-1（§5.4）：语义色 token 的 **WCAG 对比度** 门禁。
 *
 * ## 为什么需要它
 *
 * 徽标（`Badge` 的语义变体）用"同色 10% 浅底 + 同色字"，实测对比度：
 *
 *   | 组合 | 修复前 | AA 正文 4.5 |
 *   |---|---|---|
 *   | `text-warning` on `bg-warning/10` | **1.98 : 1** | ❌ |
 *   | `text-success` on `bg-success/10` | 3.14 : 1 | ❌ |
 *   | `text-primary` on `bg-primary/10` | 4.30 : 1 | ❌ |
 *   | `text-destructive` on `bg-destructive/10` | 3.97 : 1 | ❌ |
 *
 * 徽标字号 `text-xs`(12px) + `font-semibold`，按 WCAG 属**小字，必须 4.5:1**。
 * 而 `biz-labels.ts` 把 **12 个"进行中"状态**全映射到 `warning`，
 * `StatusBadge` 全仓渲染 31 处 / 25 文件 —— 最需要一眼看清的状态，
 * 恰好是全站可读性最差的一处。
 *
 * ## 为什么是脚本而不是单测
 *
 * 这类缺陷**不会报错、不会 500、typecheck 与 lint 都看不见** ——
 * 只有"把颜色算一遍"才能发现。把它做成 CI 步骤，任何一次调色板改动
 * 都会立刻得到"某处掉到 4.5 以下"的反馈，而不是等到无障碍验收。
 *
 * ## 断言范围
 *
 * 只断言**承载文字**的语义组合（浅底 + 专用前景 token）：
 *   · 亮色：`--badge-*-foreground` on `<token>/10` 混白
 *   · 暗色：同上，但底色混深背景
 * 不断言纯装饰色（边框、图表系列色）—— 它们不承载文字，标准不同。
 *
 * 退出码：0 = 全部 ≥ 4.5:1；1 = 存在不合格组合
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CSS_FILE = join(ROOT, 'client', 'src', 'tailwind-theme.css');

/** WCAG AA 对小字（< 18.66px 或 < 14px bold）的要求 */
const AA_SMALL_TEXT = 4.5;

/* ── 颜色工具（HSL → sRGB → 相对亮度 → 对比度）──────────────────────────── */

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => v + m);
}

function relativeLuminance([r, g, b]) {
  const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fgRgb, bgRgb) {
  const l1 = relativeLuminance(fgRgb);
  const l2 = relativeLuminance(bgRgb);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** alpha 混合：把半透明前景/背景合成到不透明底上 */
function blend(rgb, alpha, baseRgb) {
  return rgb.map((v, i) => v * alpha + baseRgb[i] * (1 - alpha));
}

/* ── 从 CSS 里读 token（解析 hsl(H S% L%)，只支持本仓实际用到的写法）──────── */

function readTokens(cssText, selector) {
  // 取 `.dark { ... }` 或 `:root { ... }` 块
  const blockPattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`,
    'u',
  );
  const block = blockPattern.exec(cssText);
  if (!block) throw new Error(`未在 ${CSS_FILE} 找到选择器 ${selector}`);
  const tokens = {};
  for (const matched of block[1].matchAll(
    /(--[a-z0-9-]+)\s*:\s*hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/giu,
  )) {
    tokens[matched[1]] = hslToRgb(
      Number(matched[2]),
      Number(matched[3]),
      Number(matched[4]),
    );
  }
  return tokens;
}

function main() {
  const cssText = readFileSync(CSS_FILE, 'utf8');
  const light = readTokens(cssText, ':root');
  const dark = readTokens(cssText, '.dark');

  /*
   * 被断言的组合：(浅/深底 token, 前景 token, 展示名)
   *
   * 底色用 `<token>/10` = 10% alpha，需混到实际背景上：
   *   亮色混 `--card`（徽标几乎总在卡片上），暗色混 `--background`（保守取更暗的底）。
   */
  const cases = [
    ['--warning', '--badge-warning-foreground', 'warning（进行中）'],
    ['--success', '--badge-success-foreground', 'success（已完成）'],
    ['--primary', '--badge-info-foreground', 'info（待回款）'],
    ['--destructive', '--badge-destructive-foreground', 'destructive（驳回/逾期）'],
  ];

  const results = [];
  for (const [bgToken, fgToken, label] of cases) {
    for (const [modeName, tokens, baseToken] of [
      ['亮色', light, '--card'],
      ['暗色', dark, '--background'],
    ]) {
      const fg = tokens[fgToken];
      const base = tokens[baseToken];
      if (!fg || !tokens[bgToken] || !base) {
        results.push({
          label: `${modeName} ${label}`,
          ratio: 0,
          ok: false,
          detail: `缺少 token（${[fgToken, bgToken, baseToken].filter((t) => !tokens[t]).join(', ')}）`,
        });
        continue;
      }
      const bg = blend(tokens[bgToken], 0.1, base);
      const ratio = contrastRatio(fg, bg);
      results.push({
        label: `${modeName} ${label}`,
        ratio,
        ok: ratio >= AA_SMALL_TEXT,
        detail: `${fgToken} on ${bgToken}/10`,
      });
    }
  }

  console.log('── 徽标语义色 WCAG AA（小字需 ≥ 4.5:1）──────────────────────────');
  let failed = 0;
  for (const item of results) {
    const flag = item.ok ? 'PASS' : 'FAIL';
    if (!item.ok) failed += 1;
    console.log(
      `${flag}  ${item.ratio.toFixed(2).padStart(6)} : 1   ${item.label.padEnd(28)} ${item.detail}`,
    );
  }

  if (failed > 0) {
    console.error(
      `\n[FAIL] ${failed} 个语义色组合低于 WCAG AA 的 ${AA_SMALL_TEXT}:1。\n` +
        '  徽标字号为 12px（小字），必须满足 4.5:1；\n' +
        '  而"进行中"等高频状态全部使用这些徽标 —— 低对比度会让它们在\n' +
        '  投影/低质量显示器上糊成一块。\n' +
        '  修法：调整 client/src/tailwind-theme.css 里对应的\n' +
        '  `--badge-*-foreground`（亮色取更深档、暗色取更浅档），不要动底色。',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n全部 ${results.length} 个组合通过（最低 ${Math.min(...results.map((r) => r.ratio)).toFixed(2)} : 1）。`,
  );
}

main();
