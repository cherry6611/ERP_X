import { CanRole } from '@server/platform';

export const FinanceRead = () => CanRole(['admin', 'finance_viewer']);

export const HrRead = () => CanRole(['admin', 'hr_manager']);

export const AdminRead = () => CanRole(['admin']);

export const DriveEditor = () => CanRole(['admin', 'drive_editor']);

export const ProjectWrite = () => CanRole(['admin', 'project_manager']);
