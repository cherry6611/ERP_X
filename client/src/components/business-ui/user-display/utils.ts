import { normalizeUser, isValidUserId, asDepartment } from '@client/src/components/business-ui/utils/user';
import type { User } from '@client/src/components/business-ui/types/user';
import type { UserInfo } from '@client/src/platform/services';
import type { AccountType } from '@client/src/components/business-ui/api/users/service';

// 直接导出统一的函数
export { normalizeUser, isValidUserId };

// user-display 专用的转换函数
export function userInfoToUser(
  userInfo: UserInfo & { avatar?: string | { image?: { large?: string } } },
  accountType: AccountType,
): User {
  let avatarUrl: string | undefined;
  const avatar = userInfo.avatar as
    | string
    | { image?: { large?: string } }
    | undefined;

  if (typeof avatar === 'string') {
    avatarUrl = avatar;
  } else if (avatar?.image?.large) {
    avatarUrl = avatar.image.large;
  }

  return {
    user_id: accountType === 'lark' ? userInfo.larkUserID : userInfo.userID,
    larkUserId: userInfo.larkUserID,
    name: userInfo.name,
    avatar: avatarUrl,
    user_type: userInfo.userType,
    department: asDepartment(userInfo.department),
  };
}

export function createUnknownUser(user_id: string): User {
  return {
    user_id,
    name: '未知用户',
  };
}
