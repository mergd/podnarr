const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL ?? "openai/gpt-5.6-luna";
const OPENROUTER_REFERER = process.env.PODNARR_SITE_URL
  ? `https://${process.env.PODNARR_SITE_URL.replace(/^https?:\/\//, "")}`
  : "https://podnarr.yet-to-be.com";

const IMAGE_PROMPT = [
  "You are describing the actual pixels of an article image for a podcast listener.",
  "Return one concise spoken sentence that says what the image, chart, table, or screenshot visibly contains.",
  "If it is a chart, mention the visible axes, labels, trend, or comparison when legible.",
  "Do not say 'Visual:', 'image appears here', 'an image is shown', or any placeholder wording.",
  "Do not mention alt text, filenames, URLs, or uncertainty unless the image is unreadable.",
  "Start with natural spoken phrasing such as 'The image shows...' or 'The chart shows...'."
].join(" ");

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { message?: string };
}

function parseOpenRouterText(payload: OpenRouterChatResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content.map((part) => part.text).filter(Boolean).join("").trim();
  }
  return "";
}

export function openRouterImageModel(): string {
  return OPENROUTER_IMAGE_MODEL;
}

export async function describeImageWithOpenRouter(mimeType: string, data: string): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": OPENROUTER_REFERER,
      "x-title": "Podnarr"
    },
    body: JSON.stringify({
      model: OPENROUTER_IMAGE_MODEL,
      max_tokens: 160,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } }
          ]
        }
      ]
    })
  });

  const payload = (await response.json()) as OpenRouterChatResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenRouter image describe failed with ${response.status}`);
  }

  const description = parseOpenRouterText(payload).replace(/^Visual:\s*/i, "").trim();
  if (!description) {
    throw new Error("OpenRouter image describe returned no text.");
  }
  return description;
}
