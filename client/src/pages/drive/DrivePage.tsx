import React, { useState } from 'react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import {
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  createDocument,
  createFolder,
  deleteFile,
  fetchDriveRoot,
  fetchFolderChildren,
  renameFile,
  syncToWiki,
  toApiErrorMessage,
} from '@client/src/api/feishu-drive';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { DriveItem } from '@shared/api.interface';
import DriveInputDialog from './DriveInputDialog';
import DriveUploadButton from './DriveUploadButton';
import { UniversalLink } from '@client/src/platform/UniversalLink';

interface PathSegment {
  token: string;
  name: string;
}

const TYPE_LABELS: Record<string, string> = {
  folder: '文件夹',
  doc: '文档',
  docx: '文档',
  sheet: '表格',
  bitable: '多维表格',
  file: '文件',
  slides: '幻灯片',
  mindnote: '笔记',
  shortcut: '快捷方式',
  other: '其他',
};

const SYNCABLE_TYPES: string[] = ['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'file'];

function formatTime(unixSeconds: string | null): string {
  if (!unixSeconds) return '-';
  const ts = Number(unixSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  return new Date(ts * 1000).toLocaleString('zh-CN');
}

const DrivePage: React.FC = () => {
  const [path, setPath] = useState<PathSegment[]>([]);
  const [currentToken, setCurrentToken] = useState<string>('');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [docDialogOpen, setDocDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DriveItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DriveItem | null>(null);
  const [dialogSubmitting, setDialogSubmitting] = useState(false);

  const {
    data,
    loading,
    error,
    reload,
  } = useAsyncData<DriveItem[]>(
    async () => {
      let token = currentToken;
      if (!token) {
        const root = await fetchDriveRoot();
        token = root.folderToken;
        setPath([{ token, name: '根目录' }]);
      }
      if (!token) return [];
      try {
        const resp = await fetchFolderChildren(token);
        return resp.items;
      } catch (err) {
        throw new Error(toApiErrorMessage(err));
      }
    },
    [currentToken],
  );

  const enterFolder = (segment: PathSegment) => {
    setPath((prev: PathSegment[]) => {
      const index = prev.findIndex((s: PathSegment) => s.token === segment.token);
      if (index < 0) {
        return [...prev, segment];
      }
      return prev.slice(0, index + 1);
    });
    setCurrentToken(segment.token);
  };

  const runAction = async (action: () => Promise<void>) => {
    setDialogSubmitting(true);
    try {
      await action();
      reload();
    } catch (err) {
      const message = toApiErrorMessage(err);
      toast.error(message);
    } finally {
      setDialogSubmitting(false);
    }
  };

  const columns: TableColumnsType<DriveItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (v: string, record: DriveItem) =>
        record.type === 'folder' ? (
          <Button
            variant="ghost"
            className="h-auto p-0 text-sm text-primary underline-offset-4 hover:underline"
            onClick={() => enterFolder({ token: record.token, name: record.name })}
          >
            {v}
          </Button>
        ) : (
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
      dataIndex: 'type',
      width: 110,
      render: (t: string) => (
        <Badge variant="secondary">{TYPE_LABELS[t] ?? t}</Badge>
      ),
    },
    {
      title: '修改时间',
      dataIndex: 'modifiedTime',
      width: 180,
      render: (v: string | null) => formatTime(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_, record: DriveItem) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <UniversalLink to={record.url} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 h-4 w-4" aria-hidden />
              打开
            </UniversalLink>
          </Button>
          <CanRole roles={['admin']}>
            {SYNCABLE_TYPES.includes(record.type) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void runAction(async () => {
                    const resp = await syncToWiki(record.token, record.type as 'doc');
                    if (resp.wikiUrl) {
                      toast.success('已同步到知识库', {
                        description: (
                          <UniversalLink to={resp.wikiUrl} target="_blank" rel="noreferrer">
                            点击查看知识库文档
                          </UniversalLink>
                        ),
                      });
                    }
                  });
                }}
              >
                同步知识库
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`重命名 ${record.name}`}
              onClick={() => setRenameTarget(record)}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`删除 ${record.name}`}
              onClick={() => setDeleteTarget(record)}
            >
              <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
            </Button>
          </CanRole>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="云空间"
      description="浏览和管理企业飞书云空间根目录下的文件与文件夹"
      actions={
        <>
          <Button variant="outline" onClick={() => reload()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            刷新
          </Button>
          <Button
            variant="outline"
            disabled={path.length === 0}
            onClick={() => setFolderDialogOpen(true)}
          >
            <FolderPlus className="mr-2 h-4 w-4" aria-hidden />
            新建文件夹
          </Button>
          <Button
            variant="outline"
            disabled={path.length === 0}
            onClick={() => setDocDialogOpen(true)}
          >
            <FilePlus2 className="mr-2 h-4 w-4" aria-hidden />
            新建文档
          </Button>
          <DriveUploadButton
            folderToken={path.length > 0 ? path[path.length - 1].token : ''}
            onUploaded={reload}
          />
        </>
      }
    >
      <div className="flex items-center gap-1 text-sm">
        {path.map((segment: PathSegment, index: number) => (
          <React.Fragment key={segment.token}>
            {index > 0 ? (
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            ) : null}
            <Button
              variant={index === path.length - 1 ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-sm"
              onClick={() => enterFolder(segment)}
            >
              {segment.name}
            </Button>
          </React.Fragment>
        ))}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          加载失败：{error}
        </div>
      ) : (
        <Table
          rowKey="token"
          columns={columns}
          dataSource={data ?? []}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '当前文件夹为空' }}
        />
      )}

      <DriveInputDialog
        open={folderDialogOpen}
        title="新建文件夹"
        label="文件夹名称"
        submitting={dialogSubmitting}
        onCancel={() => setFolderDialogOpen(false)}
        onSubmit={(name: string) => {
          const parentToken = path.length > 0 ? path[path.length - 1].token : '';
          void runAction(async () => {
            const created = await createFolder(parentToken, name);
            toast.success(`已创建文件夹「${created.name}」`);
          }).then(() => setFolderDialogOpen(false));
        }}
      />
      <DriveInputDialog
        open={docDialogOpen}
        title="新建文档"
        label="文档标题"
        submitting={dialogSubmitting}
        onCancel={() => setDocDialogOpen(false)}
        onSubmit={(title: string) => {
          const folderToken = path.length > 0 ? path[path.length - 1].token : '';
          void runAction(async () => {
            const created = await createDocument(folderToken, title);
            toast.success(`已创建文档「${created.name}」`, {
              description: (
                <UniversalLink to={created.url} target="_blank" rel="noreferrer">
                  点击打开新文档
                </UniversalLink>
              ),
            });
          }).then(() => setDocDialogOpen(false));
        }}
      />
      <DriveInputDialog
        open={renameTarget !== null}
        title="重命名"
        label="新名称"
        defaultValue={renameTarget?.name ?? ''}
        submitting={dialogSubmitting}
        onCancel={() => setRenameTarget(null)}
        onSubmit={(name: string) => {
          if (!renameTarget) return;
          void runAction(async () => {
            const updated = await renameFile(renameTarget.token, renameTarget.type, name);
            toast.success(`已重命名为「${updated.name}」`);
          }).then(() => setRenameTarget(null));
        }}
      />
      <DriveInputDialog
        open={deleteTarget !== null}
        title="删除确认"
        label={`确认删除「${deleteTarget?.name ?? ''}」？输入 DELETE 确认`}
        submitText="删除"
        submitting={dialogSubmitting}
        onCancel={() => setDeleteTarget(null)}
        onSubmit={(value: string) => {
          if (!deleteTarget) return;
          if (value !== 'DELETE') {
            toast.error('请输入 DELETE 以确认删除');
            return;
          }
          void runAction(async () => {
            await deleteFile(deleteTarget.token, deleteTarget.type);
            toast.success(`已删除「${deleteTarget.name}」`);
          }).then(() => setDeleteTarget(null));
        }}
      />
    </PageShell>
  );
};

export default DrivePage;
