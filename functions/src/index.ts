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
import { getStorage } from "firebase-admin/storage";

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
  "Tu reçois une photo d'un ou plusieurs stickers BicyCode collés sur des vélos. " +
  "Chaque sticker contient un code d'identification FNUCI au format STRICT 'BC' suivi " +
  "de 8 caractères alphanumériques majuscules (exemples : BCZ9CANA4D, BCA24SN97A, BC38FKZZ7H). " +
  "Le code apparaît soit en clair imprimé sur le sticker, soit encodé dans un QR code " +
  "(qui contient une URL de la forme https://moncompte.bicycode.eu/<CODE>).\n\n" +
  "TÂCHE : extrais TOUS les codes FNUCI lisibles dans l'image. Réponds uniquement par un JSON " +
  'valide au format exact : {"fnucis":["BC...","BC..."]}. ' +
  'Ne renvoie aucun texte hors du JSON. Si tu ne vois aucun code lisible, réponds {"fnucis":[]}. ' +
  "Ne devine jamais : si un code est partiellement masqué, flou ou que tu n'es pas certain, ne le mets pas dans la liste.";

const FNUCI_REGEX = /^BC[A-Z0-9]{8}$/;

type ExtractFnuciPayload = {
  imageBase64?: string;
  mimeType?: string;
};

async function callGeminiVisionForFnuci(
  apiKey: string,
  base64: string,
  mimeType: string,
): Promise<{ ok: true; rawText: string } | { ok: false; error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
    return { ok: false, error: `Gemini fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `Gemini HTTP ${res.status} : ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const rawText = parts.map((p: { text?: string }) => p.text || "").join("");
  return { ok: true, rawText };
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
