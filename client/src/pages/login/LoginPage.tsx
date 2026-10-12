import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
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
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <form className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6" onSubmit={onSubmit}>
        <div>
          <h1 className="text-lg font-semibold">晟笙 ERP</h1>
          <p className="text-sm text-muted-foreground">使用账号登录，或通过飞书免登</p>
        </div>
        <label className="block text-sm">
          账号
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          密码
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button className="w-full rounded bg-primary px-3 py-2 text-primary-foreground" type="submit">
          登录
        </button>
        <a className="block text-center text-sm text-primary" href="/api/auth/feishu/start">
          飞书登录
        </a>
      </form>
    </div>
  );
}
