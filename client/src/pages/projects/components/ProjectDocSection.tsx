/*
 * §5.9（F8）：本文件原先自带的声明块与两段 JSX 已拆到同目录：
 *   · `./project-doc-model` —— 零 React 依赖的声明（文档类型枚举与解析、
 *     同步状态徽标表、新增文档表单 schema）；
 *   · `./ProjectDocList` —— 列表区（加载态 / 空态 / 每条文档行 / 同步状态页脚），
 *     删除链路的编排（`handleDelete`）仍留在本文件；
 *   · `./dialogs/AddProjectDocDialog` —— 「新增项目文档」弹窗（表单 JSX、
 *     上传/登记两个分支的提交处理器、文件选择）。
 *
 * 搬走的理由是体量：占行数的从来不是声明，而是**弹窗 JSX + 提交处理器（约 163 行）
 * 与列表渲染（约 111 行）**。本文件现在只保留区块级编排：
 *   · 数据查询（`listAttachments` / `getProjectDriveSyncStatus`）与它们的重取；
 *   · `items` / `loading` / `deletingId` / `syncStatus` / `syncing` 与
 *     `syncStatusMap`；
 *   · `handleSyncDrive` 与 `handleDelete`（后者是"确认 + 兼容清理云空间文件 +
 *     删除 + 重取 + `onChanged`"的编排，`items` / `deletingId` 的写入点都在这里）；
 *   · 卡片头部（标题计数、同步到云空间、新增文档）与**打开弹窗时的重置**。
 *
 * ⚠️ 四个必须保住的语义（搬迁时逐条核对）：
 *   ① **`docForm` / `selectedFile` / `fileError` 三个 state 留在本文件**，因为它们
 *      唯一的"清零"触发点就在这里 —— `openDialog` 里那三行（原实现是
 *      `form.reset()` / `setSelectedFile(null)` / `setFileError(null)`）。
 *      按"触发点在父组件就以下沉同名 props 传递"的做法，弹窗拿的是
 *      `form={docForm}` 这个**同一个** `useForm` 实例、以及
 *      `selectedFile={selectedFile}` / `setSelectedFile={setSelectedFile}` /
 *      `fileError={fileError}` / `setFileError={setFileError}` 这四个**同名** props
 *      —— 而**不是**把它们搬进子组件后用 `useEffect` 监听 `open` 去复现
 *      （那会多出一次"关闭也重置"的语义，属于行为变更）。
 *      `submitting` 与 `fileInputRef` 是纯弹窗内部状态（`submitting` 在 `finally`
 *      里复位、`fileInputRef` 从不需要清零），故随弹窗走。
 *   ② **重置时机逐字保持**：`docForm.reset()` → `setSelectedFile(null)` →
 *      `setFileError(null)` → `setDialogOpen(true)`，顺序与触发点（「新增文档」
 *      按钮）都未动。**没有新增任何重置** —— 关闭弹窗不重置（原实现也不重置）。
 *      弹窗那一侧只把 `dialogOpen` / `setDialogOpen` 改名成 `open` /
 *      `onOpenChange` 两个 Radix 惯例 prop（`open={dialogOpen}` /
 *      `onOpenChange={setDialogOpen}`），写入点仍只有原实现的 `onSubmit` 末尾
 *      与「取消」按钮两处。
 *   ③ **`syncStatusMap` 仍由 `useMemo` 记忆化**，依赖仍是 `[syncStatus]`
 *      （见下）；列表组件拿的是这个 **Map 本身**，不是每次渲染新建的对象；
 *   ④ 用户可见字符串逐字未动 —— 标题计数、两个按钮、空态文案、弹窗内全部文案
 *      都保持原样。
 *
 * ⚠️ 弹窗**无条件挂载**（只切 `open` prop），不写
 * `{dialogOpen && <AddProjectDocDialog />}`：条件挂载会在关闭时立刻卸载 Radix
 * 内容（跳过退场动画），也会改动弹窗内部 state 的生命周期 —— 而
 * `selectedFile` / `fileError` / `submitting` 原先常驻在 Section 上，跨开关存活。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { getDataloom } from '@client/src/platform/storage';
import { getDefaultBucketId } from '@client/src/platform/storage';
import { logger } from '@client/src/platform/logger';
import { CanRole } from '@client/src/platform/auth';
import { CloudUpload, Loader2, Paperclip, Plus } from 'lucide-react';
import { MAX_ATTACHMENT_COUNT } from '@client/src/components/attachments/AttachmentField';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@client/src/components/ui/card';
import {
  deleteAttachment,
  listAttachments,
} from '@client/src/api/attachments';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import {
  getProjectDriveSyncStatus,
  syncProjectDrive,
} from '@client/src/api/projects';
import type {
  Attachment,
  DriveSyncStatusItem,
  ProjectDriveSyncStatus,
} from '@shared/api.interface';
import { docFormSchema, type DocFormData } from './project-doc-model';
import ProjectDocList from './ProjectDocList';
import AddProjectDocDialog from './dialogs/AddProjectDocDialog';

interface ProjectDocSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const ProjectDocSection: React.FC<ProjectDocSectionProps> = ({
  projectId,
  onChanged,
}) => {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<ProjectDriveSyncStatus | null>(
    null,
  );

  /*
   * 「新增文档」表单实例。**刻意留在本文件**：打开弹窗时的重置
   * （`openDialog` 的 `docForm.reset()`）是父组件的触发点，实例搬进弹窗后就只能
   * 用 `useEffect` 监听 `open` 去复现，那会改变重置的触发语义。弹窗按"同名 props
   * 下沉"接收它（`form={docForm}`），因此 `useForm` 状态仍与原实现一样常驻。
   */
  const docForm = useForm<DocFormData>({
    resolver: zodResolver(docFormSchema),
    defaultValues: {
      docType: 'requirement',
      mode: 'upload',
      docTitle: '',
      docUrl: '',
    },
  });

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listAttachments('erp_project', projectId));
    } catch (err) {
      logger.error('获取项目文档列表失败', err);
      toast.error('获取项目文档列表失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getProjectDriveSyncStatus(projectId));
    } catch (err) {
      logger.error('获取云空间同步状态失败', err);
      toast.error('获取云空间同步状态失败');
    }
  }, [projectId]);

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  /*
   * 附件 id → 同步状态。**保持 `useMemo`**（依赖仍是 `[syncStatus]`）：列表组件
   * 拿的是这个 Map 本身，若改成每次渲染现建一个 Map，会改变下行 prop 的引用
   * 稳定性 —— 那是拆分之外的行为改动面。
   */
  const syncStatusMap = useMemo(() => {
    const map = new Map<string, DriveSyncStatusItem>();
    for (const item of syncStatus?.items ?? []) {
      map.set(item.attachmentId, item);
    }
    return map;
  }, [syncStatus]);

  const handleSyncDrive = async () => {
    setSyncing(true);
    try {
      const result = await syncProjectDrive(projectId);
      toast.success(
        `已同步 ${result.syncedFiles} 个文件，跳过 ${result.skippedFiles} 个，失败 ${result.failedFiles} 个`,
      );
      if (result.wikiPermissionDenied) {
        toast.warning('知识库未授权，归档文档暂在云空间项目目录中');
      }
      await fetchSyncStatus();
    } catch (err) {
      logger.error('同步到云空间失败', err);
      toast.error(err instanceof Error ? err.message : '同步到云空间失败');
    } finally {
      setSyncing(false);
    }
  };

  const openDialog = () => {
    docForm.reset();
    setSelectedFile(null);
    setFileError(null);
    setDialogOpen(true);
  };

  const handleDelete = async (item: Attachment) => {
    const ok = await confirmDanger(
      `确认删除文档「${item.fileName}」？此操作不可恢复。`,
      { title: '确认删除' },
    );
    if (!ok) return;
    setDeletingId(item.id);
    try {
      if (item.sourceType !== 'feishu_doc') {
        const dataloom = await getDataloom();
        await dataloom.storage.from(getDefaultBucketId()).remove([item.fileUrl]);
      }
      await deleteAttachment(item.id);
      toast.success('文档已删除');
      await fetchList();
      onChanged?.();
    } catch (err) {
      logger.error('项目文档删除失败', err);
      toast.error(err instanceof Error ? err.message : '文档删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreated = async () => {
    await fetchList();
    onChanged?.();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          项目文档与资料（{items.length}/{MAX_ATTACHMENT_COUNT}）
        </CardTitle>
        <div className="flex items-center gap-2">
          <CanRole roles={['admin']}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={() => void handleSyncDrive()}
            >
              {syncing ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CloudUpload className="mr-1 h-4 w-4" />
              )}
              {syncing ? '同步中...' : '同步到云空间'}
            </Button>
          </CanRole>
          <Button type="button" size="sm" onClick={openDialog}>
            <Plus className="mr-1 h-4 w-4" />
            新增文档
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ProjectDocList
          items={items}
          loading={loading}
          syncStatusMap={syncStatusMap}
          syncStatus={syncStatus}
          deletingId={deletingId}
          onDelete={handleDelete}
        />
      </CardContent>

      <AddProjectDocDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        items={items}
        form={docForm}
        selectedFile={selectedFile}
        setSelectedFile={setSelectedFile}
        fileError={fileError}
        setFileError={setFileError}
        onCreated={handleCreated}
      />
    </Card>
  );
};

export default ProjectDocSection;
