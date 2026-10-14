import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Table, type TableColumnsType } from 'antd';
import { Link2, Plus, RefreshCw, Shield, UserX } from 'lucide-react';
import { CanCapability } from '@client/src/platform/auth';
import * as identityApi from '@client/src/api/identity';
import type { IdentityUser } from '@client/src/api/identity';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { ROLE_CODES, ROLE_LABELS, type RoleCode } from '@shared/rbac';

const IdentityPanel: React.FC = () => {
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [rolesTarget, setRolesTarget] = useState<IdentityUser | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    password: '',
    roles: [''] as string[],
  });
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  const loadKey = useMemo(
    () => `${q}|${statusFilter}`,
    [q, statusFilter],
  );

  const { data: users, loading, reload } = useAsyncData<IdentityUser[]>(
    () =>
      identityApi.listUsers({
        q: q.trim() || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
      }),
    [loadKey],
  );

  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(okMsg);
    } catch {
      toast.message(text);
    }
  };

  const onCreate = async () => {
    try {
      const created = await identityApi.createUser({
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        password: form.password.trim() || undefined,
        roles: form.roles.filter(Boolean),
      });
      if (created.temporaryPassword) {
        setTempPassword(created.temporaryPassword);
      }
      toast.success('账号已创建');
      setCreateOpen(false);
      setForm({ username: '', displayName: '', password: '', roles: [''] });
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '创建失败'));
    }
  };

  const openRoles = (row: IdentityUser) => {
    setRolesTarget(row);
    setSelectedRoles([...row.roles]);
  };

  const saveRoles = async () => {
    if (!rolesTarget) return;
    try {
      await identityApi.setRoles(rolesTarget.id, selectedRoles);
      toast.success('角色已更新');
      setRolesTarget(null);
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '更新角色失败'));
    }
  };

  const toggleRole = (code: string) => {
    setSelectedRoles((prev) =>
      prev.includes(code) ? prev.filter((r) => r !== code) : [...prev, code],
    );
  };

  const columns: TableColumnsType<IdentityUser> = useMemo(
    () => [
      { title: '账号', dataIndex: 'username', width: 120 },
      { title: '显示名', dataIndex: 'displayName', width: 120 },
      {
        title: '状态',
        dataIndex: 'status',
        width: 80,
        render: (v: string) => (v === 'active' ? '启用' : '停用'),
      },
      {
        title: '角色',
        dataIndex: 'roles',
        render: (roles: string[]) =>
          roles.map((r) => ROLE_LABELS[r as RoleCode] ?? r).join('、') || '—',
      },
      {
        title: '飞书',
        width: 90,
        render: (_: unknown, row: IdentityUser) => (row.feishuBound ? '已绑定' : '未绑定'),
      },
      {
        title: '员工',
        dataIndex: 'employeeName',
        width: 100,
        render: (v: string | null) => v || '—',
      },
      {
        title: '操作',
        width: 360,
        render: (_: unknown, row: IdentityUser) => (
          <div className="flex flex-wrap gap-1">
            <Button type="button" size="sm" variant="outline" onClick={() => openRoles(row)}>
              <Shield className="size-3.5" />
              角色
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const res = await identityApi.resetPassword(row.id);
                  setTempPassword(res.temporaryPassword);
                  toast.success('已重置密码');
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '重置失败'));
                }
              }}
            >
              重置密码
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const res = await identityApi.createFeishuInvite(row.id);
                  setInviteUrl(res.inviteUrl);
                  toast.success('邀请链接已生成');
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '生成邀请失败'));
                }
              }}
            >
              <Link2 className="size-3.5" />
              代绑飞书
            </Button>
            {row.feishuBound ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const ok = await confirmDanger('确认解绑该用户的飞书？解绑后需重新邀请。');
                  if (!ok) return;
                  try {
                    await identityApi.unbindFeishu(row.id);
                    toast.success('已解绑');
                    reload();
                  } catch (err) {
                    toast.error(getApiErrorMessage(err, '解绑失败'));
                  }
                }}
              >
                解绑
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                const next = row.status === 'active' ? 'disabled' : 'active';
                const ok = await confirmDanger(
                  next === 'disabled' ? '确认停用该账号？' : '确认启用该账号？',
                );
                if (!ok) return;
                try {
                  await identityApi.setStatus(row.id, next);
                  toast.success(next === 'disabled' ? '已停用' : '已启用');
                  reload();
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '操作失败'));
                }
              }}
            >
              <UserX className="size-3.5" />
              {row.status === 'active' ? '停用' : '启用'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={async () => {
                const ok = await confirmDanger('确认踢出该用户全部会话？');
                if (!ok) return;
                try {
                  await identityApi.revokeAllSessions(row.id);
                  toast.success('已踢出全部会话');
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '操作失败'));
                }
              }}
            >
              踢会话
            </Button>
          </div>
        ),
      },
    ],
    [reload],
  );

  const onSearch = useCallback(() => reload(), [reload]);

  return (
    <CanCapability capability="identity" fallback={<p className="text-sm text-muted-foreground">无身份管理权限</p>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="identity-q">搜索</Label>
            <Input
              id="identity-q"
              placeholder="账号 / 显示名"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-48"
            />
          </div>
          <div className="space-y-1">
            <Label>状态</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="active">启用</SelectItem>
                <SelectItem value="disabled">停用</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" onClick={onSearch}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            开通账号
          </Button>
        </div>

        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={users ?? []}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1100 }}
        />
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>开通账号</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-username">登录名</Label>
              <Input
                id="new-username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-display">显示名</Label>
              <Input
                id="new-display"
                value={form.displayName}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-password">初始密码（可留空自动生成）</Label>
              <Input
                id="new-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void onCreate()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rolesTarget} onOpenChange={(o) => !o && setRolesTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑角色 · {rolesTarget?.displayName}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            {ROLE_CODES.map((code) => (
              <Button
                key={code}
                type="button"
                size="sm"
                variant={selectedRoles.includes(code) ? 'default' : 'outline'}
                onClick={() => toggleRole(code)}
              >
                {ROLE_LABELS[code]}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRolesTarget(null)}>
              取消
            </Button>
            <Button type="button" onClick={() => void saveRoles()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!inviteUrl} onOpenChange={(o) => !o && setInviteUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>飞书代绑邀请链接</DialogTitle>
          </DialogHeader>
          <p className="break-all text-sm text-muted-foreground">{inviteUrl}</p>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => inviteUrl && void copyText(inviteUrl, '已复制邀请链接')}
            >
              复制链接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tempPassword} onOpenChange={(o) => !o && setTempPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>临时密码</DialogTitle>
          </DialogHeader>
          <p className="font-mono text-sm">{tempPassword}</p>
          <p className="text-xs text-muted-foreground">请妥善告知用户，关闭后不再显示。</p>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => tempPassword && void copyText(tempPassword, '已复制临时密码')}
            >
              复制
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CanCapability>
  );
};

export default IdentityPanel;
