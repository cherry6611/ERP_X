import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Loader2 } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
        setError('账号或密码错误');
        return;
      }
      navigate('/');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-background md:grid-cols-2">
      <section className="hidden flex-col justify-between bg-primary p-8 text-primary-foreground md:flex">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary-foreground/15">
            <Layers className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-2xl font-semibold leading-tight">晟笙 ERP</p>
            <p className="text-sm text-primary-foreground/80">数据服务一体化</p>
          </div>
        </div>
        <p className="max-w-sm text-sm leading-6 text-primary-foreground/80">
          合同、项目、财务与人力在同一套账上运转。
        </p>
      </section>
      <div className="flex items-center justify-center p-6">
        <form
          className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-5 shadow-sm"
          onSubmit={onSubmit}
        >
          <div>
            <h1 className="text-2xl font-semibold leading-tight md:hidden">晟笙 ERP</h1>
            <h1 className="hidden text-2xl font-semibold leading-tight md:block">登录</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              使用账号登录，或通过飞书免登
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-username">账号</Label>
            <Input
              id="login-username"
              autoComplete="username"
              autoFocus
              className="focus-visible:ring-2 focus-visible:ring-ring"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-password">密码</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              className="focus-visible:ring-2 focus-visible:ring-ring"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div role="alert" aria-live="assertive" className="min-h-5 text-sm text-destructive">
            {error}
          </div>
          <Button className="w-full" type="submit" disabled={submitting}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            登录
          </Button>
          <Button
            className="w-full"
            type="button"
            variant="outline"
            onClick={() => {
              window.location.assign('/api/auth/feishu/start');
            }}
          >
            飞书登录
          </Button>
        </form>
      </div>
    </div>
  );
}
