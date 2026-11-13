// Stroke icons for the session chrome: decorative (the button carries the name), drawn in
// currentColor so they follow the text colour in every state, forced colours included.
import type { ComponentChildren } from "preact";

function Svg(props: { size?: number; children: ComponentChildren }) {
  const size = props.size ?? 18;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

type P = { size?: number };

export const ChatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
  </Svg>
);
export const FilesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h6l2 2h10v11H3z" />
  </Svg>
);
export const SettingsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h9M19 7h1M4 17h3M13 17h7" />
    <circle cx="16" cy="7" r="2.5" />
    <circle cx="10" cy="17" r="2.5" />
  </Svg>
);
export const StatsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 12h4l3-7 4 14 3-7h4" />
  </Svg>
);
export const KeysIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 4h10M12 4v16M7 20h10" />
  </Svg>
);
export const KeyboardIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Svg>
);
export const DisplayIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);
export const SoundIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 0 1 0 6" />
  </Svg>
);
export const MutedIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6" />
  </Svg>
);
export const RecordIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6" />
  </Svg>
);
export const StopIcon = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </Svg>
);
export const FullscreenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
export const ExitFullscreenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
);
export const CadIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 9h3M13 9h3M8 15h8" />
  </Svg>
);
export const MenuIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <svg
    aria-hidden="true"
    focusable="false"
    width={p.size ?? 18}
    height={p.size ?? 18}
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const PowerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" />
  </Svg>
);
export const ClipboardIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="5" width="12" height="16" rx="2" />
    <path d="M9 5V3h6v2M9 11h6M9 15h4" />
  </Svg>
);

const ARROWS = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  left: "M19 12H5M11 6l-6 6 6 6",
  right: "M5 12h14M13 6l6 6-6 6",
};
export const ArrowIcon = (p: P & { dir: keyof typeof ARROWS }) => (
  <Svg size={p.size}>
    <path d={ARROWS[p.dir]} />
  </Svg>
);
export const RefreshIcon = (p: P) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" />
  </Svg>
);
export const LockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const GestureIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 11V5a1.7 1.7 0 0 1 3.4 0v5l4.1.8a2 2 0 0 1 1.5 2.4L16.7 19a2 2 0 0 1-2 1.5H11a2 2 0 0 1-1.6-.8L5.5 14a1.6 1.6 0 0 1 2.4-2z" />
  </Svg>
);

/** Three signal bars, `level` of them filled (0 while unmeasured); the rest stay dim. */
export function SignalIcon(p: { level: 0 | 1 | 2 | 3; size?: number }) {
  const size = p.size ?? 12;
  const bars = [
    { x: 1, y: 8, h: 3 },
    { x: 5, y: 5, h: 6 },
    { x: 9, y: 1, h: 10 },
  ];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 12 12"
    >
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={b.y}
          width="2"
          height={b.h}
          fill="currentColor"
          opacity={i < p.level ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}
