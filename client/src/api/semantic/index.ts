import { axiosForBackend } from '@client/src/platform/request';
import type { SemanticBizType, SemanticSimilarItem } from '@shared/api.interface';

export async function fetchSimilarItems(
  type: SemanticBizType,
  id: string,
  limit = 5
): Promise<SemanticSimilarItem[]> {
  const resp = await axiosForBackend.get<{
    items: SemanticSimilarItem[];
  }>('/api/semantic/similar', {
    params: { type, id, limit },
  });
  return resp.data.items;
}
