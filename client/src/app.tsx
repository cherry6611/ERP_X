import React from 'react';
import { Route, Routes } from 'react-router-dom';

import LoginPage from './pages/login/LoginPage';
import Layout from './components/Layout';
import NotFound from './pages/NotFound/NotFound';
import DashboardPage from './pages/dashboard/DashboardPage';
import CustomersPage from './pages/customers/CustomersPage';
import CrmPage from './pages/crm/CrmPage';
import ContractsPage from './pages/contracts/ContractsPage';
import SuppliersPage from './pages/suppliers/SuppliersPage';
import ProjectsPage from './pages/projects/ProjectsPage';
import ProjectDetailPage from './pages/projects/ProjectDetailPage';
import CostsPage from './pages/costs/CostsPage';
import RevenuePage from './pages/revenues/RevenuePage';
import FinancePage from './pages/finance/FinancePage';
import AuditPage from './pages/audit/AuditPage';
import HrPage from './pages/hr';
import FinExpensePage from './pages/fin-expense';
import PurPage from './pages/pur';
import AssetPage from './pages/asset/AssetPage';
import VoucherPage from './pages/voucher/VoucherPage';
import DataAssetPage from './pages/data-asset/DataAssetPage';
import AdminRentPage from './pages/admin-rent';
import AdminBillsPage from './pages/admin-bills';
import AdminAssetsPage from './pages/admin-assets';
import AdminAffairsPage from './pages/admin-affairs';
import AdminAutomationPage from './pages/admin-automation';
import DrivePage from './pages/drive';
import WikiPage from './pages/wiki';

const RoutesComponent = () => {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="crm" element={<CrmPage />} />
        <Route path="contracts" element={<ContractsPage />} />
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
  );
};

export default RoutesComponent;
