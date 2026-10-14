import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@client/src/components/ui/card';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import DictionarySettings from './DictionarySettings';
import ParameterSettings from './ParameterSettings';
import * as settingsApi from '@client/src/api/settings';
import * as feishuDriveApi from '@client/src/api/feishu-drive';
import type { BrandConfig } from '@client/src/api/settings';
import type { FeishuDriveConfigResponse } from '@shared/api.interface';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

const DENSITY_KEY = 'erp-density';
type Density = 'comfort' | 'compact';

function applyDensity(value: Density) {
  document.documentElement.setAttribute('data-density', value);
  try {
    window.localStorage.setItem(DENSITY_KEY, value);
  } catch {
    /* ignore */
  }
}

function readDensity(): Density {
  try {
    const raw = window.localStorage.getItem(DENSITY_KEY);
    if (raw === 'compact' || raw === 'comfort') return raw;
  } catch {
    /* ignore */
  }
  return 'comfort';
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [density, setDensity] = useState<Density>('comfort');
  const [mounted, setMounted] = useState(false);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [brandName, setBrandName] = useState('');
  const [bitableApp, setBitableApp] = useState('');
  const [bitableTable, setBitableTable] = useState('');
  const [bitableEnabled, setBitableEnabled] = useState(true);
  const [driveConfig, setDriveConfig] = useState<FeishuDriveConfigResponse | null>(
    null,
  );
  const [driveAppId, setDriveAppId] = useState('');
  const [driveAppSecret, setDriveAppSecret] = useState('');
  const [driveRootFolder, setDriveRootFolder] = useState('');
  const [driveWikiSpace, setDriveWikiSpace] = useState('');
  const [driveSaving, setDriveSaving] = useState(false);

  useEffect(() => {
    setMounted(true);
    const next = readDensity();
    setDensity(next);
    applyDensity(next);
  }, []);

  useEffect(() => {
    void settingsApi
      .getBrand()
      .then((b) => {
        setBrand(b);
        setBrandName(b.brandName);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void settingsApi
      .getQuotationBitableConfig()
      .then((c) => {
        setBitableApp(c.appToken ?? '');
        setBitableTable(c.tableId ?? '');
        setBitableEnabled(c.enabled !== false);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void feishuDriveApi
      .getDriveConfig()
      .then((c) => {
        setDriveConfig(c);
        setDriveAppId(c.appId);
        setDriveRootFolder(c.rootFolderToken);
        setDriveWikiSpace(c.wikiSpaceId);
        setDriveAppSecret('');
      })
      .catch(() => {
        setDriveConfig(null);
      });
  }, []);

  // 外观/品牌/飞书/账号四项保持原样，仅整体挂到「外观与集成」Tab 下，
  // 新增的「字典设置」「参数设置」以子组件形式追加在 Tabs 结构中。
  const appearanceTab = (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <SectionTitle>外观</SectionTitle>
          <CardDescription>主题与内容密度，偏好保存在本机</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="settings-theme">主题</Label>
            <Select
              value={mounted ? (theme ?? 'system') : 'system'}
              onValueChange={(value) => setTheme(value)}
            >
              <SelectTrigger id="settings-theme">
                <SelectValue placeholder="选择主题" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
                <SelectItem value="system">跟随系统</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="settings-density">密度</Label>
            <Select
              value={density}
              onValueChange={(value) => {
                const next = value as Density;
                setDensity(next);
                applyDensity(next);
              }}
            >
              <SelectTrigger id="settings-density">
                <SelectValue placeholder="选择密度" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comfort">舒适</SelectItem>
                <SelectItem value="compact">紧凑</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <CanCapabilityWrite capability="settings_brand">
        <Card>
          <CardHeader>
            <SectionTitle>品牌</SectionTitle>
            <CardDescription>Logo 与品牌名将作用于登录页与侧栏</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-12 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {brand?.logoUrl ? (
                  <img src={brand.logoUrl} alt="" className="size-12 object-contain" />
                ) : (
                  <span className="text-xs text-muted-foreground">无 Logo</span>
                )}
              </span>
              <div>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const res = await settingsApi.uploadBrandLogo(file);
                      setBrand(res.brand);
                      toast.success('Logo 已更新');
                    } catch (err) {
                      toast.error(getApiErrorMessage(err, '上传失败'));
                    }
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">PNG / JPEG / WebP / SVG，≤1MB</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:max-w-xs">
              <Label htmlFor="brand-name">品牌名</Label>
              <Input
                id="brand-name"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
              />
            </div>
            <Button
              type="button"
              className="w-fit"
              onClick={async () => {
                try {
                  const next = await settingsApi.updateBrand({ brandName });
                  setBrand(next);
                  toast.success('品牌已保存');
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '保存失败'));
                }
              }}
            >
              保存品牌
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle>报价多维表格</SectionTitle>
            <CardDescription>
              配置飞书 Bitable 的 app_token 与 table_id，供新建报价「从多维表格导入」使用
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:max-w-md">
            <div className="space-y-1">
              <Label htmlFor="bitable-app">App Token</Label>
              <Input
                id="bitable-app"
                value={bitableApp}
                onChange={(e) => setBitableApp(e.target.value)}
                placeholder="bascn..."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bitable-table">Table ID</Label>
              <Input
                id="bitable-table"
                value={bitableTable}
                onChange={(e) => setBitableTable(e.target.value)}
                placeholder="tbl..."
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={bitableEnabled}
                onChange={(e) => setBitableEnabled(e.target.checked)}
              />
              启用
            </label>
            <Button
              type="button"
              className="w-fit"
              onClick={async () => {
                try {
                  await settingsApi.upsertQuotationBitableConfig({
                    appToken: bitableApp,
                    tableId: bitableTable,
                    enabled: bitableEnabled,
                  });
                  toast.success('报价多维表格配置已保存');
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '保存失败'));
                }
              }}
            >
              保存配置
            </Button>
          </CardContent>
        </Card>
      </CanCapabilityWrite>

      <CanCapabilityWrite capability="settings_feishu">
        <Card>
          <CardHeader>
            <SectionTitle>飞书云空间 / 知识库</SectionTitle>
            <CardDescription>
              配置飞书应用凭证、云空间根目录与知识库空间，供附件解析、云文档读取、Drive/Wiki
              使用。仅管理员可修改。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:max-w-md">
            {!driveConfig ? (
              <p className="text-sm text-muted-foreground">
                尚未读取到配置（可能尚未初始化）。填写下方字段并保存以写入。
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                最近更新：
                {driveConfig.updatedAt
                  ? new Date(driveConfig.updatedAt).toLocaleString('zh-CN')
                  : '-'}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="drive-app-id">App ID</Label>
              <Input
                id="drive-app-id"
                value={driveAppId}
                onChange={(e) => setDriveAppId(e.target.value)}
                placeholder="cli_..."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drive-app-secret">App Secret</Label>
              <Input
                id="drive-app-secret"
                type="password"
                value={driveAppSecret}
                onChange={(e) => setDriveAppSecret(e.target.value)}
                placeholder={
                  driveConfig?.appSecretMasked
                    ? `当前 ${driveConfig.appSecretMasked}，留空则不修改`
                    : '留空则不修改'
                }
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drive-root-folder">云空间根目录 Token</Label>
              <Input
                id="drive-root-folder"
                value={driveRootFolder}
                onChange={(e) => setDriveRootFolder(e.target.value)}
                placeholder="fld..."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drive-wiki-space">知识库 Space ID</Label>
              <Input
                id="drive-wiki-space"
                value={driveWikiSpace}
                onChange={(e) => setDriveWikiSpace(e.target.value)}
                placeholder="数字或 space id"
              />
            </div>
            <Button
              type="button"
              className="w-fit"
              disabled={driveSaving}
              onClick={async () => {
                setDriveSaving(true);
                try {
                  const next = await feishuDriveApi.updateDriveConfig({
                    appId: driveAppId.trim() || undefined,
                    appSecret: driveAppSecret.trim() || undefined,
                    rootFolderToken: driveRootFolder.trim() || undefined,
                    wikiSpaceId: driveWikiSpace.trim() || undefined,
                  });
                  setDriveConfig(next);
                  setDriveAppId(next.appId);
                  setDriveRootFolder(next.rootFolderToken);
                  setDriveWikiSpace(next.wikiSpaceId);
                  setDriveAppSecret('');
                  toast.success('飞书云空间/知识库配置已保存');
                } catch (err) {
                  toast.error(getApiErrorMessage(err, '保存失败'));
                } finally {
                  setDriveSaving(false);
                }
              }}
            >
              {driveSaving ? '保存中…' : '保存飞书配置'}
            </Button>
          </CardContent>
        </Card>
      </CanCapabilityWrite>

      <Card>
        <CardHeader>
          <SectionTitle>我的飞书</SectionTitle>
          <CardDescription>
            系统禁止飞书扫码自动注册。绑定本人飞书后可使用飞书登录；管理员也可在 HR「身份管理」代绑。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              window.location.assign('/api/auth/feishu/bind');
            }}
          >
            绑定飞书
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <PageShell
      title="设置"
      description="外观、品牌、飞书云空间/知识库、报价多维表格、账号绑定与系统字典/参数"
    >
      <Tabs defaultValue="appearance">
        <TabsList>
          <TabsTrigger value="appearance">外观与集成</TabsTrigger>
          <TabsTrigger value="dictionary">字典设置</TabsTrigger>
          <TabsTrigger value="params">参数设置</TabsTrigger>
        </TabsList>
        <TabsContent value="appearance">{appearanceTab}</TabsContent>
        <TabsContent value="dictionary">
          <DictionarySettings />
        </TabsContent>
        <TabsContent value="params">
          <ParameterSettings />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
