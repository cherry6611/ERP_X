import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Layers, Loader2 } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { settingsApi } from '@client/src/api';
import { withBasePath } from '@client/src/utils/base-path';

/**
 * P1-4：登录成功后的整页跳转目标。
 *
 * 只接受站内绝对路径（以 `/` 开头且不以 `//` 开头），防开放重定向。
 * 注意 `useSearchParams` 已做过一次 URL 解码，这里不再二次解码。
 */
function resolveRedirectTarget(raw: string | null): string {
  if (!raw) return '/';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
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

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
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
        setError(
          resp.status === 401 || resp.status === 403
            ? '账号或密码错误'
            : resp.status === 429
              ? '尝试过于频繁，请稍后再试'
              : '登录失败，请稍后重试',
        );
        return;
      }
      goAfterLogin();
    } catch {
      setError('登录失败，请检查网络后重试');
    } finally {
      setSubmitting(false);
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
    <div className="grid min-h-screen bg-background md:grid-cols-2">
      <section className="relative hidden flex-col justify-between overflow-hidden p-8 text-primary-foreground md:flex bg-glow">
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
            <p className="text-[22px] font-semibold leading-tight">{brandName}</p>
            <p className="text-sm text-primary-foreground/80">数据服务一体化</p>
          </div>
        </div>
        <p className="relative max-w-sm text-sm leading-6 text-primary-foreground/85">
          合同、项目、财务与人力在同一套账上运转。
        </p>
      </section>
      <div className="flex items-center justify-center p-6">
        <form
          className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-card"
          onSubmit={onSubmit}
          aria-busy={submitting}
        >
          <div>
            <p className="text-sm font-medium text-muted-foreground md:hidden">
              {brandName}
            </p>
            <h1 className="text-[22px] font-semibold leading-tight">
              {bindInvite ? '绑定飞书' : '登录'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {bindInvite
                ? '管理员邀请您绑定飞书。请使用下方「飞书登录」完成代绑，无需输入密码。'
                : '使用账号登录，或通过飞书免登'}
            </p>
          </div>
          {bindInvite ? null : (
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
                    className="absolute right-0 top-0 h-9 w-9"
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
          {bindInvite ? null : (
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
          <Button
            className="w-full"
            type="button"
            variant={bindInvite ? 'default' : 'outline'}
            onClick={startFeishu}
          >
            {bindInvite ? '使用飞书完成绑定' : '飞书登录'}
          </Button>
        </form>
      </div>
    </div>
  );
}
