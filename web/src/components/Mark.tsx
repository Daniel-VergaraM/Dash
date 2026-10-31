// Dashboard brand symbol ("D de Dash"), on-dark variant from the logo kit:
// white D-shape + Ember bar, tied to --accent so it tracks the brand token.
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
      <path
        fill="#FFFFFF"
        fillRule="evenodd"
        d="M58,32 L102,32 A96,96 0 0 1 198,128 A96,96 0 0 1 102,224 L58,224 Z
            M102,72 A56,56 0 0 1 158,128 A56,56 0 0 1 102,184 Z"
      />
      <rect x="102" y="119" width="66" height="18" rx="9" fill="var(--accent)" />
    </svg>
  );
}
