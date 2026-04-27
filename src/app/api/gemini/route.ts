// Proxy Gemini : déporte l'appel hors de GAS pour contourner le quota
// UrlFetchApp ("Quota de bande passante dépassé"). Vercel n'a pas cette
// limite — c'est juste du fetch HTTP standard.
//
// Côté GAS, `proposeTournee` peut maintenant renvoyer juste le prompt sans
// appeler Gemini ; c'est le frontend qui POSTe ici, on appelle Gemini, et
// on renvoie le texte brut au frontend qui le repasse à GAS pour le parse.

export const runtime = "nodejs";
export const maxDuration = 60;

const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const RETRY_DELAYS_MS = [0, 3000, 8000, 15000, 30000];

type GeminiOk = { ok: true; text: string; model: string };
type GeminiErr = { ok: false; error: string; httpCode?: number; body?: string };

async function callGemini(model: string, prompt: string, apiKey: string): Promise<{ code: number; text: string; raw: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 4096 },
      },
    }),
  });
  const raw = await res.text();
  if (res.status !== 200) return { code: res.status, text: "", raw };
  try {
    const data = JSON.parse(raw);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { code: 200, text, raw };
  } catch {
    return { code: 200, text: "", raw };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err: GeminiErr = { ok: false, error: "GEMINI_API_KEY non configurée côté serveur" };
    return Response.json(err, { status: 500 });
  }

  let body: { prompt?: string; models?: string[] };
  try {
    body = await request.json();
  } catch {
    const err: GeminiErr = { ok: false, error: "Payload JSON invalide" };
    return Response.json(err, { status: 400 });
  }
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") {
    const err: GeminiErr = { ok: false, error: "Champ `prompt` (string) requis" };
    return Response.json(err, { status: 400 });
  }
  const models = body.models && body.models.length > 0 ? body.models : FALLBACK_MODELS;

  let lastCode: number | undefined;
  let lastBody = "";
  for (const model of models) {
    for (const delay of RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        const res = await callGemini(model, prompt, apiKey);
        if (res.code === 200 && res.text) {
          const ok: GeminiOk = { ok: true, text: res.text, model };
          return Response.json(ok);
        }
        lastCode = res.code;
        lastBody = res.raw;
        // 503/429/500 sont retryables, autres = on break ce modèle et on passe au suivant.
        if (res.code !== 503 && res.code !== 429 && res.code !== 500) break;
      } catch (err) {
        lastBody = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const errPayload: GeminiErr = {
    ok: false,
    error: `Gemini HTTP ${lastCode ?? "??"} (épuisé après tous les modèles)`,
    httpCode: lastCode,
    body: lastBody.slice(0, 500),
  };
  return Response.json(errPayload, { status: 502 });
}
