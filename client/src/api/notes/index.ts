import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  CreateNoteDto,
  NoteAction,
  NoteActionDto,
  NoteDiscountPreview,
  NoteDueAlert,
  NoteItem,
  NoteListParams,
  NoteLogItem,
  NoteRegisterResult,
  NoteStatus,
  NoteType,
  PagedResult,
} from '@shared/api.interface';

/* ========== C-04 / D-02：应收应付票据 ========== */

export async function listNotes(
  params?: NoteListParams,
): Promise<PagedResult<NoteItem>> {
  const resp = await axiosForBackend.get<PagedResult<NoteItem>>('/api/notes', {
    params,
  });
  return resp.data;
}

/** 状态/类型/动作字典：前端据此渲染操作按钮，不硬编码状态机 */
export async function getNoteDictionaries(): Promise<{
  statuses: Array<{ value: NoteStatus; label: string }>;
  types: Array<{ value: NoteType; label: string }>;
  actions: Array<{
    value: NoteAction;
    label: string;
    target: NoteStatus;
    requiresCounterparty: boolean;
    requiresRate: boolean;
  }>;
}> {
  const resp = await axiosForBackend.get<{
    statuses: Array<{ value: NoteStatus; label: string }>;
    types: Array<{ value: NoteType; label: string }>;
    actions: Array<{
      value: NoteAction;
      label: string;
      target: NoteStatus;
      requiresCounterparty: boolean;
      requiresRate: boolean;
    }>;
  }>('/api/notes/dictionaries');
  return resp.data;
}

/** D-02 票据备查簿 */
export async function getNoteRegister(): Promise<NoteRegisterResult> {
  const resp = await axiosForBackend.get<NoteRegisterResult>(
    '/api/notes/register',
  );
  return resp.data;
}

/** D-02 到期预警 */
export async function getNoteDueAlerts(): Promise<NoteDueAlert[]> {
  const resp = await axiosForBackend.get<NoteDueAlert[]>(
    '/api/notes/due-alerts',
  );
  return resp.data;
}

export async function getDiscountBasis(): Promise<{
  basis: number;
  note: string;
}> {
  const resp = await axiosForBackend.get<{ basis: number; note: string }>(
    '/api/notes/discount-basis',
  );
  return resp.data;
}

export async function getNote(id: string): Promise<NoteItem> {
  const resp = await axiosForBackend.get<NoteItem>(`/api/notes/${id}`);
  return resp.data;
}

export async function listNoteLogs(id: string): Promise<NoteLogItem[]> {
  const resp = await axiosForBackend.get<NoteLogItem[]>(
    `/api/notes/${id}/logs`,
  );
  return resp.data;
}

export async function getLinkedDocument(id: string): Promise<{
  ar: { code: string; amount: number; settledAmount: number } | null;
  ap: { code: string; amount: number; paidAmount: number } | null;
}> {
  const resp = await axiosForBackend.get<{
    ar: { code: string; amount: number; settledAmount: number } | null;
    ap: { code: string; amount: number; paidAmount: number } | null;
  }>(`/api/notes/${id}/linked-document`);
  return resp.data;
}

/** 贴现试算：提交前确认息费、到账额与分录 */
export async function previewNoteDiscount(
  id: string,
  discountRate: number,
  discountDate?: string,
): Promise<NoteDiscountPreview> {
  const resp = await axiosForBackend.post<NoteDiscountPreview>(
    `/api/notes/${id}/discount-preview`,
    { discountRate, discountDate },
  );
  return resp.data;
}

export async function createNote(dto: CreateNoteDto): Promise<NoteItem> {
  const resp = await axiosForBackend.post<NoteItem>('/api/notes', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function noteAction(
  id: string,
  dto: NoteActionDto,
): Promise<NoteItem> {
  const resp = await axiosForBackend.post<NoteItem>(
    `/api/notes/${id}/actions`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}
