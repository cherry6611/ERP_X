// client/src/utils/user.ts

import type { I18nText, User, UserInput } from '../types/user';
import type { Department } from '../types/user';

export function asDepartment(value: unknown): Department | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Department;
}

/**
 * 获取国际化文本的显示值
 * @param text 国际化文本或普通字符串
 * @param locale 语言，默认 zh_cn
 */
export function getI18nText(
  text: I18nText | string | undefined,
  locale: 'zh_cn' | 'en_us' | 'ja_jp' = 'zh_cn',
): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  // 添加更完整的 fallback 逻辑
  return text[locale] || text.zh_cn || text.en_us || text.ja_jp || '';
}

/**
 * 将任意格式的用户数据转换为标准 User 类型（下划线命名）
 */
export function normalizeUser(input: UserInput): User {
  const data: User & { userId?: string; userType?: User['user_type'] } = input;
  const user_id = data.user_id || data.userId || '';
  return {
    user_id,
    larkUserId: data.larkUserId,
    name: data.name,
    avatar: data.avatar,
    email: data.email,
    user_type: data.user_type || data.userType,
    department: data.department,
  };
}

/**
 * 验证 user_id 是否有效
 */
export function isValidUserId(user_id: string | undefined): boolean {
  if (!user_id) return false;
  const trimmed = user_id.trim();
  if (!trimmed) return false;
  if (trimmed === '""') return false; // 过滤 AI 可能生成的 ""
  return true;
}

/**
 * 获取用户显示名称
 * 自动处理 I18nText 类型
 */
export function getUserDisplayName(
  user: User | undefined,
  locale: 'zh_cn' | 'en_us' | 'ja_jp' = 'zh_cn',
): string {
  if (!user) return '';
  return getI18nText(user.name, locale) || '无效人员';
}
