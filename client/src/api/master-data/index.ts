import { axiosForBackend } from '@client/src/platform/request';
import type {
  Customer,
  CustomerContact,
  CreditSummary,
  CreateContactDto,
  CreateCustomerDto,
  CreateSupplierDto,
  Employee,
  PagedResult,
  Supplier,
  TaxEntity,
  UpdateCustomerDto,
  UpdateSupplierDto,
} from '@shared/api.interface';

export type { TaxEntity };

export async function listCustomers(keyword?: string): Promise<Customer[]> {
  const resp = await axiosForBackend.get<PagedResult<Customer>>(
    '/api/master-data/customers',
    {
      params: { page: 1, pageSize: 500, ...(keyword ? { keyword } : {}) },
    },
  );
  return resp.data.items;
}

export async function listCustomersPaged(
  page: number,
  pageSize: number,
  keyword?: string
): Promise<PagedResult<Customer>> {
  const resp = await axiosForBackend.get<PagedResult<Customer>>(
    '/api/master-data/customers',
    {
      params: { page, pageSize, ...(keyword ? { keyword } : {}) },
    },
  );
  return resp.data;
}

export async function createCustomer(dto: CreateCustomerDto): Promise<Customer> {
  const resp = await axiosForBackend.post<Customer>('/api/master-data/customers', dto);
  return resp.data;
}

export async function updateCustomer(id: string, dto: UpdateCustomerDto): Promise<Customer> {
  const resp = await axiosForBackend.patch<Customer>(`/api/master-data/customers/${id}`, dto);
  return resp.data;
}

export async function setCustomerStatus(
  id: string,
  status: 'active' | 'inactive'
): Promise<Customer> {
  const resp = await axiosForBackend.patch<Customer>(
    `/api/master-data/customers/${id}/status`,
    { status }
  );
  return resp.data;
}

export async function listContacts(customerId: string): Promise<CustomerContact[]> {
  const resp = await axiosForBackend.get<CustomerContact[]>(
    `/api/master-data/customers/${customerId}/contacts`,
  );
  return resp.data;
}

export async function createContact(customerId: string, dto: CreateContactDto): Promise<CustomerContact> {
  const resp = await axiosForBackend.post<CustomerContact>(
    `/api/master-data/customers/${customerId}/contacts`,
    dto,
  );
  return resp.data;
}

export async function updateContact(contactId: string, dto: Partial<CreateContactDto>): Promise<CustomerContact> {
  const resp = await axiosForBackend.patch<CustomerContact>(
    `/api/master-data/contacts/${contactId}`,
    dto,
  );
  return resp.data;
}

export async function deleteContact(contactId: string): Promise<void> {
  const resp = await axiosForBackend.delete(`/api/master-data/contacts/${contactId}`);
}

export async function getCredit(customerId: string): Promise<CreditSummary> {
  const resp = await axiosForBackend.get<CreditSummary>(
    `/api/master-data/customers/${customerId}/credit`,
  );
  return resp.data;
}

export async function listEmployees(): Promise<Employee[]> {
  const resp = await axiosForBackend.get<Employee[]>('/api/master-data/employees');
  return resp.data;
}

export async function listSuppliers(keyword?: string): Promise<Supplier[]> {
  const resp = await axiosForBackend.get<Supplier[]>('/api/master-data/suppliers', {
    params: keyword ? { keyword } : undefined,
  });
  return resp.data;
}

export async function createSupplier(dto: CreateSupplierDto): Promise<Supplier> {
  const resp = await axiosForBackend.post<Supplier>('/api/master-data/suppliers', dto);
  return resp.data;
}

export async function listTaxEntities(): Promise<TaxEntity[]> {
  const resp = await axiosForBackend.get<TaxEntity[]>('/api/master-data/tax-entities');
  return resp.data;
}

export async function createTaxEntity(
  dto: Omit<TaxEntity, 'id' | 'isDefault' | 'status'>
): Promise<TaxEntity> {
  const resp = await axiosForBackend.post<TaxEntity>('/api/master-data/tax-entities', dto);
  return resp.data;
}

export async function updateTaxEntity(
  id: string,
  dto: Partial<Omit<TaxEntity, 'id' | 'isDefault' | 'status'>>
): Promise<TaxEntity> {
  const resp = await axiosForBackend.patch<TaxEntity>(
    `/api/master-data/tax-entities/${id}`,
    dto
  );
  return resp.data;
}

export async function setDefaultTaxEntity(id: string): Promise<TaxEntity> {
  const resp = await axiosForBackend.post<TaxEntity>(
    `/api/master-data/tax-entities/${id}/set-default`
  );
  return resp.data;
}

export async function toggleTaxEntityStatus(id: string): Promise<TaxEntity> {
  const resp = await axiosForBackend.post<TaxEntity>(
    `/api/master-data/tax-entities/${id}/toggle-status`
  );
  return resp.data;
}

export async function updateSupplier(id: string, dto: UpdateSupplierDto): Promise<Supplier> {
  const resp = await axiosForBackend.patch<Supplier>(`/api/master-data/suppliers/${id}`, dto);
  return resp.data;
}

export async function setSupplierStatus(
  id: string,
  status: 'active' | 'inactive'
): Promise<Supplier> {
  const resp = await axiosForBackend.patch<Supplier>(
    `/api/master-data/suppliers/${id}/status`,
    { status }
  );
  return resp.data;
}
