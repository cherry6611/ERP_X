import React, { useMemo, useState } from 'react';
import { Table, type TableColumnsType } from 'antd';
import { toast } from 'sonner';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Badge } from '@client/src/components/ui/badge';
import { Switch } from '@client/src/components/ui/switch';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { adminApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { AutomationConfigItem } from '@shared/api.interface';

const AdminAutomationPage: React.FC = () => {
  const [operatingKey, setOperatingKey] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsyncData(() =>
    adminApi.listAutomationConfig()
  );

  const doToggle = async (item: AutomationConfigItem, next: boolean) => {
    if (next === false) {
      const ok = await confirmDanger(
        `确认停用任务「${item.taskName}」？停用后到点将不再执行。`,
        { title: '确认停用' },
      );
      if (!ok) return;
    }
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

  const columns = useMemo<TableColumnsType<AutomationConfigItem>>(
    () => [
      {
        title: '任务',
        key: 'task',
        width: 320,
        render: (_, item) => (
          <span className="font-medium" title={item.taskKey}>
            {item.taskName}
          </span>
        ),
      },
      {
        title: '说明',
        dataIndex: 'description',
        key: 'description',
        render: (value: string | null) => (
          <span className="text-muted-foreground">{value ?? '暂无说明'}</span>
        ),
      },
      {
        title: '状态',
        dataIndex: 'enabled',
        key: 'enabled',
        width: 100,
        render: (enabled: boolean) =>
          enabled ? (
            <Badge variant="success">已启用</Badge>
          ) : (
            <Badge variant="secondary">已停用</Badge>
          ),
      },
      {
        title: '启用',
        key: 'switch',
        width: 88,
        align: 'right',
        render: (_, item) => (
          <CanCapabilityWrite capability="admin_ops">
            <Switch
              checked={item.enabled}
              disabled={operatingKey === item.taskKey}
              onCheckedChange={(checked: boolean) => void doToggle(item, checked)}
              aria-label={`${item.enabled ? '停用' : '启用'}任务 ${item.taskName}`}
            />
          </CanCapabilityWrite>
        ),
      },
    ],
    [operatingKey],
  );

  return (
    <PageShell
      title="自动化任务"
      description="定时任务总开关，停用后到点不执行"
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && items.length === 0}
        emptyText="暂无自动化任务"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          rowKey="taskKey"
          columns={columns}
          dataSource={items}
          pagination={false}
          scroll={{ x: 900 }}
        />
      </DataState>
    </PageShell>
  );
};

export default AdminAutomationPage;

