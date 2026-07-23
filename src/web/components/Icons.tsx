import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function LineIcon({ children, ...props }: IconProps) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

/** Tiny Bear brand mark: GitHub-style solid dark tile with a white silhouette, self-contained at every size. */
export function PiMarkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="7" fill="#182131" />
      <path d="M6.3 8.7a2.3 2.3 0 1 1 3.1-2.15 7 7 0 0 1 5.2 0A2.3 2.3 0 1 1 17.7 8.7c.75.8 1.15 1.8 1.15 2.9v3.2c0 2.65-2.15 4.3-4.8 4.3H9.9c-2.65 0-4.8-1.65-4.8-4.3v-3.2c0-1.1.4-2.1 1.2-2.9Z" fill="#f4f7fb" />
      <circle cx="8.9" cy="12" r="1.05" fill="#182131" />
      <circle cx="15.1" cy="12" r="1.05" fill="#182131" />
      <circle cx="12" cy="14.7" r="1.2" fill="#182131" />
    </svg>
  );
}

export function PanelLeftIcon(props: IconProps) {
  return <LineIcon {...props}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M9.75 4v16" /></LineIcon>;
}

export function PlusIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M12 5v14M5 12h14" /></LineIcon>;
}

export function MinusIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M5 12h14" /></LineIcon>;
}

export function RefreshIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M19.5 9.5A7.8 7.8 0 1 0 20 14" /><path d="M19.5 4.5v5h-5" /></LineIcon>;
}

export function ChipIcon(props: IconProps) {
  return <LineIcon {...props}><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" /><path d="M9 2.5V5M15 2.5V5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5" /></LineIcon>;
}

export function SettingsIcon(props: IconProps) {
  // Six closed teeth, rather than radial strokes: a compact Windows-style gear.
  return <LineIcon {...props}><path d="M9.61 5.42 10.13 3.2h3.74l.52 2.22 2.11 1.22 2.19-.66 1.87 3.24-1.67 1.56v2.44l1.67 1.56-1.87 3.24-2.19-.66-2.11 1.22-.52 2.22h-3.74l-.52-2.22-2.11-1.22-2.19.66-1.87-3.24 1.67-1.56v-2.44L3.44 9.22l1.87-3.24 2.19.66Z" /><circle cx="12" cy="12" r="3.1" /></LineIcon>;
}

export function FolderIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 9.7v7.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5Z" /><path d="M3.8 9.3h16.4" /></LineIcon>;
}

export function ChevronRightIcon(props: IconProps) {
  return <LineIcon {...props}><path d="m9 5 7 7-7 7" /></LineIcon>;
}

export function CloseIcon(props: IconProps) {
  return <LineIcon {...props}><path d="m6 6 12 12M18 6 6 18" /></LineIcon>;
}

export function CheckIcon(props: IconProps) {
  return <LineIcon {...props} strokeWidth="2"><path d="m5 12.5 4.3 4.2L19 7.5" /></LineIcon>;
}

export function AlertIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M11 4.3 3.5 18a1.3 1.3 0 0 0 1.14 1.95h14.72A1.3 1.3 0 0 0 20.5 18L13 4.3a1.15 1.15 0 0 0-2 0Z" /><path d="M12 9v4.3M12 16.5v.1" /></LineIcon>;
}

export function ShieldIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M12 3.2 19 6v5.3c0 4.6-2.8 7.7-7 9.5-4.2-1.8-7-4.9-7-9.5V6Z" /><path d="M9.2 12.1 11 14l3.9-4.2" /></LineIcon>;
}

export function ExtensionIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M8.5 4.5h3v3a1.5 1.5 0 0 0 3 0v-3h3a2 2 0 0 1 2 2v3h-3a1.5 1.5 0 0 0 0 3h3v5a2 2 0 0 1-2 2h-5v-3a1.5 1.5 0 0 0-3 0v3h-3a2 2 0 0 1-2-2v-3h3a1.5 1.5 0 0 0 0-3h-3v-5a2 2 0 0 1 2-2Z" /></LineIcon>;
}

export function ImageIcon(props: IconProps) {
  return <LineIcon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9" r="1.4" /><path d="m5 17 4.6-4.6 3 3L15 13l4 4" /></LineIcon>;
}

export function FileSearchIcon(props: IconProps) {
  return <LineIcon {...props}><path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20Z" /><path d="M14 3.5v4h4" /><circle cx="10.3" cy="14.1" r="2.6" /><path d="m12.2 16 2.1 2.1" /></LineIcon>;
}
