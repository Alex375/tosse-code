// The Tosse Code brand mark — the "Prompt T" (coral T + cyan cursor block), the app's
// own identity (mirrors public/tosse.svg / the app icon). Inlined so it renders crisp
// at small sizes with no asset fetch. Sized via CSS (className), defaults to 1em.
export function TosseMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" role="img" aria-label="Tosse Code">
      <defs>
        <linearGradient id="tosse-mark-coral" gradientUnits="userSpaceOnUse" x1="256" y1="76" x2="256" y2="436">
          <stop offset="0" stopColor="#e8906f" />
          <stop offset="1" stopColor="#cd6640" />
        </linearGradient>
        <linearGradient id="tosse-mark-cursor" gradientUnits="userSpaceOnUse" x1="388" y1="320" x2="388" y2="436">
          <stop offset="0" stopColor="#54d8ff" />
          <stop offset="1" stopColor="#2bc6f0" />
        </linearGradient>
      </defs>
      <rect x="68" y="76" width="368" height="76" rx="18" fill="url(#tosse-mark-coral)" />
      <rect x="214" y="76" width="76" height="360" rx="18" fill="url(#tosse-mark-coral)" />
      <rect x="340" y="320" width="96" height="116" rx="18" fill="url(#tosse-mark-cursor)" />
    </svg>
  );
}
