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
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

initializeApp();
const auth = getAuth();
const db = getFirestore();

setGlobalOptions({
  region: "europe-west1",
  maxInstances: 10,
});

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GOOGLE_MAPS_API_KEY = defineSecret("GOOGLE_MAPS_API_KEY");
// Mot de passe d'application Gmail pour velos-cargo@artisansverts.energy
// (à générer sur https://myaccount.google.com/apppasswords sur ce compte).
// Utilisé par sendPreparationCsv pour envoyer le mail à Tiffany via SMTP.
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
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
    // 🔒 Auth Firebase requis (Yoann 29-04 : "porte d'entrée Gemini ouverte
    // sur internet"). Avant : endpoint public — n'importe qui pouvait
    // consommer la clé Gemini. Maintenant on exige un Firebase ID token
    // valide dans le header Authorization. Le frontend gemini-client.ts
    // récupère le token via auth.currentUser.getIdToken().
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (!idToken) {
      res.status(401).json({ ok: false, error: "Authentification requise" });
      return;
    }
    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ ok: false, error: "Token invalide ou expiré" });
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
  const password = `vc-${pin}`;

  // Lit le doc équipe pour récupérer email / nom (création éventuelle).
  const memberSnap = await db.collection("equipe").doc(id).get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "Membre introuvable dans la collection equipe");
  }
  const data = memberSnap.data() || {};
  const displayName = (data.nom as string | undefined) || undefined;
  // Si pas d'email côté doc, on en génère un synthétique cohérent avec
  // nameToEmail() côté frontend — ainsi l'admin n'a PAS besoin de saisir
  // un email pour qu'un membre puisse se connecter (Yoann 2026-04-29 :
  // « identifiant + PIN devraient suffire »).
  const explicitEmail = (data.email as string | undefined)?.trim().toLowerCase();
  let email = explicitEmail;
  if (!email && displayName) {
    const slug = displayName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    email = /^\d+[a-z]?$/.test(slug)
      ? `monteur-${slug}@velos-cargo.local`
      : `${slug}@velos-cargo.local`;
    // Persiste sur le doc pour qu'on n'ait pas à re-générer plus tard.
    await db.collection("equipe").doc(id).update({
      email,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  // Idempotent (Naomi 2026-04-29 : login KO car uid Firestore ≠ uid Auth) :
  //   1) update by uid (cas standard, seeds)
  //   2) si user pas trouvé, lookup par email — si trouvé, on update son
  //      password et on aligne son uid avec le doc équipe via un re-create
  //      (impossible) → on update juste le password et on log un warning.
  //   3) si rien trouvé, on crée un nouveau user Auth avec l'uid du doc.
  try {
    await auth.updateUser(id, {
      password,
      disabled: false,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
    });
    logger.info("setMembreCode: updated by uid", { id, email });
    return { ok: true, action: "updated" };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "auth/user-not-found") {
      logger.error("setMembreCode: updateUser failed", { id, code, error: String(e) });
      throw e;
    }
    // 2) Pas trouvé par uid → tente par email
    if (email) {
      try {
        const existing = await auth.getUserByEmail(email);
        await auth.updateUser(existing.uid, { password, disabled: false });
        logger.warn("setMembreCode: uid mismatch (updated by email)", {
          docId: id, authUid: existing.uid, email,
        });
        // Met à jour le doc équipe avec l'uid réel pour les prochaines fois
        // (évite la dérive). Note : on ne peut pas changer le doc id, mais on
        // expose l'authUid en champ pour debug.
        await db.collection("equipe").doc(id).update({
          authUid: existing.uid,
          authMismatchAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
        return { ok: true, action: "updated_by_email", authUid: existing.uid };
      } catch (e2) {
        const c2 = (e2 as { code?: string }).code;
        if (c2 !== "auth/user-not-found") {
          logger.error("setMembreCode: getUserByEmail failed", { id, email, error: String(e2) });
          throw e2;
        }
      }
    }
    // 3) Création
    if (!email) {
      throw new HttpsError(
        "failed-precondition",
        "Pas d'email rattaché — impossible de créer le compte. Renseigne l'email sur la fiche équipe d'abord.",
      );
    }
    await auth.createUser({
      uid: id,
      email,
      password,
      ...(displayName ? { displayName } : {}),
    });
    logger.info("setMembreCode: created", { id, email });
    return { ok: true, action: "created" };
  }
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

// ---------- extraction métadonnées doc client (Gemini Vision) ----------
//
// Déclenché à chaque upload dans clients/{clientId}/documents/{filename}.
// Le filename est de la forme `${docType}-${timestamp}` (cf. uploadDoc côté
// firestore-actions). On extrait la date de fraîcheur du document + flags
// métier (ex: effectifMentionne pour la liasse) via Gemini 2.5 Flash en
// inline_data, puis on update le client. La pastille passe au vert si tout
// est complet et dans les seuils de validité.

const FR_MONTHS: Record<string, string> = {
  janvier: "01", février: "02", fevrier: "02", mars: "03", avril: "04",
  mai: "05", juin: "06", juillet: "07", août: "08", aout: "08",
  septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12",
};

function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  // déjà ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY ou DD-MM-YYYY
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // "11 février 2026" / "11 fevrier 2026"
  m = s.match(/^(\d{1,2})\s+([a-zéûôîàèç]+)\s+(\d{4})$/);
  if (m && FR_MONTHS[m[2]]) return `${m[3]}-${FR_MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
  return null;
}

const EXTRACTION_PROMPTS: Record<string, string> = {
  kbisRecu: `Tu analyses un extrait Kbis français.

OBJECTIF : extraire la date de fraîcheur de l'extrait — celle qui prouve que le document est récent (< 3 mois) pour la compliance CEE.

RECHERCHE STRICTE : trouve dans le document UNE des formulations exactes ci-dessous (par ordre de priorité) et renvoie la date qui la suit :
  1. "à jour au"
  2. "extrait certifié conforme du" / "extrait certifié conforme à l'inscription au RCS du"
  3. "RCS de [ville] en date du"
  4. "Délivré le" (en bas du document, près de la signature greffier)

NE JAMAIS RETOURNER :
  ✗ La date d'immatriculation au RCS
  ✗ La date de début d'activité
  ✗ La date d'origine (création de l'entreprise)
  ✗ La date de naissance d'un dirigeant
  ✗ La date du jour si tu ne la vois pas explicitement sur le document
  ✗ Une date que tu déduis ou supposes

Si AUCUNE des formulations ci-dessus n'est trouvée explicitement dans le document, renvoie "date": null. Mieux vaut null qu'une mauvaise date.

Renvoie UNIQUEMENT un JSON :
{
  "date": "AAAA-MM-JJ" ou null,
  "dateLabel": "le texte exact entourant la date trouvée (ex 'à jour au 11 février 2026')" ou null,
  "raisonSociale": "..." ou null
}`,
  attestationRecue: `Tu analyses un document RH français qui sert à prouver l'effectif d'une entreprise (registre du personnel, liasse fiscale, attestation URSSAF, DPAE, DSN…).

Pour la compliance CEE, ce qui compte est la date à laquelle la situation de l'entreprise est attestée — PAS la date d'édition du PDF.

Règles d'extraction de la "date" :
  • Registre du personnel "Du JJ/MM/AAAA au JJ/MM/AAAA" → renvoyer la date de FIN de période (la deuxième date), pas le "Edité le".
  • Liasse fiscale → date de clôture de l'exercice fiscal.
  • Attestation URSSAF / DSN → date de la période ou du dernier mois couvert.
  • Si vraiment aucune date de période n'est lisible, fallback sur la date d'édition.

"effectifMentionne" est true si on voit un nombre de salariés ou une liste nominative, false sinon.

Renvoie UNIQUEMENT un JSON :
{
  "date": "AAAA-MM-JJ" ou null,
  "effectifMentionne": true|false,
  "nbSalaries": <nombre> ou null,
  "typeDocument": "registre_personnel" | "liasse_fiscale" | "attestation_urssaf" | "dsn" | "dpae" | "autre"
}`,
};

// Map docType → champs Firestore à mettre à jour.
// Les chemins exacts sont ceux lus par data-context-firebase + firestore-actions :
//   - kbisDate                 → docDates.kbis
//   - liasseFiscaleDate        → docDates.liasseFiscale
//   - effectifMentionne        → top-level (avec fallback docs.effectifMentionne lu)
function buildUpdates(docType: string, parsed: Record<string, unknown>): Record<string, unknown> | null {
  const updates: Record<string, unknown> = {};
  if (docType === "kbisRecu") {
    const d = normalizeDate(parsed.date as string);
    if (d) updates["docDates.kbis"] = d;
  } else if (docType === "attestationRecue") {
    const d = normalizeDate(parsed.date as string);
    if (d) updates["docDates.liasseFiscale"] = d;
    if (typeof parsed.effectifMentionne === "boolean") {
      updates.effectifMentionne = parsed.effectifMentionne;
    }
    if (typeof parsed.nbSalaries === "number") {
      updates.nbSalariesDetecte = parsed.nbSalaries;
    }
  }
  if (Object.keys(updates).length === 0) return null;
  updates.updatedAt = FieldValue.serverTimestamp();
  return updates;
}

async function extractWithGemini(
  apiKey: string,
  base64Pdf: string,
  mimeType: string,
  prompt: string,
): Promise<Record<string, unknown> | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Pdf } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) {
    logger.warn("Gemini extract HTTP non-200", { status: res.status, body: (await res.text()).slice(0, 200) });
    return null;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    logger.warn("Gemini extract JSON parse KO", { text: text.slice(0, 200) });
    return null;
  }
}

/**
 * Appelé par le client juste après un uploadDoc réussi. Le client passe
 * le chemin Storage du fichier qui vient d'être uploadé + le clientId +
 * le docType. La fonction télécharge le PDF, l'envoie à Gemini, et
 * update le client avec la date détectée + flag effectif.
 *
 * On a tenté un trigger Storage (onObjectFinalized) mais le bucket est
 * en europe-west3 et nécessite des permissions Eventarc supplémentaires.
 * Le onCall en europe-west1 marche cross-region pour Storage download.
 */
type ExtractPayload = {
  clientId?: string;
  docType?: string;
  storagePath?: string;
};

export const extractDocMetadata = onCall<ExtractPayload>(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    const clientId = request.data.clientId;
    const docType = request.data.docType;
    const storagePath = request.data.storagePath;
    if (!clientId || !docType || !storagePath) {
      throw new HttpsError("invalid-argument", "clientId, docType, storagePath requis");
    }
    if (!EXTRACTION_PROMPTS[docType]) {
      // Pas de prompt configuré pour ce type — pas une erreur, juste skip.
      return { ok: true, skipped: true };
    }
    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "GEMINI_API_KEY non configurée");
    }

    try {
      const file = getStorage().bucket().file(storagePath);
      const [meta] = await file.getMetadata();
      const mimeType = meta.contentType || "application/pdf";
      if (!/^application\/pdf$|^image\//.test(mimeType)) {
        return { ok: true, skipped: true, reason: "mime non supporté" };
      }
      const [buffer] = await file.download();
      const base64 = buffer.toString("base64");
      const parsed = await extractWithGemini(apiKey, base64, mimeType, EXTRACTION_PROMPTS[docType]);
      if (!parsed) {
        return { ok: true, extracted: false };
      }
      const updates = buildUpdates(docType, parsed);
      if (!updates) {
        return { ok: true, extracted: true, updates: null, parsed };
      }
      await db.collection("clients").doc(clientId).update(updates);
      logger.info("extractDocMetadata OK", { clientId, docType, updates });
      return { ok: true, extracted: true, updates, parsed };
    } catch (err) {
      logger.error("extractDocMetadata KO", { clientId, docType, err: err instanceof Error ? err.message : String(err) });
      throw new HttpsError("internal", err instanceof Error ? err.message : "Erreur extraction");
    }
  },
);

// ---------- extraction FNUCI depuis photo (Gemini Vision) ----------
//
// Remplace l'action GAS extractFnuciFromImage. Le frontend envoie une
// photo (base64) d'un sticker BicyCode (QR + texte clair), Gemini lit
// les codes au format BC + 8 alphanums majuscules. La validation regex
// côté serveur garde le contrôle contre toute hallucination.
//
// La Cloud Function fait UNIQUEMENT l'extraction. Le frontend mirroir
// ensuite les FNUCI extraits dans Firestore via assignFnuciToClient +
// markVeloPrepare/Charge/LivreScan (cf. mirrorGeminiResultsToFirestore
// dans photo-gemini-capture.tsx). Cette séparation évite de dupliquer
// la logique métier déjà dans firestore-actions.

const FNUCI_PROMPT =
  "Tu reçois une photo d'un ou plusieurs stickers BicyCode collés sur des vélos ou cartons. " +
  "Chaque sticker contient un code FNUCI : 'BC' suivi de 8 caractères alphanumériques majuscules " +
  "(exemples : BCZ9CANA4D, BCA24SN97A, BC38FKZZ7H). Le code peut être en clair sous le code-barres, " +
  "ou encodé dans un QR (URL https://moncompte.bicycode.eu/<CODE>).\n\n" +
  "RÈGLES ANTI-CONFUSION (caractères ambigus en OCR — fais ton mieux) :\n" +
  "- 0 (zéro) vs O (lettre o) : le 0 a une diagonale ou est plus étroit, le O est rond.\n" +
  "- 1 (un) vs I (lettre i) vs L (lettre l) : le 1 a un empattement en haut, le I est droit.\n" +
  "- 8 (huit) vs B (lettre b) : le 8 est symétrique haut/bas, le B a deux bosses asymétriques.\n" +
  "- 5 (cinq) vs S (lettre s) : le 5 a des angles droits, le S est arrondi.\n" +
  "- 2 (deux) vs Z (lettre z) : le 2 a une courbe, le Z a 3 segments droits.\n" +
  "- 6 (six) vs G (lettre g) : le 6 est fermé en bas, le G est ouvert.\n" +
  "- D (lettre D) vs 0 (zéro) : D a un côté plat à gauche, 0 est arrondi.\n\n" +
  "TÂCHE : extrais TOUS les codes FNUCI visibles dans l'image. Privilégie l'extraction quand " +
  "le code est globalement lisible, même si 1-2 caractères sont ambigus — fais ton meilleur " +
  "pari. Le système client a un fuzzy-match qui corrigera automatiquement une hallucination " +
  "sur 1 caractère si nécessaire.\n\n" +
  "Réponds UNIQUEMENT par un JSON au format exact : {\"fnucis\":[\"BC...\",\"BC...\"]}. " +
  "Aucun texte hors du JSON. Si tu ne vois VRAIMENT aucun code (image floue/vide/photo " +
  "inadaptée), réponds {\"fnucis\":[]}. Sinon, donne ton meilleur pari. " +
  "Ne complète jamais un caractère totalement masqué par déduction du contexte (ex 'BC2_4XYZ' " +
  "où le 3e char est invisible) — saute ce code.";

const FNUCI_REGEX = /^BC[A-Z0-9]{8}$/;

type ExtractFnuciPayload = {
  imageBase64?: string;
  mimeType?: string;
};

// Retry exponentiel sur 503/429/500 (29-04 11h : burst 28 photos en parallèle
// déclenchait UNAVAILABLE en cascade sur Gemini). Backoff 1s/3s/7s + jitter pour
// désynchroniser les requêtes simultanées qui retombent du même 503. Reste sous
// le timeoutSeconds de la Cloud Function (45s) : 1+3+7 = 11s de wait + 4×~5s d'appel = ~30s max.
async function callGeminiVisionForFnuci(
  apiKey: string,
  base64: string,
  mimeType: string,
): Promise<{ ok: true; rawText: string } | { ok: false; error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const RETRY_DELAYS_MS = [1000, 3000, 7000];
  let lastErr = "Gemini call failed";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: FNUCI_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            // OCR pur : pas de "thinking" → 1-2s gagnées par appel.
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 256,
          },
        }),
      });
    } catch (err) {
      lastErr = `Gemini fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < RETRY_DELAYS_MS.length) {
        const jitter = Math.random() * 500;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter));
        continue;
      }
      return { ok: false, error: lastErr };
    }
    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const rawText = parts.map((p: { text?: string }) => p.text || "").join("");
      return { ok: true, rawText };
    }
    const body = await res.text();
    lastErr = `Gemini HTTP ${res.status} : ${body.slice(0, 200)}`;
    // Retryable : 429 (rate limit), 500/502/503/504 (transient).
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      const jitter = Math.random() * 500;
      logger.warn("Gemini retry", { status: res.status, attempt: attempt + 1, delayMs: RETRY_DELAYS_MS[attempt] });
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter));
      continue;
    }
    return { ok: false, error: lastErr };
  }
  return { ok: false, error: lastErr };
}

