import { axiosForBackend } from '@client/src/platform/request';
import type {
  CreateIdentityUserDto,
  IdentityUser,
  ListIdentityUsersParams,
} from '@shared/api.interface';

export type { IdentityUser };

export async function listUsers(params?: ListIdentityUsersParams) {
  const resp = await axiosForBackend.get<IdentityUser[]>('/api/identity/users', { params });
  return resp.data;
}

export async function createUser(body: CreateIdentityUserDto) {
  const resp = await axiosForBackend.post<IdentityUser>('/api/identity/users', body);
  return resp.data;
}

export async function setStatus(id: string, status: 'active' | 'disabled') {
  await axiosForBackend.patch(`/api/identity/users/${id}/status`, { status });
}

export async function setRoles(id: string, roles: string[]) {
  await axiosForBackend.put(`/api/identity/users/${id}/roles`, { roles });
}

export async function resetPassword(id: string, password?: string) {
  const resp = await axiosForBackend.post<{ temporaryPassword: string }>(
    `/api/identity/users/${id}/reset-password`,
    { password },
  );
  return resp.data;
}

export async function createFeishuInvite(id: string) {
  const resp = await axiosForBackend.post<{ token: string; inviteUrl: string; expiresAt: string }>(
    `/api/identity/users/${id}/feishu/invite`,
  );
  return resp.data;
}

export async function unbindFeishu(id: string) {
  await axiosForBackend.delete(`/api/identity/users/${id}/feishu`);
}

export async function revokeAllSessions(id: string) {
  await axiosForBackend.post(`/api/identity/users/${id}/sessions/revoke-all`);
}
