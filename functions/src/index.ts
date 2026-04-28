/**
 * Cloud Functions pour CRM Vélos Cargo.
 *
 * Toutes les fonctions HTTPS exposent du CORS pour pouvoir être appelées
 * depuis https://velos-cargo.web.app (et les autres domaines autorisés).
 *
 * Secrets attendus (à définir avec `firebase functions:secrets:set NAME`):
 *   - GEMINI_API_KEY  : clé API Google AI Studio pour Gemini
 */

import { onRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const auth = getAuth();
const db = getFirestore();

setGlobalOptions({
  region: "europe-west1",
  maxInstances: 10,
});

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GAS_URL = defineString("GAS_URL", {
  default: "https://script.google.com/macros/s/AKfycbxcR1mvhpSphNIjuS_mu5GPIaMhxYp1vT1OOPAoGEHNN8h7_iiFIq3Cu_SGR9upgwNgxg/exec",
  // ATTENTION : ce paramètre pointe sur le déploiement GAS PRINCIPAL (gas/),
  // pas sur gas-inbox. Le Cloud Function syncFromGas appelle uniquement les
  // endpoints du gas/ principal (getBonsEnlevement, listVerifications, etc.).
  // gas-inbox tourne en autonome via triggers temporels GAS — pas d'appel HTTP
  // depuis le Cloud Function.
  description: "URL du déploiement GAS principal (gas/, sert aussi à NEXT_PUBLIC_GAS_URL côté front)",
});

const ALLOWED_ORIGINS = [
  "https://velos-cargo.web.app",
  "https://velos-cargo.firebaseapp.com",
  "http://localhost:3000",
];

function applyCors(req: { headers: Record<string, unknown> }, res: {
  setHeader: (k: string, v: string) => void;
}) {
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
}

// ---------- gemini proxy ----------

const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
// Retries plus agressifs : si Gemini est OK au 1er essai (cas normal), c'est instant.
// Si 503/429, on retente vite puis on bascule sur flash-lite plutôt que d'attendre 30s.
const RETRY_DELAYS_MS = [0, 2000, 5000];

type GeminiBody = { prompt?: string; models?: string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Jitter ±30% pour éviter le thundering herd : si plusieurs users se prennent
// un 429 en même temps, sans jitter ils retentent tous au même instant et
// reçoivent un nouveau 429. Le jitter étale la charge.
function jittered(ms: number): number {
  if (ms <= 0) return 0;
  const variance = ms * 0.3;
  return Math.max(0, ms + (Math.random() * 2 - 1) * variance);
}

async function callGemini(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<{ code: number; text: string; raw: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        // 8192 tokens suffit largement pour une planif (~30 tournées max).
        // Avant on était à 65536 → générait trop lentement.
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        // Réflexion courte mais existante : on garde de la qualité sans payer
        // 4096 tokens de "pensée" qui ralentissent énormément.
        thinkingConfig: { thinkingBudget: 1024 },
      },
    }),
  });
  const raw = await res.text();
  if (res.status !== 200) return { code: res.status, text: "", raw };
  try {
    const data = JSON.parse(raw);
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { code: 200, text, raw };
  } catch {
    return { code: 200, text: "", raw };
  }
}

export const gemini = onRequest(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 120, cors: false },
  async (req, res) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "POST only" });
      return;
    }
    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      res.status(500).json({ ok: false, error: "GEMINI_API_KEY non configurée" });
      return;
    }
    let body: GeminiBody;
    try {
      body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
    } catch {
      res.status(400).json({ ok: false, error: "Payload JSON invalide" });
      return;
    }
    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ ok: false, error: "Champ `prompt` (string) requis" });
      return;
    }
    const models = body.models && body.models.length > 0 ? body.models : FALLBACK_MODELS;

    let lastCode: number | undefined;
    let lastBody = "";
    for (const model of models) {
      for (const delay of RETRY_DELAYS_MS) {
        if (delay > 0) await sleep(jittered(delay));
        try {
          const r = await callGemini(model, prompt, apiKey);
          if (r.code === 200 && r.text) {
            res.json({ ok: true, text: r.text, model });
            return;
          }
          lastCode = r.code;
          lastBody = r.raw;
          if (r.code !== 503 && r.code !== 429 && r.code !== 500) break;
        } catch (err) {
          lastBody = err instanceof Error ? err.message : String(err);
        }
      }
    }
    logger.warn("gemini exhausted all retries", { lastCode, lastBodyHead: lastBody.slice(0, 200) });
    res.status(502).json({
      ok: false,
      error: `Gemini HTTP ${lastCode ?? "??"} (épuisé après tous les modèles)`,
      httpCode: lastCode,
      body: lastBody.slice(0, 500),
    });
  },
);

