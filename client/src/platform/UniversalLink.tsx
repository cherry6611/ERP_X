import { Link } from 'react-router-dom';

export function UniversalLink({
  href,
  to,
  children,
  className,
  target,
  rel,
}: {
  href?: string;
  to?: string;
  children?: React.ReactNode;
  className?: string;
  target?: string;
  rel?: string;
}) {
  const dest = href || to || '';
  /*
   * 附件/下载地址是后端相对路径（`/api/files/<id>`），不是 SPA 路由。
   * 原实现只把 `http(s)://` 当外链，其余一律交给 react-router `<Link>`：
   * 点击附件会跳到 `/api/files/...` 并命中 `*` 的 404 页，且 target/rel 丢失。
   * `/api/` 开头的地址必须走原生 `<a>`，由浏览器直接请求后端。
   */
  const isBackendAsset = /^\/api\//i.test(dest);
  if (/^https?:\/\//i.test(dest) || isBackendAsset) {
    return (
      <a className={className} href={dest} target={target} rel={rel}>
        {children}
      </a>
    );
  }
  return (
    <Link className={className} to={dest || '/'}>
      {children}
    </Link>
  );
}
