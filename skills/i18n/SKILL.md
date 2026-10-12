---
name: i18n
description: Use when implementing internationalization (i18n / 多语言) in a NestJS + React fullstack project. 触发词：多语言, 国际化, i18n, 语言切换, react-i18next, nestjs-i18n, 翻译, translation, localization
---

# i18n — NestJS + React 全栈多语言方案

前后端一体化方案：翻译文件统一放 `/shared/locales/`，通过 `Accept-Language` header 同步语言状态。

## 技术选型 Quick Reference

| 端   | 库                                 | 用途                           |
|------|------------------------------------|-------------------------------|
| 前端 | `react-i18next` + `i18next`        | 翻译 Hook、组件                |
| 前端 | `i18next-browser-languagedetector` | 浏览器/Cookie 语言检测         |
| 后端 | `nestjs-i18n`                      | NestJS 模块化 i18n 支持        |

## 语言配置文件放置位置

统一存放在 `shared/locales/`，前后端共享，避免重复维护：

```
shared/
└── locales/
    ├── zh/
    │   ├── common.json       # 通用词汇（前后端共用）
    │   ├── validation.json   # 验证消息（后端为主，前端可复用）
    │   ├── ui.json           # 前端 UI 字符串
    │   └── errors.json       # 后端错误消息
    └── en/
        ├── common.json
        ├── validation.json
        ├── ui.json
        └── errors.json
```

- 前端通过 `@shared` alias（已预配置）引用：`@shared/locales/zh/ui.json`
- 后端通过 `nestjs-i18n` 的 `path` 选项指向 `shared/locales/`
- Namespace 规范：`common`（通用）、`validation`（验证消息）、`ui`（前端专属）、`errors`（后端错误）

## 前端实现（`/client/src/`）

### 安装依赖

```bash
npm install i18next react-i18next i18next-browser-languagedetector
```

### `client/src/i18n.ts` — 初始化配置

```typescript
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCommon from '@shared/locales/zh/common.json';
import zhValidation from '@shared/locales/zh/validation.json';
import zhUi from '@shared/locales/zh/ui.json';
import enCommon from '@shared/locales/en/common.json';
import enValidation from '@shared/locales/en/validation.json';
import enUi from '@shared/locales/en/ui.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: { common: zhCommon, validation: zhValidation, ui: zhUi },
      en: { common: enCommon, validation: enValidation, ui: enUi },
    },
    fallbackLng: 'zh',
    defaultNS: 'common',
    detection: {
      order: ['cookie', 'navigator'],
      lookupCookie: 'lang',
      caches: ['cookie'],
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
```

### `client/src/app.tsx` — 引入 i18n 配置（必须）

```typescript
import './i18n'; // 必须在所有组件渲染前引入，放在文件第一行
import React from 'react';
// ... 其余 App 内容
```

> ⚠️ **`import './i18n'` 必须放在 `app.tsx` 的第一行 import，否则组件渲染时翻译尚未初始化，所有 `t()` 调用将返回 key 而非译文。**

### 组件中使用翻译

```typescript
import { useTranslation } from 'react-i18next';

export function WelcomePage() {
  const { t } = useTranslation('ui');  // 指定 namespace
  const { t: tCommon } = useTranslation('common');

  return (
    <div>
      <h1>{t('welcome.title')}</h1>
      <p>{tCommon('actions.save')}</p>
    </div>
  );
}
```

### 语言切换

```typescript
import i18n from 'i18next';
import axios from 'axios';
import Cookies from 'js-cookie';

export function switchLanguage(lang: string) {
  // 1. 写入 Cookie（供 LanguageDetector 和后端读取）
  Cookies.set('lang', lang, { expires: 365 });

  // 2. 更新 axios 拦截器，确保后续请求携带正确 header
  axios.defaults.headers.common['Accept-Language'] = lang;

  // 3. 切换前端语言
  i18n.changeLanguage(lang);
}
```

> 初始化时也需设置 axios header，在 `i18n.ts` 初始化完成后调用：
> ```typescript
> axios.defaults.headers.common['Accept-Language'] = i18n.language;
> ```

## 后端实现（`/server/`）

### 安装依赖

```bash
npm install nestjs-i18n
```

### `AppModule` 配置

```typescript
import { Module } from '@nestjs/common';
import { join } from 'path';
import {
  I18nModule,
  HeaderResolver,
  CookieResolver,
  AcceptLanguageResolver,
} from 'nestjs-i18n';

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: 'zh',
      loaderOptions: {
        path: join(__dirname, '../../../shared/locales/'),
        watch: true,
      },
      resolvers: [
        new HeaderResolver(['accept-language']),
        new CookieResolver(['lang']),
        AcceptLanguageResolver,
      ],
    }),
  ],
})
export class AppModule {}
```

> Resolver 优先级：`Accept-Language` header > Cookie `lang` > fallback `zh`

### Service 中使用翻译

```typescript
import { Injectable } from '@nestjs/common';
import { I18nService, I18nContext } from 'nestjs-i18n';

@Injectable()
export class UserService {
  constructor(private readonly i18n: I18nService) {}

  async getWelcomeMessage(): Promise<string> {
    // 自动使用当前请求语言
    return this.i18n.t('common.welcome.title');
  }

  async getErrorMessage(lang?: string): Promise<string> {
    // 手动指定语言
    return this.i18n.t('errors.user.not_found', { lang });
  }
}
```

### DTO 验证消息国际化

```typescript
import { IsString, MinLength } from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';

export class CreateUserDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(2, { message: i18nValidationMessage('validation.minLength') })
  name: string;
}
```

对应 `shared/locales/zh/validation.json`：

```json
{
  "isString": "必须是字符串",
  "minLength": "最少需要 $constraint1 个字符，当前为 $value"
}
```

## 语言同步机制

```
用户点击切换语言
    ↓
Cookie 写入 lang=en
    ↓
axios header: Accept-Language: en
    ↓
i18n.changeLanguage('en')  ← 前端 UI 立即更新
    ↓
后续 API 请求携带 Accept-Language: en
    ↓
后端 HeaderResolver 提取语言 → nestjs-i18n 用 en 翻译
```

## 默认语言检测逻辑

前端检测顺序（LanguageDetector `order`）：

1. Cookie `lang` — 用户明确选择过
2. `navigator.language` — 浏览器系统语言
3. Fallback `zh`

后端 Resolver 优先级：

1. `Accept-Language` header — 前端明确传递
2. Cookie `lang` — 浏览器 Cookie
3. Fallback `zh`

## Common Mistakes

| 错误 | 正确做法 |
|------|---------|
| 前后端各自维护翻译文件 | 统一放 `shared/locales/` 共享 |
| 前后端语言状态不同步 | 统一用 `Accept-Language` header 传递 |
| 后端硬编码错误信息字符串 | 用 `nestjs-i18n` `i18n.t()` 方法翻译 |
| 忘记在 axios 拦截器设置 header | 切换语言时同步调用 `axios.defaults.headers.common['Accept-Language'] = lang` |
| namespace 命名不规范 | 遵循 `common` / `validation` / `ui` / `errors` 规范 |
| 切换语言只调用 `i18n.changeLanguage()` | 同时更新 Cookie + axios header + `changeLanguage()` |
| 忘记在 `app.tsx` 引入 `i18n.ts` | `import './i18n'` 必须是 app.tsx 第一行 import |
