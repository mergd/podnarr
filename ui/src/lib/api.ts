import type { HomeResponse, PostDetailResponse, PublicationDetailResponse } from "@podnarr/shared/api";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "Request failed";
    throw new Error(message);
  }
  return payload as T;
}

export async function fetchHome(): Promise<HomeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/home`);
  return parseJson<HomeResponse>(response);
}

export async function fetchShow(slug: string): Promise<PublicationDetailResponse> {
  const response = await fetch(`${API_BASE_URL}/api/shows/${encodeURIComponent(slug)}`);
  return parseJson<PublicationDetailResponse>(response);
}

export async function fetchPost(id: number): Promise<PostDetailResponse> {
  const response = await fetch(`${API_BASE_URL}/api/posts/${id}`);
  return parseJson<PostDetailResponse>(response);
}
