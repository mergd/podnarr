import type { SVGProps } from "react";

export function PodnarrLogo({
  size = 16,
  ...props
}: { size?: number | string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 64 64"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="20" cy="44" fill="currentColor" r="5" />
      <g stroke="currentColor" strokeLinecap="round" strokeWidth="5.5">
        <path d="M30 44a10 10 0 0 0-10-10" />
        <path d="M40 44a20 20 0 0 0-20-20" />
        <path d="M50 44A30 30 0 0 0 20 14" />
      </g>
    </svg>
  );
}
