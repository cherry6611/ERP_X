import { Layers } from 'lucide-react';

interface LoginBrandPanelProps {
  brandName: string;
  logoUrl: string | null;
}

/** 登录页左侧品牌说明区；从 LoginPage 抽出以守住 500 行门槛。 */
export default function LoginBrandPanel({
  brandName,
  logoUrl,
}: LoginBrandPanelProps) {
  return (
    <section className="relative hidden flex-col justify-between overflow-hidden bg-slate-900 p-10 text-primary-foreground md:flex">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ boxShadow: 'inset 0 0 120px rgba(255,255,255,.12)' }}
        aria-hidden="true"
      />
      <div className="relative flex items-center gap-3">
        <span className="flex size-10 items-center justify-center overflow-hidden rounded-xl bg-primary-foreground/15">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="size-10 object-contain" />
          ) : (
            <Layers className="size-5" aria-hidden="true" />
          )}
        </span>
        <div>
          <p className="text-2xl font-semibold tracking-tight">{brandName}</p>
          <p className="text-sm text-primary-foreground/80">数据服务一体化</p>
        </div>
      </div>
      <div className="relative max-w-sm space-y-5">
        <div className="space-y-3">
          <h2 className="text-[32px] font-semibold leading-[1.25] tracking-tight">
            经营数据
            <br />
            一处看清
          </h2>
          <p className="text-sm leading-6 text-primary-foreground/80">
            合同、项目、成本与回款在同一套账上运转，少一次对表，多一次判断。
          </p>
        </div>
        <div className="space-y-2 border-t border-primary-foreground/15 pt-5 text-[12px] text-primary-foreground/75">
          <p>· 项目健康与预算执行同屏</p>
          <p>· 收入、成本、回款一条链</p>
          <p>· 关键操作全程留痕</p>
        </div>
      </div>
    </section>
  );
}