// ---------- login PIN (résolution nom → email + custom token) ----------

/**
 * Permet à l'utilisateur de saisir uniquement son nom + PIN, comme dans
 * l'ancien système GAS. La fonction :
 *   1. Cherche dans Firestore /equipe le membre par nom (case-insensitive)
 *   2. Vérifie que `actif: true`
 *   3. Vérifie le PIN via signInWithEmailAndPassword côté Identity Toolkit
 *   4. Renvoie un custom token au client → signInWithCustomToken
 *
 * Sans authentification préalable.
 */
export const loginWithPin = onRequest(
  { cors: false, timeoutSeconds: 30 },
  async (req, res) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "POST only" });
      return;
    }
    let body: { nom?: string; pin?: string } = {};
    try {
      body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
    } catch {
      res.status(400).json({ ok: false, error: "Payload JSON invalide" });
      return;
    }
    const nom = (body.nom || "").trim();
    const pin = (body.pin || "").trim();
    if (!nom) {
      res.status(400).json({ ok: false, error: "Identifiant requis" });
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      res.status(400).json({ ok: false, error: "PIN à 4 chiffres requis" });
      return;
    }

    // 1. Lookup par nom — comparaison insensible à la casse
    const allActive = await db
      .collection("equipe")
      .where("actif", "==", true)
      .get();
    const target = allActive.docs.find(
      (d) => (d.data().nom || "").toLowerCase() === nom.toLowerCase(),
    );
    if (!target) {
      res.status(404).json({ ok: false, error: "Identifiant inconnu" });
      return;
    }
    const data = target.data();
    const email = data.email as string | undefined;
    if (!email) {
      res
        .status(400)
        .json({ ok: false, error: "Ce compte n'a pas d'email rattaché" });
      return;
    }

    // 2. On NE génère PAS de custom token (permission iam.signBlob manquante
    //    sur le service account par défaut). À la place on renvoie l'email
    //    réel au client, qui fait signInWithEmailAndPassword. La vérification
    //    du PIN reste 100% côté Firebase Auth.
    res.json({ ok: true, email });
  },
);

// ---------- équipe : modifier le PIN d'un membre (admin only) ----------

type SetMembreCodePayload = { id: string; pin?: string | null };

async function ensureAdmin(uid: string | undefined): Promise<void> {
  if (!uid) {
    throw new HttpsError("unauthenticated", "Connexion requise");
  }
  const snap = await db.collection("equipe").doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "Pas dans la collection équipe");
  }
  const role = snap.data()?.role;
  if (role !== "superadmin" && role !== "admin") {
    throw new HttpsError("permission-denied", "Réservé aux admins");
  }
}

export const setMembreCode = onCall<SetMembreCodePayload>(async (request) => {
  await ensureAdmin(request.auth?.uid);
  const { id, pin } = request.data;
  if (!id) throw new HttpsError("invalid-argument", "id requis");
  if (!pin || !/^\d{4}$/.test(pin)) {
    throw new HttpsError("invalid-argument", "PIN à 4 chiffres requis");
  }
  // L'uid Firebase Auth correspond au doc id de equipe.
  await auth.updateUser(id, { password: `vc-${pin}` });
  return { ok: true };
});

