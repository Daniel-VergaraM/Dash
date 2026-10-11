export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <g fill="var(--bg)"><rect x="7" y="10" width="18" height="4" rx="2" /><rect x="7" y="18" width="10" height="4" rx="2" /><rect x="20" y="18" width="5" height="4" rx="1" /></g>
    </svg>
  );
}
