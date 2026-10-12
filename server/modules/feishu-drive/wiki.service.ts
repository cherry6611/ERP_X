import {
  Injectable,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FeishuApiError,
  FeishuClientService,
  FEISHU_TENANT_DOMAIN,
} from './feishu-client.service';
import { DriveConfigService } from './drive-config.service';
import type { SyncToWikiResponse, WikiNode, WikiNodesResponse } from '@shared/api.interface';

interface WikiRawNode {
  node_token: string;
  title: string;
  obj_type?: string;
  has_child?: boolean;
  node_edit_time?: string | null;
}

interface WikiNodesData {
  items?: WikiRawNode[];
  has_more?: boolean;
  page_token?: string;
}

interface MoveToWikiData {
  task_id: string;
  ticket?: string;
}

interface MoveTaskNode {
  node_token?: string;
}

interface MoveTaskItem {
  status?: number;
  node?: MoveTaskNode;
}

interface MoveTaskData {
  task?: {
    move_result?: MoveTaskItem[];
  };
}

@Injectable()
export class WikiService {
  private readonly logger = new Logger(WikiService.name);

  constructor(
    private readonly client: FeishuClientService,
    private readonly configService: DriveConfigService,
  ) {}

  async getWikiSpaceId(): Promise<string> {
    const config = await this.configService.getConfig();
    return config.wikiSpaceId;
  }

  async listNodes(
    parentNodeToken?: string,
    pageToken?: string,
  ): Promise<WikiNodesResponse> {
    const spaceId = await this.getWikiSpaceId();
    if (!spaceId) {
      throw new ServiceUnavailableException('知识库空间未配置，请联系管理员');
    }
    const query: Record<string, string> = { page_size: '50' };
    if (parentNodeToken) query.parent_node_token = parentNodeToken;
    if (pageToken) query.page_token = pageToken;
    let data: WikiNodesData;
    try {
      data = await this.client.request<WikiNodesData>(
        'GET',
        `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
        { query },
      );
    } catch (err) {
      if (err instanceof FeishuApiError && err.feishuCode === 131006) {
        return { items: [], hasMore: false, pageToken: null, permissionDenied: true };
      }
      throw err;
    }
    const nodes: WikiRawNode[] = data.items ?? [];
    const items: WikiNode[] = nodes.map((node: WikiRawNode) => ({
      nodeToken: node.node_token,
      title: node.title,
      objType: node.obj_type ?? null,
      hasChild: node.has_child ?? false,
      nodeEditTime: node.node_edit_time ?? null,
      url: `${FEISHU_TENANT_DOMAIN}/wiki/${node.node_token}`,
    }));
    return {
      items,
      hasMore: data.has_more ?? false,
      pageToken: data.page_token ?? null,
    };
  }

  async syncToWiki(fileToken: string, fileType: string): Promise<SyncToWikiResponse> {
    const spaceId = await this.getWikiSpaceId();
    if (!spaceId) {
      throw new ServiceUnavailableException('知识库空间未配置，请联系管理员');
    }
    const data = await this.client
      .request<MoveToWikiData>(
        'POST',
        `/open-apis/wiki/v2/spaces/${spaceId}/nodes/move_docs_to_wiki`,
        {
          body: {
            obj_type: fileType,
            obj_token: fileToken,
          },
        },
      )
      .catch((err: unknown) => {
        if (err instanceof FeishuApiError && err.feishuCode === 131006) {
          throw new BadRequestException(
            '知识库空间未授权应用访问，请先在知识库空间设置中把应用添加为成员（可编辑）',
          );
        }
        throw err;
      });
    let wikiUrl: string | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve: (value: void) => void) => {
          setTimeout(resolve, 500);
        });
      }
      try {
        const task = await this.client.request<MoveTaskData>(
          'GET',
          `/open-apis/wiki/v2/tasks/${data.task_id}`,
          { query: { task_type: 'move' } },
        );
        const moveResult: MoveTaskItem[] = task.task?.move_result ?? [];
        const done = moveResult.find(
          (item: MoveTaskItem) => item.status === 0 && item.node?.node_token,
        );
        if (done?.node?.node_token) {
          wikiUrl = `${FEISHU_TENANT_DOMAIN}/wiki/${done.node.node_token}`;
          break;
        }
        if (moveResult.some((item: MoveTaskItem) => (item.status ?? 0) !== 0)) {
          this.logger.warn(
            `wiki 移动任务异常 task=${data.task_id} result=${JSON.stringify(moveResult)}`,
          );
          break;
        }
      } catch {
        this.logger.warn(
          `wiki 任务查询失败 task=${data.task_id} attempt=${attempt}`,
        );
        break;
      }
    }
    if (!wikiUrl) {
      this.logger.warn(
        `wiki 任务未返回节点 token task=${data.task_id}`,
      );
    }
    return { taskId: data.task_id, wikiUrl };
  }
}
