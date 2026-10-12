export function getEnv(): string {
  return import.meta.env.MODE;
}

export function getAssetsUrl(path: string): string {
  if (path.startsWith('http')) return path;
  return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="112"><rect width="100%" height="100%" fill="#e8eef5"/></svg>')}`;
}
