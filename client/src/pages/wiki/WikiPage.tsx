import React, { useState } from 'react';
import { Table, TableColumnsType } from 'antd';
import { ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { fetchWikiNodes, toApiErrorMessage } from '@client/src/api/feishu-drive';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { WikiNode, WikiNodesResponse } from '@shared/api.interface';
import { UniversalLink } from '@client/src/platform/UniversalLink';

interface PathSegment {
  nodeToken: string;
  title: string;
}

const OBJ_TYPE_LABELS: Record<string, string> = {
  doc: '文档',
  docx: '文档',
  sheet: '表格',
  bitable: '多维表格',
  file: '文件',
  mindnote: '笔记',
  slides: '幻灯片',
};

function formatTime(unixSeconds: string | null): string {
  if (!unixSeconds) return '-';
  const ts = Number(unixSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  return new Date(ts * 1000).toLocaleString('zh-CN');
}

const WikiPage: React.FC = () => {
  const [path, setPath] = useState<PathSegment[]>([]);
  const [parentNodeToken, setParentNodeToken] = useState<string>('');

  const { data, loading, error, reload } = useAsyncData<WikiNodesResponse>(
    async () => {
      try {
        return await fetchWikiNodes(parentNodeToken || undefined);
      } catch (err) {
        throw new Error(toApiErrorMessage(err));
      }
    },
    [parentNodeToken],
  );

  const permissionDenied = data?.permissionDenied === true;

  const enterNode = (segment: PathSegment) => {
    setPath((prev: PathSegment[]) => {
      const index = prev.findIndex((s: PathSegment) => s.nodeToken === segment.nodeToken);
      if (index < 0) {
        return [...prev, segment];
      }
      return prev.slice(0, index + 1);
    });
    setParentNodeToken(segment.nodeToken);
  };

  const columns: TableColumnsType<WikiNode> = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (v: string, record: WikiNode) => (
        <UniversalLink
          to={record.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {v}
        </UniversalLink>
      ),
    },
    {
      title: '类型',
      dataIndex: 'objType',
      width: 110,
      render: (t: string | null) => (
        <Badge variant="secondary">{OBJ_TYPE_LABELS[t ?? ''] ?? '节点'}</Badge>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'nodeEditTime',
      width: 180,
      render: (v: string | null) => formatTime(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, record: WikiNode) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <UniversalLink to={record.url} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 h-4 w-4" aria-hidden />
              打开
            </UniversalLink>
          </Button>
          {record.hasChild ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => enterNode({ nodeToken: record.nodeToken, title: record.title })}
            >
              查看子节点
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="知识库"
      description="浏览企业知识库空间中的文档与节点"
      actions={
        <Button variant="outline" onClick={() => reload()}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
          刷新
        </Button>
      }
    >
      {permissionDenied ? (
        <div className="rounded-md border border-warning/40 bg-warning/15 p-4 text-sm">
          <p className="font-medium text-warning">知识库空间尚未授权本应用访问</p>
          <p className="mt-2 text-warning">
            请管理员在飞书知识库空间「设置 → 成员管理」中，将本应用（云空间集成）添加为知识库成员并授予可编辑权限，完成后回到本页刷新即可。
          </p>
        </div>
      ) : error && /未配置|空间未配置|FEISHU_WIKI/.test(error) ? (
        <div className="rounded-md border bg-muted/40 p-4 text-sm">
          <p className="font-medium">知识库尚未配置</p>
          <p className="mt-2 text-muted-foreground">
            请管理员在环境变量中配置 <code className="rounded bg-muted px-1">FEISHU_WIKI_SPACE_ID</code>
            ，或在飞书云空间集成配置中写入知识库空间 ID 后刷新本页。配置完成前不影响其他业务模块使用。
          </p>
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          加载失败：{error}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 text-sm">
            <Button
              variant={path.length === 0 ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-sm"
              onClick={() => {
                setPath([]);
                setParentNodeToken('');
              }}
            >
              全部节点
            </Button>
            {path.map((segment: PathSegment, index: number) => (
              <React.Fragment key={segment.nodeToken}>
                <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                <Button
                  variant={index === path.length - 1 ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-sm"
                  onClick={() => enterNode(segment)}
                >
                  {segment.title}
                </Button>
              </React.Fragment>
            ))}
          </div>
          <Table
            rowKey="nodeToken"
            columns={columns}
            dataSource={data?.items ?? []}
            loading={loading}
            pagination={false}
            locale={{ emptyText: '当前节点下暂无内容' }}
          />
        </>
      )}
    </PageShell>
  );
};

export default WikiPage;
