/**
 * Migrate data from GAS (Google Sheets) → Firestore.
 *
 * Strategy:
 *   - Snapshot one-shot. GAS reste la source de vérité tant que la migration n'est pas terminée.
 *   - Conserve les IDs legacy comme doc IDs Firestore (pour préserver les relations).
 *   - Skippe les bons d'enlèvement (vides actuellement).
 *
 * Usage:
 *   node scripts/migrate-data.mjs              # dry-run
 *   node scripts/migrate-data.mjs --apply      # exécute
 *   node scripts/migrate-data.mjs --apply --only clients,velos
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "migration-data");

const APPLY = process.argv.includes("--apply");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
const GAS_URL = process.env.NEXT_PUBLIC_GAS_URL || readEnvLocal();

function readEnvLocal() {
  try {
    const env = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
    const m = env.match(/^NEXT_PUBLIC_GAS_URL=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
if (!GAS_URL) throw new Error("NEXT_PUBLIC_GAS_URL manquant (.env.local)");

const serviceAccount = JSON.parse(
  readFileSync(join(dataDir, "service-account.json"), "utf8"),
);
if (admin.apps.length === 0) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------- helpers ----------
function tsOrNull(value) {
  if (!value || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

function emptyToNull(v) {
  if (v === "" || v === undefined) return null;
  return v;
}

function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function shouldRun(name) {
  return !ONLY || ONLY.has(name);
}

async function gasGet(action, params = {}) {
  const url = new URL(GAS_URL);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`GAS ${action} HTTP ${r.status}`);
  return r.json();
}

async function readCachedOrFetch(action, params, fileName) {
  const path = join(dataDir, fileName);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  console.log(`   ⤷ fetch ${action} (pas de cache)`);
  const data = await gasGet(action, params);
  writeFileSync(path, JSON.stringify(data));
  return data;
}

async function writeBatch(collName, docs, getId) {
  if (!APPLY) return docs.length;
  let written = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const item of docs.slice(i, i + 400)) {
      const id = getId(item);
      batch.set(db.collection(collName).doc(id), item.data, { merge: true });
    }
    await batch.commit();
    written += Math.min(400, docs.length - i);
    process.stdout.write(`   …${written}/${docs.length}\r`);
  }
  console.log(`   ${written}/${docs.length} écrits`);
  return written;
}

// ---------- mappers ----------

function mapClient(c) {
  return {
    id: c.id,
    data: {
      legacyId: c.id,
      entreprise: emptyToNull(c.entreprise),
      siren: c.siren ? String(c.siren) : null,
      contact: emptyToNull(c.contact),
      email: emptyToNull(c.email),
      telephone: c.telephone ? String(c.telephone) : null,
      adresse: emptyToNull(c.adresse),
      codePostal: c.codePostal ? String(c.codePostal) : null,
      ville: emptyToNull(c.ville),
      departement: c.departement != null ? String(c.departement) : null,
      apporteur: emptyToNull(c.apporteur),
      nbVelosCommandes: Number(c.nbVelosCommandes) || 0,
      operationNumero: c.operationNumero != null ? String(c.operationNumero) : null,
      referenceOperation: emptyToNull(c.referenceOperation),
      modeLivraison: emptyToNull(c.modeLivraison),
      latitude: typeof c.latitude === "number" ? c.latitude : null,
      longitude: typeof c.longitude === "number" ? c.longitude : null,
      notes: emptyToNull(c.notes),
      docs: {
        devisSignee: bool(c.devisSignee),
        kbisRecu: bool(c.kbisRecu),
        attestationRecue: bool(c.attestationRecue),
        signatureOk: bool(c.signatureOk),
        inscriptionBicycle: bool(c.inscriptionBicycle),
        parcelleCadastrale: bool(c.parcelleCadastrale),
      },
      docDates: {
        kbis: emptyToNull(c.kbisDate),
        engagement: emptyToNull(c.dateEngagement),
        liasseFiscale: emptyToNull(c.liasseFiscaleDate),
      },
      docLinks: {
        devis: emptyToNull(c.devisLien),
        kbis: emptyToNull(c.kbisLien),
        attestation: emptyToNull(c.attestationLien),
        signature: emptyToNull(c.signatureLien),
        bicycle: emptyToNull(c.bicycleLien),
        parcelleCadastrale: emptyToNull(c.parcelleCadastraleLien),
      },
      effectifMentionne: bool(c.effectifMentionne),
      stats: c.stats || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

function mapLivraison(l) {
  return {
    id: l.id,
    data: {
      legacyId: l.id,
      clientId: emptyToNull(l.clientId),
      tourneeId: emptyToNull(l.tourneeId),
      datePrevue: tsOrNull(l.datePrevue),
      dateEffective: tsOrNull(l.dateEffective),
      statut: l.statut || "planifiee",
      mode: emptyToNull(l.mode),
      chauffeurId: emptyToNull(l.chauffeurId),
      chefEquipeId: emptyToNull(l.chefEquipeId),
      chefEquipeIds: Array.isArray(l.chefEquipeIds) ? l.chefEquipeIds : [],
      monteurIds: Array.isArray(l.monteurIds) ? l.monteurIds : [],
      preparateurIds: Array.isArray(l.preparateurIds) ? l.preparateurIds : [],
      nbMonteurs: l.nbMonteurs ?? null,
      nbVelos: Number(l.nbVelos) || 0,
      notes: emptyToNull(l.notes),
      urlBlSigne: emptyToNull(l.urlBlSigne),
      blNumero: emptyToNull(l.numeroBL || l.blNumero),
      // snapshot client pour faciliter affichage sans jointure
      clientSnapshot: l.client
        ? {
            entreprise: l.client.entreprise || null,
            ville: l.client.ville || null,
            adresse: l.client.adresse || null,
            codePostal: l.client.codePostal != null ? String(l.client.codePostal) : null,
            departement: l.client.departement != null ? String(l.client.departement) : null,
            telephone: l.client.telephone != null ? String(l.client.telephone) : null,
            lat: typeof l.client.lat === "number" ? l.client.lat : null,
            lng: typeof l.client.lng === "number" ? l.client.lng : null,
          }
        : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

function mapCamion(c) {
  return {
    id: c.id,
    data: {
      legacyId: c.id,
      nom: c.nom,
      type: c.type,
      capaciteVelos: Number(c.capaciteVelos) || 0,
      peutEntrerParis: bool(c.peutEntrerParis),
      actif: bool(c.actif),
      notes: emptyToNull(c.notes),
      createdAt: tsOrNull(c.createdAt) || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

function mapVerification(v) {
  return {
    id: v.id,
    data: {
      legacyId: v.id,
      receivedAt: tsOrNull(v.receivedAt),
      clientId: emptyToNull(v.clientId),
      entreprise: emptyToNull(v.entreprise),
      docType: emptyToNull(v.docType),
      driveUrl: emptyToNull(v.driveUrl),
      fileName: emptyToNull(v.fileName),
      fromEmail: emptyToNull(v.fromEmail),
      subject: emptyToNull(v.subject),
      effectifDetected: emptyToNull(v.effectifDetected),
      nbVelosBefore: emptyToNull(v.nbVelosBefore),
      nbVelosAfter: emptyToNull(v.nbVelosAfter),
      nbVelosDevis: emptyToNull(v.nbVelosDevis),
      status: v.status || "pending",
      notes: emptyToNull(v.notes),
      messageId: emptyToNull(v.messageId),
    },
  };
}

function mapVelo(v, clientId) {
  return {
    id: v.veloId,
    data: {
      legacyId: v.veloId,
      clientId,
      fnuci: emptyToNull(v.fnuci),
      datePreparation: tsOrNull(v.datePreparation),
      dateChargement: tsOrNull(v.dateChargement),
      dateLivraisonScan: tsOrNull(v.dateLivraisonScan),
      dateMontage: tsOrNull(v.dateMontage),
      photos: {
        montageEtiquette: emptyToNull(v.urlPhotoMontageEtiquette),
        montageQrVelo: emptyToNull(v.urlPhotoMontageQrVelo),
        montageGenerale: emptyToNull(v.photoMontageUrl),
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

// ---------- pipeline ----------

const summary = {};

console.log(`📦 Migration data — ${APPLY ? "APPLY 🚀" : "DRY-RUN 🧪"}`);
console.log(`   GAS_URL : ${GAS_URL.slice(0, 80)}…`);
console.log("");

if (shouldRun("camions")) {
  console.log("🚚 camions");
  const data = await readCachedOrFetch("listFlotte", {}, "listFlotte-raw.json");
  const items = (data.items || data || []).map(mapCamion);
  summary.camions = await writeBatch("camions", items, (it) => it.id);
}

if (shouldRun("clients")) {
  console.log("👥 clients");
  const data = await readCachedOrFetch("getClients", {}, "getClients-raw.json");
  const items = (data.items || data || []).map(mapClient);
  summary.clients = await writeBatch("clients", items, (it) => it.id);
}

if (shouldRun("livraisons")) {
  console.log("📦 livraisons");
  const data = await readCachedOrFetch("getLivraisons", {}, "getLivraisons-raw.json");
  const items = (data.items || data || []).map(mapLivraison);
  summary.livraisons = await writeBatch("livraisons", items, (it) => it.id);
}

if (shouldRun("verifications")) {
  console.log("📋 verifications");
  const data = await readCachedOrFetch(
    "listVerifications",
    {},
    "listVerifications-raw.json",
  );
  const items = (data.items || data || []).map(mapVerification);
  summary.verifications = await writeBatch("verifications", items, (it) => it.id);
}

if (shouldRun("velos")) {
  console.log("🚲 velos (boucle par client)");
  const clientsData = JSON.parse(
    readFileSync(join(dataDir, "getClients-raw.json"), "utf8"),
  );
  const clients = clientsData.items || clientsData || [];
  const allVelos = [];
  let processed = 0;
  for (const c of clients) {
    try {
      const prep = await gasGet("getClientPreparation", { clientId: c.id });
      if (Array.isArray(prep.velos)) {
        for (const v of prep.velos) {
          allVelos.push(mapVelo(v, c.id));
        }
      }
    } catch (e) {
      console.error(`   ⚠️  client ${c.id} (${c.entreprise}) : ${e.message}`);
    }
    processed++;
    if (processed % 25 === 0) {
      process.stdout.write(`   ${processed}/${clients.length} clients traités\r`);
    }
  }
  console.log(`   ${processed}/${clients.length} clients traités, ${allVelos.length} vélos`);
  summary.velos = await writeBatch("velos", allVelos, (it) => it.id);
}

console.log("");
console.log("📊 Résumé :");
for (const [k, v] of Object.entries(summary)) {
  console.log(`   ${k.padEnd(15)} : ${v}`);
}

writeFileSync(
  join(dataDir, "migrate-data-report.json"),
  JSON.stringify({ apply: APPLY, summary, timestamp: new Date().toISOString() }, null, 2),
);

if (!APPLY) {
  console.log("\n⚠️  DRY-RUN. Relance avec --apply pour écrire dans Firestore.");
}
