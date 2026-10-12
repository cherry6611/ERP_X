import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import HrOverviewPanel from './components/HrOverviewPanel';
import EmployeePanel from './components/EmployeePanel';
import AttendancePanel from './components/AttendancePanel';
import PayrollPanel from './components/PayrollPanel';
import RecruitPanel from './components/RecruitPanel';
import AppraisalPanel from './components/AppraisalPanel';
import TrainingPanel from './components/TrainingPanel';
import MyHrPanel from './components/MyHrPanel';

const HR_TABS = [
  { key: 'employees', label: '员工档案' },
  { key: 'attendance', label: '考勤与请假' },
  { key: 'payroll', label: '薪酬管理' },
  { key: 'recruit', label: '招聘管理' },
  { key: 'appraisal', label: '绩效考核' },
  { key: 'training', label: '培训管理' },
  { key: 'my', label: '我的' },
] as const;

const HR_TAB_CONTENT: Record<string, React.ReactNode> = {
  employees: <EmployeePanel />,
  attendance: <AttendancePanel />,
  payroll: <PayrollPanel />,
  recruit: <RecruitPanel />,
  appraisal: <AppraisalPanel />,
  training: <TrainingPanel />,
  my: <MyHrPanel />,
};

const HrPage: React.FC = () => {
  const [tab, setTab] = useState<string>('employees');

  return (
    <PageShell
      title="人力资源"
      description="组织与员工档案、考勤请假、薪酬、招聘、绩效与培训管理"
    >
      <HrOverviewPanel />
      <div className="flex gap-2 flex-wrap">
        {HR_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === item.key
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-foreground/80 hover:bg-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div>{HR_TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default HrPage;
