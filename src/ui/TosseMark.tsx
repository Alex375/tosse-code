// The Flight Deck brand mark — a cyan aircraft climbing with a coral engine-thrust
// plume trailing along its flight axis (mirrors public/tosse.svg / the app icon).
// Inlined so it renders crisp at small sizes with no asset fetch. Sized via CSS
// (className), defaults to 1em. Component name kept (TosseMark) — internal identifier.
export function TosseMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" role="img" aria-label="Flight Deck">
      <defs>
        <linearGradient id="fd-mark-coral" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#cd6640" stopOpacity="0" />
          <stop offset="0.5" stopColor="#d9744f" />
          <stop offset="1" stopColor="#e8906f" />
        </linearGradient>
        <linearGradient id="fd-mark-core" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f0a988" stopOpacity="0" />
          <stop offset="1" stopColor="#f6c1a6" />
        </linearGradient>
        <linearGradient id="fd-mark-cyan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#54d8ff" />
          <stop offset="1" stopColor="#2bc6f0" />
        </linearGradient>
      </defs>
      <g transform="translate(256 256) rotate(-40) scale(14) translate(-5.5 -12)">
        <path d="M2 7 L-12 12 L2 17 Z" fill="url(#fd-mark-coral)" />
        <path d="M2 9.5 L-5.5 12 L2 14.5 Z" fill="url(#fd-mark-core)" />
        <path d="M2 21 L23 12 L2 3 L2 10 L17 12 L2 14 Z" fill="url(#fd-mark-cyan)" />
      </g>
    </svg>
  );
}
