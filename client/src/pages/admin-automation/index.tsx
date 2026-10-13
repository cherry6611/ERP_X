import React, { useState } from 'react';
import { toast } from 'sonner';
import { CanRole } from '@client/src/platform/auth';
import { Badge } from '@client/src/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@client/src/components/ui/card';
import { Switch } from '@client/src/components/ui/switch';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { adminApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { AutomationConfigItem } from '@shared/api.interface';

const AdminAutomationPage: React.FC = () => {
  const [operatingKey, setOperatingKey] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsyncData(() =>
    adminApi.listAutomationConfig()
  );

  const doToggle = async (item: AutomationConfigItem, next: boolean) => {
    setOperatingKey(item.taskKey);
    try {
      await adminApi.updateAutomationConfig(item.taskKey, next);
      toast.success(`任务「${item.taskName}」已${next ? '启用' : '停用'}`);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '更新失败'));
    } finally {
      setOperatingKey(null);
    }
  };

  const items: AutomationConfigItem[] = data ?? [];

  return (
    <PageShell
      title="自动化任务"
      description="定时任务的总开关管理：停用后任务到点不再执行业务逻辑"
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && items.length === 0}
        emptyText="暂无自动化任务"
        onRetry={() => void reload()}
        skeleton="card"
      >
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <Card key={item.taskKey}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base font-semibold">
                  {item.taskName}
                </CardTitle>
                <div className="flex items-center gap-3">
                  {item.enabled ? (
                    <Badge variant="success">已启用</Badge>
                  ) : (
                    <Badge variant="secondary">已停用</Badge>
                  )}
                  <CanRole roles={['admin']}>
                    <Switch
                      checked={item.enabled}
                      disabled={operatingKey === item.taskKey}
                      onCheckedChange={(checked: boolean) =>
                        void doToggle(item, checked)
                      }
                      aria-label={`${item.enabled ? '停用' : '启用'}任务 ${item.taskName}`}
                    />
                  </CanRole>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  {item.description ?? '暂无说明'}
                </p>
                <p className="text-xs text-muted-foreground">
                  任务标识：{item.taskKey}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </DataState>
    </PageShell>
  );
};

export default AdminAutomationPage;
