import type { ReactNode, SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number | string };
const shapes: Record<string, ReactNode> = {
  box: <><path d="m4 8 8-4 8 4-8 4-8-4Z"/><path d="M4 8v8l8 4 8-4V8M12 12v8"/></>,
  branch: <><circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 8c5 0 3-1 6-1"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 4"/></>,
  spark: <path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z"/>,
  shield: <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></>,
  scan: <><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M7 12h10"/></>,
  play: <path d="m8 5 11 7-11 7V5Z"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  circle: <circle cx="12" cy="12" r="8"/>,
  default: <><path d="M5 5h14v14H5z"/><path d="M8 9h8M8 12h8M8 15h5"/></>,
};
function make(kind = "default") { return function Icon({ size = 18, ...props }: Props) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{shapes[kind]}</svg>; }; }

export const Box=make("box"), Boxes=make("box"), GitBranch=make("branch"), GitCommit=make("branch"), Check=make("check"), ChevronRight=make("chevron"), ChevronDown=make("chevron"), Image=make("image"), Sparkles=make("spark"), ShieldCheck=make("shield"), ScanLine=make("scan"), Play=make("play"), Plus=make("plus"), Circle=make("circle");
export const History=make(), Settings2=make(), FolderOpen=make(), RefreshCw=make("circle"), Wrench=make(), Bot=make(), FlaskConical=make(), Search=make("scan"), MoreHorizontal=make(), Share2=make(), FileCode2=make(), Save=make(), TriangleAlert=make(), Waves=make(), Focus=make("scan"), Grid3X3=make(), Maximize2=make(), Rotate3D=make("circle"), ArrowUp=make("chevron"), Square=make(), Braces=make();
