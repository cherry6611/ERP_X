'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { fetchUserProfile } from '@client/src/components/business-ui/api/user-profiles/service';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import type { UserInput } from '@client/src/components/business-ui/types/user';

interface UserProfileProps {
  readonly value?: string | UserInput;
  readonly userId?: string | undefined;
  readonly user_id?: string | undefined;
  readonly accountType?: 'apaas' | 'lark' | undefined;
}

interface ProfileInfo {
  name?: string;
  avatar?: string;
  email?: string;
  userStatus: number;
  userType: '_employee' | '_externalUser';
}

function readUserId(props: UserProfileProps): string {
  if (typeof props.value === 'string') return props.value;
  if (props.value && typeof props.value === 'object' && 'user_id' in props.value) {
    return props.value.user_id ?? '';
  }
  return props.userId || props.user_id || '';
}

function UserProfile(props: UserProfileProps) {
  const userId = readUserId(props);
  const [info, setInfo] = useState<ProfileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const data = await fetchUserProfile(userId, props.accountType);
      setInfo(data.userProfileInfo);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [userId, props.accountType]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card className="flex h-40 w-80 items-center justify-center border-0">
        <Spinner className="size-8 text-primary" />
      </Card>
    );
  }
  if (error || !info) {
    return (
      <Card className="flex w-80 flex-col items-center gap-2 border-0 p-4">
        <span className="text-sm">加载失败</span>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          重试
        </Button>
      </Card>
    );
  }
  return (
    <Card className="flex w-80 flex-col gap-0 overflow-hidden border-0 p-0">
      <div className="h-24 bg-muted" />
      <CardContent className="p-4">
        <Avatar className="-mt-10 size-16 border-2 border-background">
          <AvatarImage src={info.avatar} alt={info.name} />
          <AvatarFallback>{info.name?.at(0)}</AvatarFallback>
        </Avatar>
        <div className="mt-2 flex items-center gap-2 text-lg font-semibold">
          <span>{info.name}</span>
          {info.userType === '_externalUser' ? <Badge>外部</Badge> : null}
        </div>
        {info.email ? (
          <a className="mt-2 block text-sm text-primary" href={`mailto:${info.email}`}>
            {info.email}
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}

export { UserProfile };
