export function formatDate(value: string | null): string {
  if (!value) {
    return "Undated";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) {
    return "Queued";
  }

  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}
