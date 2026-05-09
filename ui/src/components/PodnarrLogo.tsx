import type { SVGProps } from "react";

export function PodnarrLogo({ size = 16, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.25}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="6" cy="18" fill="currentColor" r="2.25" stroke="none" />
      <path d="M10 18a4 4 0 0 0-4-4" />
      <path d="M14 18a8 8 0 0 0-8-8" />
      <path d="M18 18A12 12 0 0 0 6 6" />
    </svg>
  );
}
