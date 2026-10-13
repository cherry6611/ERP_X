import React, { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';

import LoginPage from './pages/login/LoginPage';
import Layout from './components/Layout';

const NotFound = lazy(() => import('./pages/NotFound/NotFound'));
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const CustomersPage = lazy(() => import('./pages/customers/CustomersPage'));
const CrmPage = lazy(() => import('./pages/crm/CrmPage'));
const ContractsPage = lazy(() => import('./pages/contracts/ContractsPage'));
const SuppliersPage = lazy(() => import('./pages/suppliers/SuppliersPage'));
const TaxEntitiesPage = lazy(() => import('./pages/masterdata/TaxEntities'));
const ProjectsPage = lazy(() => import('./pages/projects/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('./pages/projects/ProjectDetailPage'));
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

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
      加载中…
    </div>
  );
}

const RoutesComponent = () => {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="crm" element={<CrmPage />} />
          <Route path="contracts" element={<ContractsPage />} />
          <Route path="masterdata/tax-entities" element={<TaxEntitiesPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="costs" element={<CostsPage />} />
          <Route path="revenue" element={<RevenuePage />} />
          <Route path="finance" element={<FinancePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="hr" element={<HrPage />} />
          <Route path="fin-expense" element={<FinExpensePage />} />
          <Route path="pur" element={<PurPage />} />
          <Route path="asset" element={<AssetPage />} />
          <Route path="voucher" element={<VoucherPage />} />
          <Route path="data-asset" element={<DataAssetPage />} />
          <Route path="admin-rent" element={<AdminRentPage />} />
          <Route path="admin-bills" element={<AdminBillsPage />} />
          <Route path="admin-assets" element={<AdminAssetsPage />} />
          <Route path="admin-affairs" element={<AdminAffairsPage />} />
          <Route path="admin-automation" element={<AdminAutomationPage />} />
          <Route path="drive" element={<DrivePage />} />
          <Route path="wiki" element={<WikiPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
};

export default RoutesComponent;
