import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION ?? "v1beta";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_RPM = Math.max(1, Number(process.env.GEMINI_RPM) || 3);
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES) || 8;
const GEMINI_RETRY_BASE_MS = Number(process.env.GEMINI_RETRY_BASE_MS) || 5_000;
const GEMINI_RETRY_MAX_MS = Number(process.env.GEMINI_RETRY_MAX_MS) || 120_000;
const GEMINI_DAILY_BUDGET = Number(process.env.GEMINI_DAILY_BUDGET) || 90;

const MIN_REQUEST_INTERVAL_MS = Math.ceil(60_000 / GEMINI_RPM);
const USAGE_FILE_PATH = path.join(process.env.RENDER_DIR ?? path.join(tmpdir(), "podnarr-audio"), "gemini-usage.json");

let requestGate = Promise.resolve();
let lastRequestAt = 0;
let dailyWindow = utcDayKey();
let dailyCount = 0;
let usageLoaded = false;

interface GeminiUsageSnapshot {
  day: string;
  count: number;
}

export class GeminiApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly retryAfterMs: number | null;
  readonly payload: unknown;

  constructor(status: number, statusText: string, message: string, payload: unknown, retryAfterMs: number | null) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.statusText = statusText;
    this.payload = payload;
    this.retryAfterMs = retryAfterMs;
  }
}

export class GeminiDailyBudgetExhaustedError extends Error {
  readonly resumeAt: Date;
  readonly used: number;
  readonly budget: number;

