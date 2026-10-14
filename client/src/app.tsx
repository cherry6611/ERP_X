import React, { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';

import LoginPage from './pages/login/LoginPage';
import Layout from './components/Layout';
import { DataState } from './components/DataState';
import { ErrorRender } from '@client/src/platform/AppContainer';

function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ErrorRender
          error={error as Error}
          resetErrorBoundary={resetErrorBoundary}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

const NotFound = lazy(() => import('./pages/NotFound/NotFound'));
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const MetricsPage = lazy(() => import('./pages/dashboard/MetricsPage'));
// C-04 / D-02：应收应付票据（登记/持有/背书/贴现/到期收款/拒付 + 备查簿与到期预警）
const NotesPage = lazy(() => import('./pages/notes'));
const CustomersPage = lazy(() => import('./pages/customers/CustomersPage'));
const CrmPage = lazy(() => import('./pages/crm/CrmPage'));
const OpportunityDetailPage = lazy(
  () => import('./pages/crm/OpportunityDetailPage'),
);
const OpportunityCreatePage = lazy(
  () => import('./pages/crm/OpportunityCreatePage'),
);
const QuotationFormPage = lazy(() => import('./pages/crm/QuotationFormPage'));
const QuotationDetailPage = lazy(() => import('./pages/crm/QuotationDetailPage'));
const LeadDetailPage = lazy(() => import('./pages/crm/LeadDetailPage'));
const LeadCreatePage = lazy(() => import('./pages/crm/LeadCreatePage'));
const ContractsPage = lazy(() => import('./pages/contracts/ContractsPage'));
const ContractDetailPage = lazy(
  () => import('./pages/contracts/ContractDetailPage'),
);
const ContractCreatePage = lazy(
  () => import('./pages/contracts/ContractCreatePage'),
);
const InvoiceDetailPage = lazy(
  () => import('./pages/finance/InvoiceDetailPage'),
);
const InvoiceCreatePage = lazy(
  () => import('./pages/finance/InvoiceCreatePage'),
);
const RentContractDetailPage = lazy(
  () => import('./pages/admin-rent/RentContractDetailPage'),
);
const ExpenseClaimDetailPage = lazy(
  () => import('./pages/fin-expense/ExpenseClaimDetailPage'),
);
const ExpenseApplyDetailPage = lazy(
  () => import('./pages/fin-expense/ExpenseApplyDetailPage'),
);
const PurRequestDetailPage = lazy(
  () => import('./pages/pur/PurRequestDetailPage'),
);
const GrantDetailPage = lazy(() => import('./pages/data-asset/GrantDetailPage'));
const LeaveRequestDetailPage = lazy(
  () => import('./pages/hr/LeaveRequestDetailPage'),
);
const VoucherDetailPage = lazy(
  () => import('./pages/voucher/VoucherDetailPage'),
);
const SuppliersPage = lazy(() => import('./pages/suppliers/SuppliersPage'));
const TaxEntitiesPage = lazy(() => import('./pages/masterdata/TaxEntities'));
const ProjectsPage = lazy(() => import('./pages/projects/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('./pages/projects/ProjectDetailPage'));
const ProjectCreatePage = lazy(() => import('./pages/projects/ProjectCreatePage'));
const ProjectEditPage = lazy(() => import('./pages/projects/ProjectEditPage'));
const CostsPage = lazy(() => import('./pages/costs/CostsPage'));
const RevenuePage = lazy(() => import('./pages/revenues/RevenuePage'));
const FinancePage = lazy(() => import('./pages/finance/FinancePage'));
const AuditPage = lazy(() => import('./pages/audit/AuditPage'));
const HrPage = lazy(() => import('./pages/hr'));
const FinExpensePage = lazy(() => import('./pages/fin-expense'));
const PurPage = lazy(() => import('./pages/pur'));
const AssetPage = lazy(() => import('./pages/asset/AssetPage'));
const VoucherPage = lazy(() => import('./pages/voucher/VoucherPage'));
const DataAssetPage = lazy(() => import('./pages/data-asset/DataAssetPage'));
const AdminRentPage = lazy(() => import('./pages/admin-rent'));
const AdminBillsPage = lazy(() => import('./pages/admin-bills'));
const AdminAssetsPage = lazy(() => import('./pages/admin-assets'));
const AdminAffairsPage = lazy(() => import('./pages/admin-affairs'));
const AdminAutomationPage = lazy(() => import('./pages/admin-automation'));
const DrivePage = lazy(() => import('./pages/drive'));
const WikiPage = lazy(() => import('./pages/wiki'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const ReportsPage = lazy(() => import('./pages/finance/reports/ReportsPage'));
const LedgersPage = lazy(() => import('./pages/finance/ledgers/LedgersPage'));
const TaxDeclarationPage = lazy(
  () => import('./pages/finance/tax-declaration/TaxDeclarationPage'),
);
const YearEndPage = lazy(() => import('./pages/finance/year-end/YearEndPage'));

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-6">
      <div className="w-full max-w-md">
        <DataState loading skeleton="default" />
      </div>
    </div>
  );
}

const RoutesComponent = () => {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          element={
            <RouteErrorBoundary>
              <Layout />
            </RouteErrorBoundary>
          }
        >
          <Route index element={<DashboardPage />} />
          {/* D-12：指标中心（口径说明 / 上期对比 / 下钻 / 预警订阅） */}
          <Route path="bi/metrics" element={<MetricsPage />} />
          {/* C-04 / D-02：应收应付票据 */}
          <Route path="notes" element={<NotesPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="crm" element={<CrmPage />} />
          <Route path="crm/leads/new" element={<LeadCreatePage />} />
          <Route path="crm/leads/:id" element={<LeadDetailPage />} />
          <Route path="crm/opportunities/new" element={<OpportunityCreatePage />} />
          <Route
            path="crm/opportunities/:id"
            element={<OpportunityDetailPage />}
          />
          <Route
            path="crm/opportunities/:opportunityId/quotations/new"
            element={<QuotationFormPage />}
          />
          <Route path="crm/quotations/:id" element={<QuotationDetailPage />} />
          <Route path="crm/quotations/:id/edit" element={<QuotationFormPage />} />
          <Route path="contracts" element={<ContractsPage />} />
          <Route path="contracts/new" element={<ContractCreatePage />} />
          <Route path="contracts/:id" element={<ContractDetailPage />} />
          <Route path="finance/invoices/new" element={<InvoiceCreatePage />} />
          <Route path="finance/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="masterdata/tax-entities" element={<TaxEntitiesPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/new" element={<ProjectCreatePage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="projects/:id/edit" element={<ProjectEditPage />} />
          <Route path="costs" element={<CostsPage />} />
          <Route path="revenue" element={<RevenuePage />} />
          <Route path="finance" element={<FinancePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="hr" element={<HrPage />} />
          <Route path="hr/leaves/:id" element={<LeaveRequestDetailPage />} />
          <Route path="fin-expense" element={<FinExpensePage />} />
          <Route
            path="fin-expense/applies/:id"
            element={<ExpenseApplyDetailPage />}
          />
          <Route
            path="fin-expense/claims/:id"
            element={<ExpenseClaimDetailPage />}
          />
          <Route path="pur" element={<PurPage />} />
          <Route path="pur/requests/:id" element={<PurRequestDetailPage />} />
          <Route path="asset" element={<AssetPage />} />
          <Route path="voucher" element={<VoucherPage />} />
          <Route path="voucher/:id" element={<VoucherDetailPage />} />
          <Route path="data-asset" element={<DataAssetPage />} />
          <Route path="data-asset/grants/:id" element={<GrantDetailPage />} />
          <Route path="admin-rent" element={<AdminRentPage />} />
          <Route path="admin-rent/:id" element={<RentContractDetailPage />} />
          <Route path="admin-bills" element={<AdminBillsPage />} />
          <Route path="admin-assets" element={<AdminAssetsPage />} />
          <Route path="admin-affairs" element={<AdminAffairsPage />} />
          <Route path="admin-automation" element={<AdminAutomationPage />} />
          <Route path="drive" element={<DrivePage />} />
          <Route path="wiki" element={<WikiPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="finance/reports" element={<ReportsPage />} />
          <Route path="finance/ledgers" element={<LedgersPage />} />
          <Route path="finance/tax-declaration" element={<TaxDeclarationPage />} />
          <Route path="finance/year-end" element={<YearEndPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
};

export default RoutesComponent;