export const extractFnuciFromImage = onCall<ExtractFnuciPayload>(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 45, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    const imageBase64 = request.data.imageBase64;
    const mimeType = request.data.mimeType || "image/jpeg";
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "imageBase64 requis");
    }
    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "GEMINI_API_KEY non configurée");
    }

    const callRes = await callGeminiVisionForFnuci(apiKey, imageBase64, mimeType);
    if (!callRes.ok) {
      logger.warn("extractFnuciFromImage Gemini KO", { error: callRes.error });
      // On retourne une réponse "soft" plutôt qu'un throw : le frontend
      // a un retry automatique + bouton "↻ Réessayer", il préfère lire
      // un objet { error } qu'attraper une exception.
      return { error: callRes.error };
    }

    const rawText = callRes.rawText;
    let rawFnucis: string[] = [];
    try {
      // Gemini peut renvoyer du texte autour du JSON malgré le mime type forcé,
      // on extrait le 1er bloc {...}.
      const match = rawText.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : rawText;
      const parsed = JSON.parse(jsonStr);
      rawFnucis = (parsed.fnucis || []).map((f: unknown) => String(f).trim().toUpperCase());
    } catch {
      logger.warn("extractFnuciFromImage JSON KO", { rawText: rawText.slice(0, 200) });
      return { error: "JSON Gemini invalide", rawText: rawText.slice(0, 500) };
    }

    const seen = new Set<string>();
    const extracted: string[] = [];
    const invalid: string[] = [];
    for (const f of rawFnucis) {
      if (!FNUCI_REGEX.test(f)) {
        invalid.push(f);
        continue;
      }
      if (seen.has(f)) continue;
      seen.add(f);
      extracted.push(f);
    }

    // Audit trail anti-hallucination Gemini (Yoann 29-04 : "FNUCI faux = CEE
    // non payé"). On log structuré pour pouvoir retrouver via Cloud Logging
    // les FNUCI extraits par photo si un dossier est rejeté plus tard.
    // imageHash = hash simple base64 (premiers + derniers 16 chars) pour
    // correspondance grossière avec photos Storage.
    const imageHash = imageBase64.length > 32
      ? imageBase64.slice(0, 16) + "…" + imageBase64.slice(-16)
      : imageBase64;
    logger.info("extractFnuciFromImage", {
      userId: request.auth?.uid || "?",
      extracted,
      invalid,
      imageSize: imageBase64.length,
      imageHash,
      rawTextSnippet: rawText.slice(0, 200),
    });

    // Le frontend (mirrorGeminiResultsToFirestore) skip les results dont
    // `result.ok !== true` → on met un OK factice sur chaque FNUCI valide
    // pour que le marquage Firestore (assignFnuciToClient + markVelo*)
    // s'enchaîne correctement. La logique métier reste côté client.
    const results = extracted.map((fnuci) => ({
      fnuci,
      result: { ok: true as const },
      assigned: null,
    }));

    return {
      ok: true,
      extracted,
      invalid,
      results,
      rawGeminiText: rawText.slice(0, 500),
    };
  },
);

