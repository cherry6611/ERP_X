import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@client/src/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

/**
 * P2-12：飞书绑定前必须重新验证当前密码（已启用 MFA 时还要 TOTP）。
 * 单独成组件，避免 SettingsPage 越过 §5.9 的 500 行门槛。
 */
export default function FeishuBindCard() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const startBind = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch('/api/auth/feishu/bind', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          ...(code.trim() ? { code: code.trim() } : {}),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: { message?: string };
      };
      if (!res.ok || !payload.url) {
        throw new Error(payload.error?.message ?? '飞书绑定启动失败');
      }
      window.location.assign(payload.url);
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, '飞书绑定启动失败'));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <SectionTitle>我的飞书</SectionTitle>
        <CardDescription>
          系统禁止飞书扫码自动注册。绑定本人飞书后可使用飞书登录；管理员也可在 HR「身份管理」代绑。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          绑定飞书
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>绑定飞书</DialogTitle>
              <DialogDescription>
                为防止会话被盗后绑定攻击者飞书，请先输入当前密码；已启用 MFA 的账号还需输入动态验证码。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="bind-password">当前密码</Label>
                <Input
                  id="bind-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bind-code">MFA 验证码（未启用可留空）</Label>
                <Input
                  id="bind-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={!password || busy}
                onClick={() => void startBind()}
              >
                {busy ? '验证中…' : '继续绑定'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
