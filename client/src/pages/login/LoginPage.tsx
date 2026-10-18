import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Layers, Loader2 } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { settingsApi } from '@client/src/api';
import PasswordExpiredForm from './components/PasswordExpiredForm';
import { withBasePath } from '@client/src/utils/base-path';

/**
 * P1-4：登录成功后的整页跳转目标。
 *
 * 只接受站内绝对路径（以 `/` 开头且不以 `//` 开头），防开放重定向。
 * 注意 `useSearchParams` 已做过一次 URL 解码，这里不再二次解码。
 */
function resolveRedirectTarget(raw: string | null): string {
  if (!raw) return '/';
  // `/\evil.com` 会被浏览器规范化为 `//evil.com`，必须与 `//` 一起拦。
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw.startsWith('/') ? raw : '/';
}

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const bindInvite = searchParams.get('bind_invite');
  const feishuOk = searchParams.get('feishu_ok');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(() => searchParams.get('feishu_error') ?? '');
  const [info, setInfo] = useState(() => feishuOk ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [brandName, setBrandName] = useState('晟笙 ERP');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  /*
   * B-04：MFA 两步登录。
   *   · verify：已绑定 MFA，密码通过后输入 6 位 TOTP；
   *   · setup ：角色强制 MFA 但尚未绑定，登录后只能调 mfa/setup|confirm。
   * 原前端完全没有这两个分支：后端返回 mfaRequired 时仍跳首页，形成登录循环。
   */
  const [mfaMode, setMfaMode] = useState<'none' | 'verify' | 'setup'>('none');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSetup, setMfaSetup] = useState<{
    secret: string;
    otpauthUri: string;
    recoveryCodes: string[];
  } | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  /* P2-11：密码过期/首改 —— 登录被 403 拦截后在本页完成改密。 */
  const [passwordChangeMode, setPasswordChangeMode] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [passwordMfaCode, setPasswordMfaCode] = useState('');

  useEffect(() => {
    void settingsApi
      .getBrand()
      .then((b) => {
        setBrandName(b.brandName || '晟笙 ERP');
        setLogoUrl(b.logoUrl);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (bindInvite) {
      setError('');
    }
  }, [bindInvite]);

  /**
   * P1-4：登录成功后的跳转。
   *
   * 必须用整页跳转（window.location.assign）而不是 SPA 的 navigate('/')：
   * 路由守卫 `RequireCapability` 依赖 `useAuth()` 在本页首次挂载时缓存的
   * `/auth/me` 结果；该结果是登录前的【匿名】快照。若只用 SPA 跳转，
   * 守卫会仍看到“未登录”并把用户弹回 `/login?redirect=%2F`，
   * 表现为“登录成功但页面不动”。整页加载会重建应用并重新拉取会话。
   */
  const goAfterLogin = () => {
    window.location.assign(withBasePath(resolveRedirectTarget(searchParams.get('redirect'))));
  };

  useEffect(() => {
    if (!feishuOk) return;
    const t = window.setTimeout(() => {
      window.location.assign(withBasePath('/'));
    }, 800);
    return () => window.clearTimeout(t);
  }, [feishuOk]);

  const submitPasswordChange = async (): Promise<void> => {
    setError('');
    setSubmitting(true);
    try {
      const resp = await fetch('/api/auth/password/change-expired', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          currentPassword: password,
          newPassword,
          ...(passwordMfaCode.trim() ? { mfaCode: passwordMfaCode.trim() } : {}),
        }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? '修改密码失败，请稍后重试');
        return;
      }
      setPasswordChangeMode(false);
      setPassword('');
      setNewPassword('');
      setInfo('密码已修改，请使用新密码重新登录');
    } catch {
      setError('修改密码失败，请检查网络后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordChangeMode) {
      await submitPasswordChange();
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string; details?: string };
        };
        const expiredPassword =
          typeof body.error?.details === 'string'
            ? body.error.details.includes('PASSWORD_CHANGE_REQUIRED')
            : false;
        if (
          resp.status === 403 &&
          (expiredPassword ||
            body.error?.message?.includes('密码已过期') ||
            body.error?.code === 'PASSWORD_CHANGE_REQUIRED')
        ) {
          setPasswordChangeMode(true);
          setNewPassword('');
          setPasswordMfaCode('');
          setError('');
          return;
        }
        setError(
          resp.status === 401 || resp.status === 403
            ? '账号或密码错误，或需要先完成 MFA 绑定'
            : resp.status === 429
              ? '尝试过于频繁，请稍后再试'
              : '登录失败，请稍后重试',
        );
        return;
      }
      const data = (await resp.json()) as {
        mfaRequired?: boolean;
        mfaSetupRequired?: boolean;
        mfaToken?: string;
        user?: unknown;
      };
      if (data.mfaRequired && data.mfaToken) {
        setMfaToken(data.mfaToken);
        setMfaCode('');
        setMfaMode('verify');
        return;
      }
      if (data.mfaSetupRequired) {
        // 强制 MFA 但未绑定：先拿密钥，用户确认一次动态码后完成绑定。
        const setup = await fetch('/api/auth/mfa/setup', {
          method: 'POST',
          credentials: 'include',
        });
        if (!setup.ok) {
          setError('无法开始 MFA 绑定，请稍后重试或联系管理员');
          return;
        }
        setMfaSetup(await setup.json());
        setMfaCode('');
        setMfaMode('setup');
        return;
      }
      goAfterLogin();
    } catch {
      setError('登录失败，请检查网络后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const verifyMfa = async () => {
    setError('');
    setMfaBusy(true);
    try {
      const resp = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, code: mfaCode.trim() }),
      });
      if (!resp.ok) {
        setError('动态验证码不正确或已过期');
        return;
      }
      goAfterLogin();
    } catch {
      setError('验证失败，请检查网络后重试');
    } finally {
      setMfaBusy(false);
    }
  };

  const confirmMfaSetup = async () => {
    setError('');
    setMfaBusy(true);
    try {
      const resp = await fetch('/api/auth/mfa/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      if (!resp.ok) {
        setError('动态验证码不正确，请确认认证器时间后重试');
        return;
      }
      // 绑定完成后撤销受限会话，强制重新登录走正常 MFA 验证。
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      setMfaMode('none');
      setMfaSetup(null);
      setMfaCode('');
      setInfo('MFA 已绑定，请使用新动态码重新登录');
    } catch {
      setError('绑定失败，请检查网络后重试');
    } finally {
      setMfaBusy(false);
    }
  };

  const startFeishu = () => {
    if (bindInvite) {
      window.location.assign(
        `/api/auth/feishu/invite-start?token=${encodeURIComponent(bindInvite)}`,
      );
      return;
    }
    window.location.assign('/api/auth/feishu/start');
  };

  return (
    <div className="grid min-h-screen bg-[#f5f6f8] md:grid-cols-[minmax(360px,42%)_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-[#1f2f52] p-10 text-primary-foreground md:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{ boxShadow: 'inset 0 0 120px rgba(255,255,255,.12)' }}
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center overflow-hidden rounded-xl bg-primary-foreground/15 shadow-brand">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-10 object-contain" />
            ) : (
              <Layers className="size-5" aria-hidden="true" />
            )}
          </span>
          <div>
            {/*
              ⚠️ 字号对齐 `PageShell` 的规范值 `text-2xl tracking-tight`。
              原来是 `text-[22px] leading-tight` —— 与全站页面标题差 2px，
              且"规范可 grep 验证"这件事会失效（按 `text-2xl` 搜会得出
              "没有一个页面符合规范"的错误结论，见 `PageShell.tsx` 里 P2-4 的同一段论证）。
              登录页是使用者的第一屏，更该与内页一致。
            */}
            <p className="text-2xl font-semibold tracking-tight">{brandName}</p>
            <p className="text-sm text-primary-foreground/80">数据服务一体化</p>
          </div>
        </div>
        <div className="relative max-w-sm space-y-5">
          <div className="space-y-3">
            <h2 className="text-[32px] font-semibold leading-[1.25] tracking-tight">
              经营数据
              <br />
              一处看清
            </h2>
            <p className="text-sm leading-6 text-primary-foreground/80">
              合同、项目、成本与回款在同一套账上运转，少一次对表，多一次判断。
            </p>
          </div>
          <div className="space-y-2 border-t border-primary-foreground/15 pt-5 text-[12px] text-primary-foreground/75">
            <p>· 项目健康与预算执行同屏</p>
            <p>· 收入、成本、回款一条链</p>
            <p>· 关键操作全程留痕</p>
          </div>
        </div>
      </section>
      <div className="flex items-center justify-center p-8">
        <form
          className="w-full max-w-[400px] space-y-5 rounded-2xl border border-border/80 bg-card p-7"
          onSubmit={onSubmit}
          aria-busy={submitting}
        >
          <div>
            <p className="text-sm font-medium text-muted-foreground md:hidden">
              {brandName}
            </p>
            {/* 同上：与 `PageShell` 的页面标题同字号（`text-2xl tracking-tight`） */}
            <h1 className="text-2xl font-semibold tracking-tight">
              {bindInvite
                ? '绑定飞书'
                : passwordChangeMode
                  ? '修改密码'
                  : mfaMode === 'verify'
                    ? '双因素验证'
                    : mfaMode === 'setup'
                      ? '绑定双因素认证'
                      : '登录'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {bindInvite
                ? '管理员邀请您绑定飞书。请使用下方「飞书登录」完成代绑，无需输入密码。'
                : passwordChangeMode
                  ? '密码已过期或需首次修改。设置新密码后即可重新登录。'
                  : mfaMode === 'verify'
                    ? '请输入认证器中的 6 位动态验证码。'
                    : mfaMode === 'setup'
                      ? '当前角色要求启用 MFA。请用 Google/Microsoft Authenticator 等 TOTP App「添加账号 → 手动输入密钥」，App 中每 30 秒刷新的 6 位数字就是动态码；系统不发短信/邮件。'
                      : '使用账号登录，或通过飞书免登'}
            </p>
          </div>
          {bindInvite ? null : passwordChangeMode ? (
            <PasswordExpiredForm
              username={username}
              newPassword={newPassword}
              onNewPasswordChange={setNewPassword}
              mfaCode={passwordMfaCode}
              onMfaCodeChange={setPasswordMfaCode}
            />
          ) : mfaMode === 'none' ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="login-username">账号</Label>
                <Input
                  id="login-username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="login-password">密码</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    className="pr-10"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="!absolute right-2 top-1/2 h-8 w-8 -translate-y-1/2"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : mfaMode === 'verify' ? (
            <div className="space-y-2">
              <Label htmlFor="login-mfa-code">动态验证码</Label>
              <Input
                id="login-mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                密钥（手动录入）：
                <code className="ml-1 break-all rounded bg-muted px-1 py-0.5">
                  {mfaSetup?.secret ?? '加载中…'}
                </code>
              </p>
              {mfaSetup?.otpauthUri ? (
                <p className="break-all text-xs text-muted-foreground">
                  {mfaSetup.otpauthUri}
                </p>
              ) : null}
              {mfaSetup?.recoveryCodes?.length ? (
                <p className="text-xs text-muted-foreground">
                  恢复码（只显示一次）：{mfaSetup.recoveryCodes.join('、')}
                </p>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="login-mfa-code">动态验证码</Label>
                <Input
                  id="login-mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                />
              </div>
            </div>
          )}
          {info ? (
            <p className="text-sm text-muted-foreground" role="status">
              {info}
            </p>
          ) : null}
          <div
            role="alert"
            aria-live="assertive"
            className="min-h-5 text-sm text-destructive"
          >
            {error}
          </div>
          {bindInvite ? null : passwordChangeMode ? (
            <Button
              className="w-full shadow-brand"
              type="submit"
              disabled={submitting || newPassword.length < 12}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              修改密码并继续
            </Button>
          ) : mfaMode === 'verify' ? (
            <Button
              className="w-full shadow-brand"
              type="button"
              onClick={() => void verifyMfa()}
              disabled={mfaBusy || mfaCode.trim().length !== 6}
            >
              {mfaBusy ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              验证并登录
            </Button>
          ) : mfaMode === 'setup' ? (
            <Button
              className="w-full shadow-brand"
              type="button"
              onClick={() => void confirmMfaSetup()}
              disabled={mfaBusy || mfaCode.trim().length !== 6 || !mfaSetup}
            >
              {mfaBusy ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              完成绑定
            </Button>
          ) : (
            <Button className="w-full shadow-brand" type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              登录
            </Button>
          )}
          {(mfaMode === 'none' && !passwordChangeMode) || bindInvite ? (
            <Button
              className="w-full"
              type="button"
              variant={bindInvite ? 'default' : 'outline'}
              onClick={startFeishu}
            >
              {bindInvite ? '使用飞书完成绑定' : '飞书登录'}
            </Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}





