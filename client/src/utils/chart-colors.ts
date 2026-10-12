function readChartVar(index: number, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw: string = getComputedStyle(document.documentElement)
    .getPropertyValue(`--chart-${index}`)
    .trim();
  if (!raw) return fallback;
  const match = raw.match(/^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/);
  return match ? `hsl(${match[1]}, ${match[2]}%, ${match[3]}%)` : raw;
}

function readVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw: string = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  const match = raw.match(/^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/);
  return match ? `hsl(${match[1]}, ${match[2]}%, ${match[3]}%)` : raw;
}

export const CHART_COLORS: string[] = [
  readChartVar(1, 'hsl(222, 82%, 56%)'),
  readChartVar(2, 'hsl(174, 77%, 46%)'),
  readChartVar(3, 'hsl(46, 100%, 52%)'),
  readChartVar(4, 'hsl(27, 92%, 49%)'),
  readChartVar(5, 'hsl(292, 54%, 76%)'),
];

export const CHART_SEMANTIC_COLORS: Record<string, string> = {
  primary: readChartVar(1, 'hsl(222, 82%, 56%)'),
  success: readVar('--success', 'hsl(130, 54%, 42%)'),
  warning: readVar('--warning', 'hsl(26, 90%, 49%)'),
  danger: readVar('--destructive', 'hsl(2, 84%, 62%)'),
  purple: readChartVar(5, 'hsl(292, 54%, 76%)'),
};