// proposeTournee — vague 3 migration GAS → Cloud Function (cf. propose-tournee.ts).
export { proposeTournee } from "./propose-tournee.js";

// ---------- testGemini : diagnostic ping API ----------
//
// Migré depuis gas/Code.js:2092. Diagnostic admin : vérifie que la clé
// GEMINI_API_KEY est bien configurée et que l'API répond. Renvoie le code HTTP
// + un body tronqué pour debug. Pas d'auth (réservé via UI admin uniquement).

export const testGemini = onCall<Record<string, never>>(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    await ensureAdmin(request.auth.uid);
    const apiKey = GEMINI_API_KEY.value();
    const diag: Record<string, unknown> = {
      apiKeyPresent: !!apiKey,
      apiKeyLength: apiKey ? apiKey.length : 0,
      model: "gemini-2.5-flash",
      urlObfuscated: null as string | null,
      testMode: "text-only",
      httpCode: null as number | null,
      body: null as string | null,
      label: null as string | null,
      error: null as string | null,
    };
    if (!apiKey) {
      diag.error = "GEMINI_API_KEY absente";
      return diag;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    diag.urlObfuscated = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=***${apiKey.slice(-4)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Réponds uniquement par OK." }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 5 },
        }),
      });
      diag.httpCode = res.status;
      const body = await res.text();
      diag.body = body.length > 1500 ? `${body.slice(0, 1500)}...` : body;
      if (res.status === 200) {
        try {
          const data = JSON.parse(body);
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) diag.label = String(text).trim();
        } catch {}
      }
    } catch (err) {
      diag.error = `fetch a planté : ${err instanceof Error ? err.message : String(err)}`;
    }
    return diag;
  },
);

// ---------- getRouting : Distance Matrix Google Maps ----------
//
// Migré depuis gas/Code.js:5967. Calcule les segments routiers entre N points
// successifs via Google Maps Distance Matrix. Cache mémoire 30 min (au lieu
// du CacheService GAS 6h, mais le cold start étant rare et chaque appel
// faisant 5-30 segments, l'impact coût est négligeable).
//
// Secret requis : GOOGLE_MAPS_API_KEY (à set via `firebase functions:secrets:set`).

type RoutingPoint = { lat?: number; lng?: number };
type RoutingPayload = { points?: RoutingPoint[] };
type RoutingSegment = {
  distKm: number;
  trajetMin: number;
  source: "skip" | "cache" | "api" | "api_error" | "fetch_error";
  apiStatus?: string;
  elemStatus?: string;
  err?: string;
};

const routingCache = new Map<string, { distKm: number; trajetMin: number; expires: number }>();
const ROUTING_CACHE_MS = 30 * 60 * 1000;

