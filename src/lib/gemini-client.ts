/**
 * Appel Gemini déporté.
 *
 * - En mode Vercel/SSR : on POST sur /api/gemini (route Next.js).
 * - En mode Firebase Hosting (static export) : on POST sur la Cloud Function
 *   `gemini` déployée dans le projet Firebase.
 *
 * Auth Firebase obligatoire (29-04) : on récupère l'ID token de l'utilisateur
 * connecté et on l'envoie en header Authorization. Sans ça, la Cloud Function
 * répond 401. Évite l'abus de la clé Gemini par n'importe qui sur internet.
 */

import { getAuth } from "firebase/auth";

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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Récupère l'ID token Firebase Auth (utile uniquement en mode Firebase ;
  // côté Vercel /api/gemini ne le requiert pas mais on l'envoie quand même
  // pour cohérence — l'API route ignore l'header).
  if (USE_FIREBASE) {
    try {
      const user = getAuth().currentUser;
      if (user) {
        const token = await user.getIdToken();
        headers["Authorization"] = `Bearer ${token}`;
      }
    } catch {
      // Si récupération du token échoue (user pas auth), on laisse partir
      // la requête sans header — la Cloud Function renverra 401 avec un
      // message clair, plus utile que de bloquer côté client.
    }
  }
  const res = await fetch(geminiUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, ...(models ? { models } : {}) }),
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, httpCode: res.status };
  }
  return (await res.json()) as GeminiResponse;
}
