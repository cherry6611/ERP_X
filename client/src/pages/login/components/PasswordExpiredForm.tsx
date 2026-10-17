import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';

interface PasswordExpiredFormProps {
  username: string;
  newPassword: string;
  onNewPasswordChange: (value: string) => void;
  mfaCode: string;
  onMfaCodeChange: (value: string) => void;
}

/** P2-11：密码过期/首改的登录页表单（从 LoginPage 抽出以守住 500 行门槛）。 */
export default function PasswordExpiredForm({
  username,
  newPassword,
  onNewPasswordChange,
  mfaCode,
  onMfaCodeChange,
}: PasswordExpiredFormProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        账号：<span className="font-medium text-foreground">{username}</span>
      </p>
      <div className="space-y-2">
        <Label htmlFor="login-new-password">新密码（至少 12 位）</Label>
        <Input
          id="login-new-password"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={newPassword}
          onChange={(event) => onNewPasswordChange(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="login-password-mfa">MFA 验证码（未启用可留空）</Label>
        <Input
          id="login-password-mfa"
          inputMode="numeric"
          maxLength={6}
          value={mfaCode}
          onChange={(event) => onMfaCodeChange(event.target.value)}
        />
      </div>
    </div>
  );
}