export const getRouting = onCall<RoutingPayload>(
  { secrets: [GOOGLE_MAPS_API_KEY], timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    const points = Array.isArray(request.data?.points) ? request.data.points : [];
    if (points.length < 2) {
      return { ok: false, error: "Au moins 2 points requis", segments: [] as RoutingSegment[] };
    }
    const apiKey = GOOGLE_MAPS_API_KEY.value();
    if (!apiKey) {
      return {
        ok: false,
        error: "GOOGLE_MAPS_API_KEY non configurée (firebase functions:secrets:set GOOGLE_MAPS_API_KEY)",
        segments: [] as RoutingSegment[],
      };
    }

    const segments: RoutingSegment[] = [];
    let apiCalls = 0;
    let cachedCount = 0;
    const now = Date.now();

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (!p1 || !p2 || typeof p1.lat !== "number" || typeof p1.lng !== "number"
          || typeof p2.lat !== "number" || typeof p2.lng !== "number"
          || (p1.lat === 0 && p1.lng === 0) || (p2.lat === 0 && p2.lng === 0)) {
        segments.push({ distKm: 0, trajetMin: 0, source: "skip" });
        continue;
      }

      const key = `dm:${p1.lat.toFixed(5)},${p1.lng.toFixed(5)}->${p2.lat.toFixed(5)},${p2.lng.toFixed(5)}`;
      const cached = routingCache.get(key);
      if (cached && cached.expires > now) {
        segments.push({ distKm: cached.distKm, trajetMin: cached.trajetMin, source: "cache" });
        cachedCount++;
        continue;
      }

      const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
        + `?origins=${p1.lat},${p1.lng}`
        + `&destinations=${p2.lat},${p2.lng}`
        + `&mode=driving&units=metric&language=fr&key=${apiKey}`;

      try {
        const resp = await fetch(url);
        const data = await resp.json() as {
          status?: string;
          rows?: Array<{ elements?: Array<{ status?: string; distance?: { value?: number }; duration?: { value?: number } }> }>;
        };
        apiCalls++;
        const el = data.rows?.[0]?.elements?.[0];
        if (data.status === "OK" && el?.status === "OK" && el.distance?.value != null && el.duration?.value != null) {
          const distKm = Math.round(el.distance.value / 100) / 10;
          const trajetMin = Math.round(el.duration.value / 60);
          segments.push({ distKm, trajetMin, source: "api" });
          routingCache.set(key, { distKm, trajetMin, expires: now + ROUTING_CACHE_MS });
        } else {
          segments.push({
            distKm: 0,
            trajetMin: 0,
            source: "api_error",
            apiStatus: data.status,
            elemStatus: el?.status || "NO_ELEMENT",
          });
        }
      } catch (err) {
        segments.push({
          distKm: 0,
          trajetMin: 0,
          source: "fetch_error",
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { ok: true, segments, apiCalls, cached: cachedCount };
  },
);

// ---------- Envoi mail CSV préparation à Tiffany ----------
//
// Demande Yoann (29-04 14h07) : à chaque fin de préparation tournée, envoyer
// automatiquement à Tiffany@axdis.fr un CSV avec une ligne par vélo
// (Client / FNUCI / Date de livraison). Pas de manipulation manuelle.
//
// Implémentation : Cloud Function callable, charge les vélos via Firestore admin,
// génère le CSV, envoie via SMTP Gmail (nodemailer + mot de passe d'application
// pour velos-cargo@artisansverts.energy). Le destinataire est Tiffany@axdis.fr
// (la même adresse que les commandes Axdis sortantes, cf. AXDIS_EMAIL côté front).

import * as nodemailer from "nodemailer";

const SENDER_EMAIL = "velos-cargo@artisansverts.energy";
const TIFFANY_EMAIL = "Tiffany@axdis.fr";
// Maria (équipe interne LUZE) doit aussi recevoir une copie du CSV de
// préparation envoyé à Tiffany (30-04 09h57, demande Yoann).
const MARIA_EMAIL = "maria@artisansverts.energy";
// Comptabilité (Yoann 2026-05-01) : pour les commandes camion vers AXDIS
// (bon de commande), on copie naomi (compta) et benjamin pour traçabilité.
const NAOMI_EMAIL = "naomi@artisansverts.energy";
const BENJAMIN_EMAIL = "benjamin@artisansverts.energy";

function csvEscape(s: string): string {
  if (s.includes(";") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const sendPreparationCsv = onCall<{ tourneeId: string }>(
  { secrets: [GMAIL_APP_PASSWORD], timeoutSeconds: 90, memory: "256MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    const tourneeId = request.data.tourneeId;
    if (!tourneeId || typeof tourneeId !== "string") {
      throw new HttpsError("invalid-argument", "tourneeId requis");
    }
    const password = GMAIL_APP_PASSWORD.value();
    if (!password) {
      throw new HttpsError(
        "failed-precondition",
        "GMAIL_APP_PASSWORD non configurée — génère un mot de passe d'app et pose-le en secret Firebase",
      );
    }

    // 1. Récup tournée → datePrevue, numero, clients
    const livSnap = await db
      .collection("livraisons")
      .where("tourneeId", "==", tourneeId)
      .get();
    if (livSnap.empty) {
      throw new HttpsError("not-found", "Aucune livraison pour cette tournée");
    }
    let datePrevueStr: string | null = null;
    let tourneeNumero: number | null = null;
    const clientIds = new Set<string>();
    const clientNames = new Map<string, string>();
    for (const d of livSnap.docs) {
      const data = d.data() as {
        datePrevue?: { toDate?: () => Date } | string;
        numero?: number;
        clientId?: string;
        statut?: string;
        clientSnapshot?: { entreprise?: string };
      };
      if (String(data.statut || "").toLowerCase() === "annulee") continue;
      if (!datePrevueStr && data.datePrevue) {
        const dp = data.datePrevue;
        if (typeof dp === "string") {
          datePrevueStr = dp;
        } else if (dp?.toDate) {
          datePrevueStr = dp.toDate().toISOString();
        }
      }
      if (typeof data.numero === "number") tourneeNumero = data.numero;
      if (data.clientId) {
        clientIds.add(data.clientId);
        if (data.clientSnapshot?.entreprise) {
          clientNames.set(data.clientId, data.clientSnapshot.entreprise);
        }
      }
    }

    // Récupère les noms manquants depuis la collection clients
    for (const cid of clientIds) {
      if (clientNames.has(cid)) continue;
      try {
        const c = await db.collection("clients").doc(cid).get();
        if (c.exists) {
          const cd = c.data() as { entreprise?: string };
          if (cd?.entreprise) clientNames.set(cid, cd.entreprise);
        }
      } catch {}
    }

    // 2. Récup vélos par client (where in chunks de 30)
    const cidsArr = [...clientIds];
    const csvLines = ["Client;FNUCI;Date de livraison"];
    const dateLiv = datePrevueStr
      ? new Date(datePrevueStr).toLocaleDateString("fr-FR")
      : "";
    let velosCount = 0;
    for (let i = 0; i < cidsArr.length; i += 30) {
      const chunk = cidsArr.slice(i, i + 30);
      if (!chunk.length) continue;
      const vSnap = await db.collection("velos").where("clientId", "in", chunk).get();
      for (const d of vSnap.docs) {
        const v = d.data() as { fnuci?: string; clientId?: string; annule?: boolean };
        if (v.annule) continue;
        const cName = clientNames.get(v.clientId || "") || "";
        csvLines.push(`${csvEscape(cName)};${csvEscape(v.fnuci || "")};${csvEscape(dateLiv)}`);
        velosCount++;
      }
    }

    // 3. Construit le CSV (BOM UTF-8 pour Excel)
    const csvContent = "﻿" + csvLines.join("\r\n");

    // 4. Envoie le mail
    const ref = typeof tourneeNumero === "number"
      ? `VELO CARGO - TOURNEE ${tourneeNumero}`
      : `VELO CARGO - ${tourneeId}`;
    const subject = `${ref} — CSV préparation (${velosCount} vélos)`;
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `preparation-tournee-${tourneeNumero ?? tourneeId.slice(0, 8)}-${dateStr}.csv`;
    const body = [
      `Bonjour Tiffany,`,
      ``,
      `La préparation de la tournée ${ref} est terminée.`,
      `Tu trouveras ci-joint le CSV avec ${velosCount} vélos :`,
      `Client / FNUCI / Date de livraison${dateLiv ? ` (${dateLiv})` : ""}.`,
      ``,
      `Merci,`,
      `Yoann`,
    ].join("\n");

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: SENDER_EMAIL,
        pass: password,
      },
    });

    try {
      const info = await transporter.sendMail({
        from: `"VELO CARGO" <${SENDER_EMAIL}>`,
        to: TIFFANY_EMAIL,
        // CC Yoann 2026-05-01 : sender + comptabilité Naomi + Benjamin.
        // Maria reste copiée UNIQUEMENT sur ce mail-ci (CSV FNUCI prep)
        // car elle suit l'équipe terrain et a besoin du CSV.
        cc: [SENDER_EMAIL, NAOMI_EMAIL, BENJAMIN_EMAIL, MARIA_EMAIL],
        subject,
        text: body,
        attachments: [
          {
            filename,
            content: Buffer.from(csvContent, "utf-8"),
            contentType: "text/csv; charset=utf-8",
          },
        ],
      });
      logger.info("sendPreparationCsv envoyé", {
        tourneeId,
        velosCount,
        messageId: info.messageId,
        to: TIFFANY_EMAIL,
        cc: [SENDER_EMAIL, NAOMI_EMAIL, BENJAMIN_EMAIL, MARIA_EMAIL],
      });
      // Trace l'envoi sur les livraisons de la tournée pour que l'UI passe le
      // bouton en vert (Yoann 2026-04-29).
      try {
        const livQuery = await db
          .collection("livraisons")
          .where("tourneeId", "==", tourneeId)
          .get();
        const batch = db.batch();
        const sentAt = FieldValue.serverTimestamp();
        for (const d of livQuery.docs) {
          batch.update(d.ref, {
            csvAxdisSentAt: sentAt,
            csvAxdisSentTo: TIFFANY_EMAIL,
          });
        }
        await batch.commit();
      } catch (e) {
        logger.warn("sendPreparationCsv : trace persistance KO", { tourneeId, err: String(e) });
      }
      return {
        ok: true,
        messageId: info.messageId,
        sentTo: TIFFANY_EMAIL,
        velosCount,
        filename,
        ref,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("sendPreparationCsv SMTP failed", { tourneeId, err: msg });
      throw new HttpsError("internal", `Envoi SMTP échoué : ${msg}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Trigger : maintient clients/{id}.stats.{totalVelos,prepares,charges,livres}
// en synchro avec les vélos. Détecte les transitions de datePreparation,
// dateChargement, dateLivraisonScan et statut="annule" et applique des
// FieldValue.increment idempotents sur le doc client.
// Avant ce trigger : le compteur stats.livres restait à 0 quand les vélos
// étaient scannés livrés (Yoann 2026-04-29 — dashboard à 0/13 livrés).
// ─────────────────────────────────────────────────────────────────────────
function isSet(v: unknown): boolean {
  return v != null && v !== "";
}
function isCancelled(v: { statut?: string; annule?: boolean } | null | undefined): boolean {
  if (!v) return false;
  if (v.annule === true) return true;
  return String(v.statut || "").toLowerCase() === "annule";
}

export const onVeloWriteSyncClientStats = onDocumentWritten(
  "velos/{veloId}",
  async (event) => {
    const before = event.data?.before.exists ? (event.data.before.data() as Record<string, unknown>) : null;
    const after = event.data?.after.exists ? (event.data.after.data() as Record<string, unknown>) : null;

    // Le clientId peut changer (rare mais possible). On gère before.client et
    // after.client séparément pour décrémenter l'ancien et incrémenter le
    // nouveau si nécessaire.
    const beforeClientId = before?.clientId as string | undefined;
    const afterClientId = after?.clientId as string | undefined;

    const beforeCounted = !!before && !isCancelled(before as { statut?: string; annule?: boolean });
    const afterCounted = !!after && !isCancelled(after as { statut?: string; annule?: boolean });

    // Pour chaque field on calcule la contribution avant/après en tenant
    // compte de l'état "annulé" (un vélo annulé ne compte plus, même s'il
    // a une dateLivraisonScan posée à l'époque où il était actif).
    const fields: Array<{ src: string; tgt: "totalVelos" | "prepares" | "charges" | "livres" }> = [
      { src: "__exists__", tgt: "totalVelos" },
      { src: "datePreparation", tgt: "prepares" },
      { src: "dateChargement", tgt: "charges" },
      { src: "dateLivraisonScan", tgt: "livres" },
    ];

    const contribFor = (data: Record<string, unknown> | null, counted: boolean, src: string): number => {
      if (!data || !counted) return 0;
      if (src === "__exists__") return 1;
      return isSet(data[src]) ? 1 : 0;
    };

    // Cas 1 : même client avant/après (créa, update, suppression du même client)
    if (beforeClientId === afterClientId) {
      const cid = afterClientId || beforeClientId;
      if (!cid) return;
      const incs: Record<string, FirebaseFirestore.FieldValue> = {};
      for (const { src, tgt } of fields) {
        const delta = contribFor(after, afterCounted, src) - contribFor(before, beforeCounted, src);
        if (delta !== 0) incs[`stats.${tgt}`] = FieldValue.increment(delta);
      }
      if (Object.keys(incs).length === 0) return;
      try {
        await db.collection("clients").doc(cid).set(incs, { merge: true });
      } catch (e) {
        logger.warn("syncClientStats KO", { cid, err: String(e) });
      }
      return;
    }

    // Cas 2 : changement de clientId — décrémente l'ancien, incrémente le nouveau
    const updates: Array<Promise<unknown>> = [];
    if (beforeClientId) {
      const decs: Record<string, FirebaseFirestore.FieldValue> = {};
      for (const { src, tgt } of fields) {
        const delta = -contribFor(before, beforeCounted, src);
        if (delta !== 0) decs[`stats.${tgt}`] = FieldValue.increment(delta);
      }
      if (Object.keys(decs).length > 0) {
        updates.push(db.collection("clients").doc(beforeClientId).set(decs, { merge: true }));
      }
    }
    if (afterClientId) {
      const adds: Record<string, FirebaseFirestore.FieldValue> = {};
      for (const { src, tgt } of fields) {
        const delta = contribFor(after, afterCounted, src);
        if (delta !== 0) adds[`stats.${tgt}`] = FieldValue.increment(delta);
      }
      if (Object.keys(adds).length > 0) {
        updates.push(db.collection("clients").doc(afterClientId).set(adds, { merge: true }));
      }
    }
    try {
      await Promise.all(updates);
    } catch (e) {
      logger.warn("syncClientStats clientId-change KO", { beforeClientId, afterClientId, err: String(e) });
    }
  },
);

// ---------- Envoi BL à Franck (axdis logistique) ----------
//
// Demande Yoann (30-04 10h) : à la fin de la prep d'un client, un bouton
// manuel envoie le BL à Franck@axdis.fr. Pas auto, sur clic explicite.
// Le PDF est généré server-side avec pdfkit (pas de Chrome headless), envoyé
// en PJ via SMTP Gmail (même infra que sendPreparationCsv → réutilise le
// secret GMAIL_APP_PASSWORD et l'expéditeur velos-cargo@artisansverts.energy).

import PDFDocument from "pdfkit";

const FRANCK_EMAIL = "Franck@axdis.fr";

function pdfBlGenerate(opts: {
  numeroBL: string;
  dateLiv: string;
  tourneeRef: string;
  clientName: string;
  clientAdresse: string;
  clientCpVille: string;
  clientSiren: string | null;
  clientTel: string | null;
  fnucis: string[];
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks: Buffer[] = [];
      doc.on("data", (c) => chunks.push(Buffer.from(c)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Titre
      doc.fontSize(18).font("Helvetica-Bold").text("BON DE LIVRAISON", { align: "center" });
      doc.moveDown(0.4);
      doc
        .fontSize(11)
        .font("Helvetica")
        .text(`N° ${opts.numeroBL}`, { align: "center" })
        .moveDown(0.2)
        .text(`Date prévue : ${opts.dateLiv}`, { align: "center" })
        .text(`Tournée : ${opts.tourneeRef}`, { align: "center" });
      doc.moveDown(1);

      // Box émetteur
      doc.fontSize(10).font("Helvetica-Bold").text("Émetteur");
      doc
        .fontSize(9)
        .font("Helvetica")
        .text("LES ARTISANS VERTS SAS")
        .text("6 passage Eugène Barbier, 92400 Courbevoie")
        .text("contact@artisansverts.energy · 01 87 66 27 08")
        .text("SIRET : 878 062 793 00038");
      doc.moveDown(0.8);

      // Box destinataire
      doc.fontSize(10).font("Helvetica-Bold").text("Destinataire");
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(opts.clientName);
      doc
        .fontSize(9)
        .font("Helvetica")
        .text(opts.clientAdresse)
        .text(opts.clientCpVille);
      if (opts.clientSiren) doc.text(`SIREN : ${opts.clientSiren}`);
      if (opts.clientTel) doc.text(`Tél : ${opts.clientTel}`);
      doc.moveDown(1);

      // Tableau FNUCI
      doc.fontSize(11).font("Helvetica-Bold").text(`Vélos cargo livrés (${opts.fnucis.length})`);
      doc.moveDown(0.3);
      doc.fontSize(9).font("Courier");
      const colWidth = (doc.page.width - 80) / 2;
      let y = doc.y;
      opts.fnucis.forEach((fn, i) => {
        const col = i % 2;
        const x = 40 + col * colWidth;
        if (col === 0 && i > 0) y = doc.y;
        doc.text(`${String(i + 1).padStart(2, " ")}. ${fn}`, x, y, { width: colWidth });
      });
      doc.moveDown(1.5);

      // Pied
      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#666")
        .text(
          "Document interne LES ARTISANS VERTS — émis dans le cadre du programme CEE Vélos Cargo. " +
            "Les FNUCI listés sont marqués livrés à la signature du présent BL. Ne pas altérer.",
          { align: "left" },
        );

      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export const sendBlToFranck = onCall<{ tourneeId: string; clientId: string }>(
  { secrets: [GMAIL_APP_PASSWORD], timeoutSeconds: 90, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    const { tourneeId, clientId } = request.data || {};
    if (!tourneeId || !clientId) {
      throw new HttpsError("invalid-argument", "tourneeId + clientId requis");
    }
    const password = GMAIL_APP_PASSWORD.value();
    if (!password) {
      throw new HttpsError("failed-precondition", "GMAIL_APP_PASSWORD non configurée");
    }

    // 1. Charge la livraison du couple (tournée, client)
    const livSnap = await db
      .collection("livraisons")
      .where("tourneeId", "==", tourneeId)
      .where("clientId", "==", clientId)
      .get();
    if (livSnap.empty) {
      throw new HttpsError("not-found", "Aucune livraison trouvée pour ce client/tournée");
    }
    const livDoc = livSnap.docs[0];
    const livData = livDoc.data() as {
      datePrevue?: { toDate?: () => Date } | string;
      numero?: number;
      numeroBL?: string;
      tourneeNumero?: number;
      clientSnapshot?: { entreprise?: string; adresse?: string; codePostal?: string; ville?: string; siren?: string; telephone?: string };
    };

    // 2. Numéro BL : si pas encore attribué, on en génère un séquentiel BL-YYYY-NNNNN
    //    via getBlForTournee côté GAS legacy. Plus simple : on lit le doc, et si
    //    numeroBL absent, on en pose un basé sur compteur Firestore.
    let numeroBL = livData.numeroBL;
    if (!numeroBL) {
      const year = new Date().getFullYear();
      const counterRef = db.collection("counters").doc(`bl-${year}`);
      const next = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const n = snap.exists ? (snap.data()?.n || 0) + 1 : 1;
        tx.set(counterRef, { n }, { merge: true });
        return n;
      });
      numeroBL = `BL-${year}-${String(next).padStart(5, "0")}`;
      await livDoc.ref.update({ numeroBL });
    }

    // 3. Charge les infos client (priorité au snapshot dans la livraison, fallback sur clients/)
    const cs = livData.clientSnapshot || {};
    let clientName = cs.entreprise || "";
    let clientAdresse = cs.adresse || "";
    let clientCp = cs.codePostal || "";
    let clientVille = cs.ville || "";
    let clientSiren = cs.siren || null;
    let clientTel = cs.telephone || null;
    if (!clientName) {
      const cDoc = await db.collection("clients").doc(clientId).get();
      if (cDoc.exists) {
        const cd = cDoc.data() as Record<string, unknown>;
        clientName = (cd.entreprise as string) || "";
        clientAdresse = (cd.adresse as string) || "";
        clientCp = (cd.codePostal as string) || "";
        clientVille = (cd.ville as string) || "";
        clientSiren = (cd.siren as string) || null;
        clientTel = (cd.telephone as string) || null;
      }
    }

    // 4. Liste des FNUCI préparés pour ce client
    const vSnap = await db.collection("velos").where("clientId", "==", clientId).get();
    const fnucis: string[] = [];
    for (const v of vSnap.docs) {
      const vd = v.data() as { fnuci?: string; annule?: boolean; datePreparation?: unknown };
      if (vd.annule) continue;
      if (!vd.datePreparation) continue; // on inclut uniquement ce qui est préparé
      if (vd.fnuci) fnucis.push(vd.fnuci);
    }
    fnucis.sort();

    // 5. Date / tournée ref
    let dateLivStr = "";
    const dp = livData.datePrevue;
    if (dp) {
      const dt = typeof dp === "string" ? new Date(dp) : dp.toDate?.() || null;
      if (dt) dateLivStr = dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
    }
    const tourneeNum = livData.tourneeNumero ?? livData.numero;
    const tourneeRef = typeof tourneeNum === "number" ? `TOURNEE ${tourneeNum}` : tourneeId;

    // 6. Génère le PDF
    const pdfBuffer = await pdfBlGenerate({
      numeroBL,
      dateLiv: dateLivStr,
      tourneeRef,
      clientName,
      clientAdresse,
      clientCpVille: `${clientCp} ${clientVille}`.trim(),
      clientSiren,
      clientTel,
      fnucis,
    });

    // 7. Envoi mail
    const subject = `BL ${numeroBL} — ${clientName} (${fnucis.length} vélo${fnucis.length > 1 ? "s" : ""})`;
    const body = [
      `Bonjour Franck,`,
      ``,
      `Voici le bon de livraison pour ${clientName} :`,
      ``,
      `  N°    : ${numeroBL}`,
      `  Date  : ${dateLivStr}`,
      `  Vélos : ${fnucis.length}`,
      `  Réf.  : ${tourneeRef}`,
      ``,
      `Le PDF est en pièce jointe.`,
      ``,
      `Merci,`,
      `Yoann`,
    ].join("\n");

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SENDER_EMAIL, pass: password },
    });

    try {
      const info = await transporter.sendMail({
        from: `"VELO CARGO" <${SENDER_EMAIL}>`,
        to: FRANCK_EMAIL,
        cc: SENDER_EMAIL,
        subject,
        text: body,
        attachments: [
          {
            filename: `${numeroBL}-${(clientName || "client").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ],
      });
      logger.info("sendBlToFranck envoyé", {
        tourneeId,
        clientId,
        numeroBL,
        velosCount: fnucis.length,
        messageId: info.messageId,
        to: FRANCK_EMAIL,
      });
      return {
        ok: true,
        messageId: info.messageId,
        sentTo: FRANCK_EMAIL,
        numeroBL,
        velosCount: fnucis.length,
        clientName,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("sendBlToFranck SMTP failed", { tourneeId, clientId, err: msg });
      throw new HttpsError("internal", `Envoi SMTP échoué : ${msg}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Phase 3 — Auto-matching bonsEnlevement <-> commandesCamion (Yoann
// 2026-05-01). Quand un bon arrive avec tourneeRef = "VELO CARGO -
// COMMANDE N", on lie automatiquement à commandesCamion[numero=N] et
// on incrémente stockCartons sur l entrepôt destinataire.
// ─────────────────────────────────────────────────────────────────────────
const COMMANDE_REGEX = /VELO\s*CARGO\s*[-–]\s*COMMANDE\s*(\d+)/i;

export const onBonEnlevementWritten = onDocumentWritten(
  "bonsEnlevement/{bonId}",
  async (event) => {
    const bonId = event.params.bonId;
    const before = event.data?.before.exists ? (event.data.before.data() as Record<string, unknown>) : null;
    const after = event.data?.after.exists ? (event.data.after.data() as Record<string, unknown>) : null;
    if (!after) return; // suppression : on ne fait rien (cas rare)

    // Idempotence : si le bon est déjà lié à une commande, on ne refait rien.
    if (after.commandeCamionId) {
      logger.debug("[bon-trigger] déjà lié", { bonId, commandeId: after.commandeCamionId });
      return;
    }

    // Le tourneeRef peut être réécrit à chaque sync. On match à chaque
    // changement tant que pas encore lié.
    const refRaw = String(after.tourneeRef || after.subject || "").trim();
    if (!refRaw) return;
    const m = refRaw.match(COMMANDE_REGEX);
    if (!m) {
      // Pas une commande camion (probablement une tournée AXDIS classique
      // "VELO CARGO - TOURNEE X"). On ne touche pas.
      return;
    }
    const numero = parseInt(m[1], 10);
    if (!Number.isFinite(numero) || numero <= 0) return;

    // Optimisation : si on vient juste de relier (before avait déjà commandeCamionId),
    // ne pas reprocesser
    if (before?.commandeCamionId) return;

    logger.info("[bon-trigger] match COMMANDE détecté", { bonId, numero, refRaw });

    // Cherche la commandeCamion correspondante
    const cSnap = await db
      .collection("commandesCamion")
      .where("numero", "==", numero)
      .limit(1)
      .get();
    if (cSnap.empty) {
      logger.warn("[bon-trigger] commande introuvable", { numero, bonId });
      return;
    }
    const commandeDoc = cSnap.docs[0];
    const commande = commandeDoc.data() as {
      statut?: string;
      entrepotDestinataireId?: string;
      bonRetourId?: string | null;
    };
    // Si déjà liée (autre bon ?), log et stop
    if (commande.bonRetourId && commande.bonRetourId !== bonId) {
      logger.warn("[bon-trigger] commande déjà liée à un autre bon", {
        numero,
        existingBon: commande.bonRetourId,
        newBon: bonId,
      });
      return;
    }

    const numeroDoc = String(after.numeroDoc || "");
    const quantite = Number(after.quantite || 0);
    const entrepotId = commande.entrepotDestinataireId;
    const today = new Date().toISOString().slice(0, 10);

    // 1) Mise à jour commande : statut + bonRetour
    try {
      await commandeDoc.ref.set(
        {
          statut: "recue",
          bonRetourId: bonId,
          bonRetourNumero: numeroDoc || null,
          quantiteLivree: quantite || null,
          dateRecue: new Date().toISOString(),
          autoMatchedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      logger.error("[bon-trigger] update commande KO", { numero, e });
    }

    // 2) Marque le bon avec commandeCamionId pour idempotence + UI
    try {
      await db.collection("bonsEnlevement").doc(bonId).set(
        {
          commandeCamionId: commandeDoc.id,
          commandeCamionNumero: numero,
        },
        { merge: true },
      );
    } catch (e) {
      logger.error("[bon-trigger] update bon KO", { bonId, e });
    }

    // 3) Auto-incrément stockCartons sur l entrepôt destinataire
    //    + crée mouvement traçable.
    if (entrepotId && quantite > 0) {
      try {
        await db.collection("entrepots").doc(entrepotId).collection("mouvements").add({
          type: "carton",
          quantite,
          date: today,
          source: `bon-axdis-${numeroDoc || bonId}`,
          notes: `Réception ${numeroDoc} — ${refRaw}`,
          bonId,
          commandeCamionId: commandeDoc.id,
          createdAt: FieldValue.serverTimestamp(),
          autoCreated: true,
        });
        await db.collection("entrepots").doc(entrepotId).set(
          {
            stockCartons: FieldValue.increment(quantite),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        logger.info("[bon-trigger] stock incrémenté", { entrepotId, quantite, numero });
      } catch (e) {
        logger.error("[bon-trigger] increment stock KO", { entrepotId, quantite, e });
      }
    } else if (!entrepotId) {
      logger.warn("[bon-trigger] commande sans entrepotDestinataireId — pas d incrément stock", { numero });
    } else {
      logger.warn("[bon-trigger] quantite vide ou 0 — pas d incrément stock", { numero, quantite });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// rescanBonsForCommandes : fonction admin pour rétro-matcher les bons
// existants reçus avant l'activation du trigger. À lancer une fois après
// déploiement.
// ─────────────────────────────────────────────────────────────────────────
export const rescanBonsForCommandes = onCall<Record<string, never>>(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login requis");
  const memberDoc = await db.collection("equipe").doc(auth.uid).get();
  const role = memberDoc.exists ? (memberDoc.data() as { role?: string }).role : null;
  if (role !== "admin" && role !== "superadmin") {
    throw new HttpsError("permission-denied", "Réservé admin/superadmin");
  }

  const bonsSnap = await db.collection("bonsEnlevement").get();
  let scanned = 0;
  let matched = 0;
  for (const bonDoc of bonsSnap.docs) {
    const data = bonDoc.data();
    if (data.commandeCamionId) continue; // déjà lié
    const ref = String(data.tourneeRef || data.subject || "").trim();
    const m = ref.match(COMMANDE_REGEX);
    if (!m) continue;
    scanned++;
    // Trigger l'écriture (qui réveille onBonEnlevementWritten)
    // En mettant à jour updatedAt seulement, on force le trigger sans
    // modifier les données.
    await bonDoc.ref.set({ rescannedAt: FieldValue.serverTimestamp() }, { merge: true });
    matched++;
  }
  logger.info("rescanBonsForCommandes terminé", { scanned, matched });
  return { ok: true, scanned, matched };
});

// ─────────────────────────────────────────────────────────────────────────
// sendCommandeCamion : envoie le mail "VELO CARGO - COMMANDE N" à Tiffany
// pour passer commande d'un camion complet vers un entrepôt destinataire
// (Yoann 2026-05-01). L'email part de velos-cargo@artisansverts.energy
// (pas du mail personnel via mailto:).
// ─────────────────────────────────────────────────────────────────────────
type SendCommandeCamionPayload = {
  commandeId: string;
};

export const sendCommandeCamion = onCall<SendCommandeCamionPayload>(
  { secrets: [GMAIL_APP_PASSWORD], timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    const password = GMAIL_APP_PASSWORD.value();
    if (!password) {
      throw new HttpsError(
        "failed-precondition",
        "GMAIL_APP_PASSWORD non configurée",
      );
    }
    const auth = request.auth;
    if (!auth) throw new HttpsError("unauthenticated", "Login requis");
    const commandeId = request.data?.commandeId;
    if (!commandeId) throw new HttpsError("invalid-argument", "commandeId requis");

    // RBAC : seul admin/superadmin peut commander
    const memberDoc = await db.collection("equipe").doc(auth.uid).get();
    const role = memberDoc.exists ? (memberDoc.data() as { role?: string }).role : null;
    if (role !== "admin" && role !== "superadmin") {
      throw new HttpsError("permission-denied", "Réservé admin/superadmin");
    }
    const senderNom = memberDoc.exists
      ? (memberDoc.data() as { nom?: string }).nom || "Yoann"
      : "Yoann";

    const cSnap = await db.collection("commandesCamion").doc(commandeId).get();
    if (!cSnap.exists) throw new HttpsError("not-found", "Commande introuvable");
    const c = cSnap.data() as {
      reference?: string;
      numero?: number;
      quantite?: number;
      entrepotDestinataireNom?: string;
      entrepotDestinataireAdresse?: string;
      dateLivraisonSouhaitee?: string | null;
      notes?: string | null;
      emailEnvoyeAt?: unknown;
    };
    if (c.emailEnvoyeAt) {
      // Idempotent : déjà envoyé, on retourne ok sans renvoyer
      logger.info("sendCommandeCamion déjà envoyé", { commandeId });
      return { ok: true, alreadySent: true };
    }

    const reference = c.reference || `VELO CARGO - COMMANDE ${c.numero || "?"}`;
    const quantite = Number(c.quantite || 0);
    if (quantite < 50) {
      throw new HttpsError("failed-precondition", "Minimum 50 vélos (5 palettes)");
    }
    const palettes = Math.ceil(quantite / 10);
    const subject = reference;
    const livraisonLine = c.dateLivraisonSouhaitee
      ? `Livraison souhaitée : ${c.dateLivraisonSouhaitee}\n`
      : "";
    const notesLine = c.notes ? `\nNotes : ${c.notes}\n` : "";

    const body = [
      `Bonjour Tiffany,`,
      ``,
      `Merci de préparer ${quantite} vélos cargo (${palettes} palette${palettes > 1 ? "s" : ""}) pour livraison à :`,
      ``,
      `${c.entrepotDestinataireNom || ""}`,
      `${c.entrepotDestinataireAdresse || ""}`,
      ``,
      livraisonLine,
      `Référence à reporter sur le bon de commande : ${reference}`,
      notesLine,
      `Si pas de place disponible pour la quantité demandée, merci de me dire combien tu peux mettre en envoi (minimum 5 palettes = 50 vélos pour rentabiliser le camion).`,
      ``,
      `Cordialement,`,
      senderNom,
    ]
      .filter((l) => l !== null && l !== undefined)
      .join("\n");

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SENDER_EMAIL, pass: password },
    });

    try {
      const info = await transporter.sendMail({
        from: `"VELO CARGO" <${SENDER_EMAIL}>`,
        to: TIFFANY_EMAIL,
        cc: [SENDER_EMAIL, NAOMI_EMAIL, BENJAMIN_EMAIL],
        subject,
        text: body,
      });
      logger.info("sendCommandeCamion envoyé", {
        commandeId,
        reference,
        quantite,
        messageId: info.messageId,
      });
      // Trace l'envoi sur le doc commande
      await db.collection("commandesCamion").doc(commandeId).set(
        {
          emailEnvoyeAt: new Date().toISOString(),
          emailEnvoyeTo: TIFFANY_EMAIL,
          emailMessageId: info.messageId,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      return {
        ok: true,
        alreadySent: false,
        messageId: info.messageId,
        sentTo: TIFFANY_EMAIL,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("sendCommandeCamion SMTP failed", { commandeId, err: msg });
      throw new HttpsError("internal", `Envoi SMTP échoué : ${msg}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// onLivraisonStatutLivree (Yoann 2026-05-01) — décrément stock entrepôt
// quand une livraison rattachée à un entrepôt source passe en "livree".
//
// Boucle stock :
//   1) onBonEnlevementWritten incrémente stockCartons à la réception AXDIS
//   2) Transformations cartons → vélos montés via TransformPanel (manuel)
//   3) Création tournée depuis SuggererTourneePanel → livraison.entrepotOrigineId
//      + livraison.modeMontage posés
//   4) Quand statut = "livree" : on décrémente le stock approprié
//      - mode "client"            → stockCartons
//      - mode "atelier"           → stockVelosMontes
//      - mode "client_redistribue" → stockVelosMontes (livré chez un client
//                                     éphémère qui redistribue)
//
// Idempotence : flag livraison.stockEntrepotDecremented = true + champ
// stockEntrepotDecrementedAt — on ne décrémente jamais 2 fois la même
// livraison (même si quelqu un repasse "livree" → "planifiee" → "livree").
// ─────────────────────────────────────────────────────────────────────────
export const onLivraisonStatutLivree = onDocumentWritten(
  "livraisons/{livraisonId}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // delete

    const livraisonId = event.params.livraisonId;
    const statutBefore = String(before?.statut || "");
    const statutAfter = String(after.statut || "");
    const entrepotOrigineId = after.entrepotOrigineId
      ? String(after.entrepotOrigineId)
      : null;
    const modeMontage = after.modeMontage ? String(after.modeMontage) : null;
    const nbVelos = Number(after.nbVelos) || 0;
    const alreadyDone = after.stockEntrepotDecremented === true;

    // Conditions :
    // - on passe à "livree" (transition, pas un re-write idempotent)
    // - entrepôt source connu
    // - mode montage connu
    // - nbVelos > 0
    // - pas déjà décrémenté
    if (statutAfter !== "livree") return;
    if (statutBefore === "livree") return; // déjà traité par un précédent fire
    if (!entrepotOrigineId) {
      logger.info("[livraison-trigger] pas d entrepôt source — skip décrément", { livraisonId });
      return;
    }
    if (!modeMontage) {
      logger.warn("[livraison-trigger] pas de modeMontage — skip décrément", { livraisonId });
      return;
    }
    if (nbVelos <= 0) {
      logger.warn("[livraison-trigger] nbVelos<=0 — skip décrément", { livraisonId });
      return;
    }
    if (alreadyDone) {
      logger.info("[livraison-trigger] déjà décrémenté — skip", { livraisonId });
      return;
    }

    const champStock = modeMontage === "client" ? "stockCartons" : "stockVelosMontes";
    const typeMouvement = modeMontage === "client" ? "carton" : "velo_monte";

    try {
      // Marqueur idempotence d abord (avant le décrément) — si l update
      // entrepôt échoue on évite la double décrémentation au prochain replay.
      await db.collection("livraisons").doc(livraisonId).set(
        {
          stockEntrepotDecremented: true,
          stockEntrepotDecrementedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const today = new Date().toISOString().slice(0, 10);
      await db
        .collection("entrepots")
        .doc(entrepotOrigineId)
        .collection("mouvements")
        .add({
          type: typeMouvement,
          quantite: -nbVelos,
          date: today,
          source: `livraison-${livraisonId}`,
          notes: `Livraison ${after.tourneeNumero ?? "?"} → ${after.clientSnapshot?.entreprise ?? "?"}`,
          livraisonId,
          tourneeId: after.tourneeId || null,
          modeMontage,
          createdAt: FieldValue.serverTimestamp(),
          autoCreated: true,
        });

      await db.collection("entrepots").doc(entrepotOrigineId).set(
        {
          [champStock]: FieldValue.increment(-nbVelos),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      logger.info("[livraison-trigger] stock décrémenté", {
        livraisonId,
        entrepotOrigineId,
        champ: champStock,
        nbVelos,
        modeMontage,
      });
    } catch (e) {
      logger.error("[livraison-trigger] décrément stock KO", {
        livraisonId,
        entrepotOrigineId,
        e,
      });
    }
  },
);
