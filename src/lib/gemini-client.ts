/**
 * Appel Gemini déporté.
 *
 * - En mode Vercel/SSR : on POST sur /api/gemini (route Next.js).
 * - En mode Firebase Hosting (static export) : on POST sur la Cloud Function
 *   `gemini` déployée dans le projet Firebase.
 */

const USE_FIREBASE = process.env.NEXT_PUBLIC_USE_FIREBASE === "1";
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "velos-cargo";
const REGION = "europe-west1";

function geminiUrl(): string {
  if (USE_FIREBASE) {
    return `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/gemini`;
  }
  return "/api/gemini";
}

export type GeminiResponse =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string; httpCode?: number; body?: string };

export async function callGemini(
  prompt: string,
  models?: string[],
): Promise<GeminiResponse> {
  const res = await fetch(geminiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, ...(models ? { models } : {}) }),
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, httpCode: res.status };
  }
  return (await res.json()) as GeminiResponse;
}
