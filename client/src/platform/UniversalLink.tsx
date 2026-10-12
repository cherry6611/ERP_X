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
  if (/^https?:\/\//i.test(dest)) {
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
