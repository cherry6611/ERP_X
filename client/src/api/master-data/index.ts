import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
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
  UpdateCustomerDto,
  UpdateSupplierDto,
} from '@shared/api.interface';

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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateCustomer(id: string, dto: UpdateCustomerDto): Promise<Customer> {
  const resp = await axiosForBackend.patch<Customer>(`/api/master-data/customers/${id}`, dto);
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateContact(contactId: string, dto: Partial<CreateContactDto>): Promise<CustomerContact> {
  const resp = await axiosForBackend.patch<CustomerContact>(
    `/api/master-data/contacts/${contactId}`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function deleteContact(contactId: string): Promise<void> {
  const resp = await axiosForBackend.delete(`/api/master-data/contacts/${contactId}`);
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateSupplier(id: string, dto: UpdateSupplierDto): Promise<Supplier> {
  const resp = await axiosForBackend.patch<Supplier>(`/api/master-data/suppliers/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}