  constructor(used: number, budget: number) {
    const resumeAt = nextUtcMidnightDate();
    super(`Gemini daily request budget exhausted (${used}/${budget}). Resumes ${resumeAt.toISOString()}.`);
    this.name = "GeminiDailyBudgetExhaustedError";
    this.resumeAt = resumeAt;
    this.used = used;
    this.budget = budget;
  }
}

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnightDate(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(maxJitter: number): number {
  return Math.floor(Math.random() * maxJitter);
}

function geminiBaseUrl(pathname: string): string {
  if (pathname.startsWith("http")) {
    return pathname;
  }

  return `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/${pathname.replace(/^\//, "")}`;
}

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function parseRetryAfterFromMessage(message: string): number | null {
  const match = /retry(?:\s+in|\s+after)?\s+(\d+(?:\.\d+)?)\s*s/i.exec(message);
  if (!match?.[1]) {
    return null;
  }

  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

function readGeminiErrorMessage(payload: unknown, fallback: string): string {
  const error = payload as { error?: { message?: string } };
  return error.error?.message ?? fallback;
}

async function ensureUsageLoaded(): Promise<void> {
  if (usageLoaded) {
    return;
  }

  try {
    const raw = await readFile(USAGE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as GeminiUsageSnapshot;
    if (parsed.day === utcDayKey()) {
      dailyWindow = parsed.day;
      dailyCount = parsed.count;
    }
  } catch {
    // Fresh counter for today.
  }

  usageLoaded = true;
}

async function persistUsage(): Promise<void> {
  await mkdir(path.dirname(USAGE_FILE_PATH), { recursive: true });
  await writeFile(
    USAGE_FILE_PATH,
    JSON.stringify({ day: dailyWindow, count: dailyCount } satisfies GeminiUsageSnapshot, null, 2)
  );
}

function resetDailyWindowIfNeeded(): void {
  const today = utcDayKey();
  if (today !== dailyWindow) {
    dailyWindow = today;
    dailyCount = 0;
  }
}

async function reserveGeminiUsage(units: number): Promise<void> {
  await ensureUsageLoaded();
  resetDailyWindowIfNeeded();

  if (dailyCount + units > GEMINI_DAILY_BUDGET) {
    throw new GeminiDailyBudgetExhaustedError(dailyCount, GEMINI_DAILY_BUDGET);
  }

  dailyCount += units;
  await persistUsage();
}

async function acquireGeminiRequestSlot(): Promise<void> {
  const waitForSlot = async (): Promise<void> => {
    const waitMs = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  };

  const next = requestGate.then(waitForSlot);
  requestGate = next.catch(() => undefined);
  await next;
}

export function isGeminiDailyBudgetExhausted(error: unknown): error is GeminiDailyBudgetExhaustedError {
  return error instanceof GeminiDailyBudgetExhaustedError;
}

export function isGeminiRateLimitError(error: unknown): boolean {
  if (error instanceof GeminiApiError) {
    return error.status === 429 || /resource_exhausted|quota|rate limit/i.test(error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  return /429|resource_exhausted|quota exceeded|rate limit/i.test(message);
}

export function isTransientGeminiError(error: unknown): boolean {
  if (isGeminiDailyBudgetExhausted(error)) {
    return false;
  }

  if (error instanceof GeminiApiError) {
    return error.status === 429 || error.status >= 500 || /resource_exhausted|quota|rate limit|internal|unavailable|timeout/i.test(error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  return /internal error|temporar|timeout|rate limit|quota|429|500|502|503|504|did not include inline audio|fetch failed|econnreset|socket hang up|network|resource_exhausted/i.test(
    message
  );
}

function computeRetryDelayMs(attempt: number, error: unknown): number {
  if (error instanceof GeminiApiError) {
    const hinted =
      error.retryAfterMs ??
      parseRetryAfterFromMessage(error.message) ??
      (error.status === 429 ? GEMINI_RETRY_BASE_MS : null);
    if (hinted !== null) {
      return Math.min(GEMINI_RETRY_MAX_MS, hinted + jitterMs(1_500));
    }
  }

  const exponential = GEMINI_RETRY_BASE_MS * 2 ** attempt;
  return Math.min(GEMINI_RETRY_MAX_MS, exponential + jitterMs(2_000));
}

export interface GeminiRequestOptions {
  usageUnits?: number;
}

async function geminiFetchOnce(pathname: string, init?: RequestInit, options?: GeminiRequestOptions): Promise<Response> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  await reserveGeminiUsage(options?.usageUnits ?? 1);
  await acquireGeminiRequestSlot();

  const headers = new Headers(init?.headers);
  headers.set("x-goog-api-key", GEMINI_API_KEY);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let lastNetworkError: unknown;
  for (let networkAttempt = 0; networkAttempt < 3; networkAttempt += 1) {
    try {
      return await fetch(geminiBaseUrl(pathname), { ...init, headers });
    } catch (error) {
      lastNetworkError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/fetch failed|econnreset|socket hang up|network/i.test(message) || networkAttempt >= 2) {
        throw error;
      }
      await sleep(500 * 2 ** networkAttempt);
    }
  }

  throw lastNetworkError instanceof Error ? lastNetworkError : new Error(String(lastNetworkError));
}

export async function geminiFetch(pathname: string, init?: RequestInit, options?: GeminiRequestOptions): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    const response = await geminiFetchOnce(pathname, init, options);
    if (response.ok) {
      return response;
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    const message = readGeminiErrorMessage(payload, `Gemini request failed with ${response.status}`);
    const retryAfterMs = parseRetryAfterMs(response) ?? parseRetryAfterFromMessage(message);
    const error = new GeminiApiError(response.status, response.statusText, message, payload, retryAfterMs);
    lastError = error;

    const shouldRetry =
      attempt < GEMINI_MAX_RETRIES &&
      (response.status === 429 || response.status === 503 || response.status >= 500 || isGeminiRateLimitError(error));

    if (!shouldRetry) {
      throw error;
    }

    const delayMs = computeRetryDelayMs(attempt, error);
    await sleep(delayMs);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function geminiJson<T>(pathname: string, init?: RequestInit, options?: GeminiRequestOptions): Promise<T> {
  const response = await geminiFetch(pathname, init, options);
  return (await response.json()) as T;
}

export function geminiRequestIntervalMs(): number {
  return MIN_REQUEST_INTERVAL_MS;
}

export async function getGeminiUsageSnapshot(): Promise<{ day: string; used: number; budget: number; rpm: number }> {
  await ensureUsageLoaded();
  resetDailyWindowIfNeeded();
  return {
    day: dailyWindow,
    used: dailyCount,
    budget: GEMINI_DAILY_BUDGET,
    rpm: GEMINI_RPM
  };
}
