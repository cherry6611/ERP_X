import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@client/src/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@client/src/components/ui/sheet';
import { PROJECT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import type { Project } from '@shared/api.interface';

interface ProjectQuickViewDrawerProps {
  project: Project | null;
  onOpenChange: (open: boolean) => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <>
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 break-words">{children}</span>
  </>
);

/** 项目列表快速查看；完整工作台仍进入项目详情页。 */
const ProjectQuickViewDrawer: React.FC<ProjectQuickViewDrawerProps> = ({
  project,
  onOpenChange,
}) => {
  const navigate = useNavigate();

  return (
    <Sheet open={project !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[560px] gap-0 bg-card p-0 sm:max-w-[560px]"
      >
        <SheetHeader className="h-14 flex-row items-center border-b border-border/80 px-5 py-0">
          <SheetTitle className="text-[14px]">项目快速查看</SheetTitle>
        </SheetHeader>
        {project ? (
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
            <div>
              <p className="text-[11px] text-muted-foreground">{project.code}</p>
              <h2 className="mt-1 text-[18px] font-semibold leading-6">
                {project.name}
              </h2>
              <div className="mt-2">
                <StatusBadge
                  status={project.status}
                  labels={PROJECT_STATUS_LABELS}
                />
              </div>
            </div>
            <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-3 text-[12px]">
              <Row label="关联合同">{project.contractName ?? '-'}</Row>
              <Row label="成交报价">
                {project.wonQuotationCode ?? '-'}
                {project.wonQuotationAmount != null
                  ? ` · ${formatMoney(project.wonQuotationAmount)}`
                  : ''}
              </Row>
              <Row label="项目经理">{project.pm ?? '-'}</Row>
              <Row label="所属部门">{project.deptName ?? '-'}</Row>
              <Row label="预算基线">
                <span className="tabular-nums">{formatMoney(project.budget)}</span>
              </Row>
              <Row label="进度">{formatPercent(project.progress)}</Row>
              <Row label="开始日期">{project.startDate ?? '-'}</Row>
              <Row label="结束日期">{project.endDate ?? '-'}</Row>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-border/80 px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            onClick={() => {
              if (project) navigate(`/projects/${project.id}`);
            }}
          >
            <ExternalLink className="mr-1.5 size-4" />
            打开完整详情
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default ProjectQuickViewDrawer;
