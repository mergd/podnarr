import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error - the .wasm import is wired via wrangler `rules` (CompiledWasm)
import resvgWasmModule from "@resvg/resvg-wasm/index_bg.wasm";

const OUTPUT_SIZE = 1400;
const BADGE_FRACTION = 0.22;
const BADGE_MARGIN_FRACTION = 0.04;

/** Bump when the corner mark changes so existing composites regenerate on refresh. */
export const ARTWORK_BADGE_REVISION = 3;

export function brandedArtworkSourceKey(sourceImageUrl: string): string {
  return `${sourceImageUrl}#badge-${ARTWORK_BADGE_REVISION}`;
}

let wasmReady: Promise<void> | null = null;

function ensureWasmReady(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasmModule as WebAssembly.Module);
  }
  return wasmReady;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function detectMimeType(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return fallback;
}

function buildCompositeSvg(sourceDataUri: string): string {
  const badgeSize = Math.round(OUTPUT_SIZE * BADGE_FRACTION);
  const margin = Math.round(OUTPUT_SIZE * BADGE_MARGIN_FRACTION);
  const badgeX = OUTPUT_SIZE - margin - badgeSize;
  const badgeY = OUTPUT_SIZE - margin - badgeSize;
  const markScale = badgeSize / 64;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}" viewBox="0 0 ${OUTPUT_SIZE} ${OUTPUT_SIZE}">`,
    `<defs>`,
    `<linearGradient id="podnarr-badge-fill" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#5a9ae6"/>`,
    `<stop offset="0.5" stop-color="#3b7dd8"/>`,
    `<stop offset="1" stop-color="#2b6ac0"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<image x="0" y="0" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}" preserveAspectRatio="xMidYMid slice" href="${sourceDataUri}" />`,
    `<g transform="translate(${badgeX} ${badgeY}) scale(${markScale})">`,
    `<rect width="64" height="64" rx="14" fill="url(#podnarr-badge-fill)" stroke="rgba(255,255,255,0.28)" stroke-width="1.2" />`,
    `<g fill="none" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round">`,
    `<circle cx="20" cy="44" r="5" fill="#ffffff" stroke="none" />`,
    `<path d="M30 44a10 10 0 0 0-10-10" />`,
    `<path d="M40 44a20 20 0 0 0-20-20" />`,
    `<path d="M50 44A30 30 0 0 0 20 14" />`,
    `</g>`,
    `</g>`,
    `</svg>`
  ].join("");
}

export interface BrandedArtwork {
  bytes: Uint8Array;
  contentType: "image/png";
}

export async function generateBrandedArtwork(sourceImageUrl: string): Promise<BrandedArtwork> {
  const response = await fetch(sourceImageUrl, {
    headers: { "user-agent": "podnarr-bot/0.1 (artwork)" }
  });

  if (!response.ok) {
    throw new Error(`Source artwork fetch failed with status ${response.status}`);
  }

  const contentTypeHeader = response.headers.get("content-type")?.split(";")[0]?.trim();
  const sourceBytes = new Uint8Array(await response.arrayBuffer());
  const mimeType = detectMimeType(sourceBytes, contentTypeHeader || "image/jpeg");
  const dataUri = `data:${mimeType};base64,${toBase64(sourceBytes)}`;

  await ensureWasmReady();
  const resvg = new Resvg(buildCompositeSvg(dataUri), {
    fitTo: { mode: "width", value: OUTPUT_SIZE },
    background: "rgba(0,0,0,0)"
  });
  const rendered = resvg.render();
  const pngBytes = rendered.asPng();
  rendered.free();
  resvg.free();

  return { bytes: pngBytes, contentType: "image/png" };
}
