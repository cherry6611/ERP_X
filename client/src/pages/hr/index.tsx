import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import HrOverviewPanel from './components/HrOverviewPanel';
import EmployeePanel from './components/EmployeePanel';
import AttendancePanel from './components/AttendancePanel';
import PayrollPanel from './components/PayrollPanel';
import RecruitPanel from './components/RecruitPanel';
import AppraisalPanel from './components/AppraisalPanel';
import TrainingPanel from './components/TrainingPanel';
import MyHrPanel from './components/MyHrPanel';
import IdentityPanel from './components/IdentityPanel';
import { useAuth } from '@client/src/platform/auth';

const HR_TABS = [
  { key: 'identity', label: '身份管理', capability: 'identity' },
  { key: 'employees', label: '员工档案', capability: 'hr' },
  { key: 'attendance', label: '考勤与请假', capability: 'hr' },
  { key: 'payroll', label: '薪酬管理', capability: 'hr' },
  { key: 'recruit', label: '招聘管理', capability: 'hr' },
  { key: 'appraisal', label: '绩效考核', capability: 'hr' },
  { key: 'training', label: '培训管理', capability: 'hr' },
  { key: 'my', label: '我的' },
] as const;

const HR_TAB_CONTENT: Record<string, React.ReactNode> = {
  identity: <IdentityPanel />,
  employees: <EmployeePanel />,
  attendance: <AttendancePanel />,
  payroll: <PayrollPanel />,
  recruit: <RecruitPanel />,
  appraisal: <AppraisalPanel />,
  training: <TrainingPanel />,
  my: <MyHrPanel />,
};

const HrPage: React.FC = () => {
  const { hasCapability } = useAuth();
  const tabs = HR_TABS.filter(
    (item) =>
      !('capability' in item && item.capability) ||
      hasCapability(item.capability),
  );
  const defaultTab = hasCapability('identity')
    ? 'identity'
    : hasCapability('hr')
      ? 'employees'
      : 'my';
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? defaultTab;
  const tab = tabs.some((t) => t.key === raw) ? raw : defaultTab;

  return (
    <PageShell
      title="人力资源"
      description="组织与员工档案、身份与账号、考勤请假、薪酬、招聘、绩效与培训管理"
    >
      <HrOverviewPanel />
      <div className="flex gap-2 flex-wrap">
        {tabs.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (item.key === defaultTab) next.delete('tab');
                  else next.set('tab', item.key);
                  return next;
                },
                { replace: true },
              );
            }}
            className={cn(
              tab === item.key
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-foreground/80',
            )}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div>{HR_TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default HrPage;