export const clearMembreCode = onCall<{ id: string }>(async (request) => {
  await ensureAdmin(request.auth?.uid);
  const { id } = request.data;
  if (!id) throw new HttpsError("invalid-argument", "id requis");
  // On désactive l'accès en supprimant le password (impossible en Firebase Auth)
  // donc on désactive simplement le compte.
  await auth.updateUser(id, { disabled: true });
  await db.collection("equipe").doc(id).update({
    actif: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// ---------- gas-inbox sync (toutes les 15 min) ----------

type RawBon = {
  id?: string;
  receivedAt?: string;
  fournisseur?: string;
  numeroDoc?: string;
  dateDoc?: string;
  tourneeRef?: string;
  tourneeDate?: string;
  tourneeNumero?: number | string;
  tourneeId?: string;
  quantite?: number | string;
  driveUrl?: string;
  fileName?: string;
  fromEmail?: string;
  subject?: string;
  messageId?: string;
};

type RawVerification = {
  id: string;
  receivedAt?: string;
  clientId?: string;
  entreprise?: string;
  docType?: string;
  driveUrl?: string;
  fileName?: string;
  fromEmail?: string;
  subject?: string;
  effectifDetected?: string;
  nbVelosBefore?: string;
  nbVelosAfter?: string;
  nbVelosDevis?: string;
  status?: string;
  notes?: string;
  messageId?: string;
};

async function fetchJson(action: string, params: Record<string, string> = {}) {
  const url = new URL(GAS_URL.value());
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`GAS ${action} HTTP ${r.status}`);
  return r.json();
}

/**
 * Toutes les 15 min, on tire l'état des bonsEnlevement et verifications depuis
 * GAS et on sync vers Firestore. Idempotent : on utilise les ids existants
 * comme doc id.
 *
 * Stratégie pragmatique : laisser gas-inbox écrire dans Sheets (déjà éprouvé)
 * et juste mirrorer vers Firestore. Aucune réécriture du gros code GAS.
 */
export const syncFromGas = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Europe/Paris",
    timeoutSeconds: 300,
  },
  async () => {
    let totalBons = 0;
    let totalVerifs = 0;

    try {
      const bonsResp = (await fetchJson("getBonsEnlevement")) as
        | { items: RawBon[] }
        | RawBon[];
      const bons = Array.isArray(bonsResp) ? bonsResp : bonsResp.items || [];

      // Resolve tourneeNumero → tourneeId via Firestore livraisons. gas-inbox
      // n'a pas accès au mapping numéro→id, il extrait juste "TOURNEE X" du PDF
      // AXDIS via Gemini. Ici on fait la jointure une fois pour toutes pour que
      // le frontend puisse matcher directement par tourneeId (lien stable).
      const numToId = new Map<number, string>();
      try {
        const livSnap = await db.collection("livraisons").get();
        for (const d of livSnap.docs) {
          const data = d.data();
          const num = typeof data.tourneeNumero === "number" ? data.tourneeNumero : null;
          const tid = typeof data.tourneeId === "string" ? data.tourneeId : null;
          if (num != null && tid && !numToId.has(num)) numToId.set(num, tid);
        }
      } catch (mapErr) {
        logger.warn("syncFromGas: build numToId map failed (matching dégradé)", mapErr);
      }

      const batch = db.batch();
      let n = 0;
      for (const b of bons) {
        if (!b.id) continue;
        // Résolution tourneeId : (1) celui fourni par GAS, (2) sinon lookup
        // par tourneeNumero, (3) sinon null (le frontend matchera quand même
        // via tourneeNumero, mais le lien est moins direct).
        let resolvedTourneeId: string | null = b.tourneeId || null;
        if (!resolvedTourneeId && typeof b.tourneeNumero === "number") {
          resolvedTourneeId = numToId.get(b.tourneeNumero) || null;
        }
        batch.set(
          db.collection("bonsEnlevement").doc(b.id),
          {
            receivedAt: b.receivedAt || null,
            fournisseur: b.fournisseur || null,
            numeroDoc: b.numeroDoc || null,
            dateDoc: b.dateDoc || null,
            tourneeRef: b.tourneeRef || null,
            tourneeDate: b.tourneeDate || null,
            tourneeNumero: b.tourneeNumero ?? null,
            tourneeId: resolvedTourneeId,
            quantite: b.quantite ?? null,
            driveUrl: b.driveUrl || null,
            fileName: b.fileName || null,
            fromEmail: b.fromEmail || null,
            subject: b.subject || null,
            messageId: b.messageId || null,
            syncedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        n++;
        if (n % 400 === 0) await batch.commit();
      }
      if (n % 400 !== 0) await batch.commit();
      totalBons = n;
    } catch (err) {
      logger.error("syncFromGas bonsEnlevement KO", err);
    }

    try {
      const verifResp = (await fetchJson("listVerifications")) as
        | { items: RawVerification[] }
        | RawVerification[];
      const verifs = Array.isArray(verifResp)
        ? verifResp
        : verifResp.items || [];
      const batch = db.batch();
      let n = 0;
      for (const v of verifs) {
        if (!v.id) continue;
        batch.set(
          db.collection("verifications").doc(v.id),
          {
            receivedAt: v.receivedAt || null,
            clientId: v.clientId || null,
            entreprise: v.entreprise || null,
            docType: v.docType || null,
            driveUrl: v.driveUrl || null,
            fileName: v.fileName || null,
            fromEmail: v.fromEmail || null,
            subject: v.subject || null,
            effectifDetected: v.effectifDetected || null,
            nbVelosBefore: v.nbVelosBefore || null,
            nbVelosAfter: v.nbVelosAfter || null,
            nbVelosDevis: v.nbVelosDevis || null,
            status: v.status || "pending",
            notes: v.notes || null,
            messageId: v.messageId || null,
            syncedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        n++;
        if (n % 400 === 0) await batch.commit();
      }
      if (n % 400 !== 0) await batch.commit();
      totalVerifs = n;
    } catch (err) {
      logger.error("syncFromGas verifications KO", err);
    }

    logger.info(`syncFromGas done`, { bons: totalBons, verifs: totalVerifs });
  },
);

/**
 * Endpoint manuel pour déclencher la sync à la demande (utile pour tester sans
 * attendre le prochain tick du scheduler). Réservé aux admins authentifiés.
 */
export const syncFromGasNow = onCall(async (request) => {
  await ensureAdmin(request.auth?.uid);
  const result: { bons: number; verifs: number } = { bons: 0, verifs: 0 };

  try {
    const bonsResp = (await fetchJson("getBonsEnlevement")) as
      | { items: RawBon[] }
      | RawBon[];
    const bons = Array.isArray(bonsResp) ? bonsResp : bonsResp.items || [];

    // Même résolution tourneeNumero → tourneeId que le scheduler.
    const numToId = new Map<number, string>();
    try {
      const livSnap = await db.collection("livraisons").get();
      for (const d of livSnap.docs) {
        const data = d.data();
        const num = typeof data.tourneeNumero === "number" ? data.tourneeNumero : null;
        const tid = typeof data.tourneeId === "string" ? data.tourneeId : null;
        if (num != null && tid && !numToId.has(num)) numToId.set(num, tid);
      }
    } catch (mapErr) {
      logger.warn("syncFromGasNow: build numToId map failed", mapErr);
    }

    for (const b of bons) {
      if (!b.id) continue;
      let resolvedTourneeId: string | null = b.tourneeId || null;
      if (!resolvedTourneeId && typeof b.tourneeNumero === "number") {
        resolvedTourneeId = numToId.get(b.tourneeNumero) || null;
      }
      await db.collection("bonsEnlevement").doc(b.id).set(
        { ...b, tourneeId: resolvedTourneeId, syncedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      result.bons++;
    }
  } catch (err) {
    logger.error("syncFromGasNow bons KO", err);
  }

  try {
    const verifResp = (await fetchJson("listVerifications")) as
      | { items: RawVerification[] }
      | RawVerification[];
    const verifs = Array.isArray(verifResp) ? verifResp : verifResp.items || [];
    for (const v of verifs) {
      if (!v.id) continue;
      await db.collection("verifications").doc(v.id).set(
        { ...v, syncedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      result.verifs++;
    }
  } catch (err) {
    logger.error("syncFromGasNow verifs KO", err);
  }

  return { ok: true, ...result };
});
