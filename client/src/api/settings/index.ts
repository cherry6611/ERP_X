import { axiosForBackend } from '@client/src/platform/request';
import type { BrandConfig, QuotationBitableConfig } from '@shared/api.interface';

export type { BrandConfig, QuotationBitableConfig };

export async function getBrand(): Promise<BrandConfig> {
  const resp = await axiosForBackend.get<BrandConfig>('/api/settings/brand');
  return resp.data;
}

export async function updateBrand(body: {
  brandName?: string;
  logoFileId?: string | null;
}): Promise<BrandConfig> {
  const resp = await axiosForBackend.put<BrandConfig>('/api/settings/brand', body);
  return resp.data;
}

export async function uploadBrandLogo(file: File): Promise<{ brand: BrandConfig }> {
  const form = new FormData();
  form.append('file', file);
  const resp = await axiosForBackend.post<{ brand: BrandConfig; error?: string }>(
    '/api/settings/brand/logo',
    form,
  );
  if (resp.data.error) throw new Error(resp.data.error);
  return { brand: resp.data.brand };
}

export async function getQuotationBitableConfig(): Promise<QuotationBitableConfig> {
  const resp = await axiosForBackend.get<QuotationBitableConfig>(
    '/api/settings/feishu-bitable/quotation',
  );
  return resp.data;
}

export async function upsertQuotationBitableConfig(body: {
  appToken: string;
  tableId: string;
  fieldMap?: Record<string, string>;
  enabled?: boolean;
}): Promise<QuotationBitableConfig> {
  const resp = await axiosForBackend.put<QuotationBitableConfig>(
    '/api/settings/feishu-bitable/quotation',
    body,
  );
  return resp.data;
}
