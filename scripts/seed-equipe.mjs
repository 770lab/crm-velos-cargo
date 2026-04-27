/**
 * Seed Firebase Auth + Firestore equipe collection from current GAS data.
 *
 * Usage:
 *   node scripts/seed-equipe.mjs           # dry-run par défaut
 *   node scripts/seed-equipe.mjs --apply   # exécute pour de vrai
 *
 * Inputs:
 *   - scripts/migration-data/service-account.json  (clé admin Firebase)
 *   - scripts/migration-data/equipe-raw.json       (export GAS listEquipe)
 *
 * Outputs:
 *   - scripts/migration-data/credentials.csv       (email + PIN par membre)
 *   - scripts/migration-data/seed-report.json      (résultat détaillé)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "migration-data");

const APPLY = process.argv.includes("--apply");
const PIN_BY_NAME = { yoann: "2626", maria: "2626" }; // pour TOUS les autres : "0000"
const PIN_DEFAULT = "0000";
const PIN_PREFIX = "vc-"; // mdp Firebase = `${PIN_PREFIX}${PIN}` (>= 6 chars)
const SYNTHETIC_DOMAIN = "velos-cargo.local";

// ---------- helpers ----------
function pinFor(name) {
  const k = name.toLowerCase();
  return PIN_BY_NAME[k] ?? PIN_DEFAULT;
}

function pwFromPin(pin) {
  return `${PIN_PREFIX}${pin}`;
}

function isValidEmail(email) {
  if (!email) return false;
  const at = email.indexOf("@");
  return at > 0 && email.indexOf("@", at + 1) === -1 && email.includes(".", at);
}

function slugify(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------- chargement ----------
const serviceAccount = JSON.parse(
  readFileSync(join(dataDir, "service-account.json"), "utf8"),
);
const raw = JSON.parse(readFileSync(join(dataDir, "equipe-raw.json"), "utf8"));
const items = Array.isArray(raw.items) ? raw.items : raw;

// ---------- préparation : dédoublonnage ----------
// Règle : on garde l'entrée active. Si plusieurs actives pour le même nom+rôle, on garde la plus ancienne.
const activeMembers = items.filter((m) => m.actif);

// Dédoublonnage Yoann (superadmin) ↔ Yoann (apporteur) — même personne
const yoannSuper = activeMembers.find(
  (m) => m.role === "superadmin" && m.nom.toLowerCase() === "yoann",
);
const filteredApporteurs = activeMembers.filter(
  (m) =>
    !(
      m.role === "apporteur" &&
      m.nom.toLowerCase() === "yoann" &&
      yoannSuper &&
      m.email === yoannSuper.email
    ),
);

// Renommage interne des doublons "3" pour les monteurs
const monteurNameCounts = {};
for (const m of filteredApporteurs) {
  if (m.role === "monteur") {
    monteurNameCounts[m.nom] = (monteurNameCounts[m.nom] || 0) + 1;
  }
}
const seenMonteurNames = {};
for (const m of filteredApporteurs) {
  if (m.role === "monteur" && monteurNameCounts[m.nom] > 1) {
    seenMonteurNames[m.nom] = (seenMonteurNames[m.nom] || 0) + 1;
    const suffix = String.fromCharCode(96 + seenMonteurNames[m.nom]); // a, b, c...
    m._slugName = `${m.nom}${suffix}`;
  }
}

// ---------- email synthétique pour ceux sans email valide ou en conflit ----------
const usedEmails = new Set();

function buildEmail(member) {
  const slug = slugify(member._slugName || member.nom);
  if (member.role === "monteur" && /^\d+[a-z]?$/.test(member._slugName || member.nom)) {
    return `monteur-${member._slugName || member.nom}@${SYNTHETIC_DOMAIN}`;
  }
  return `${slug}@${SYNTHETIC_DOMAIN}`;
}

// Premier passage : email réel uniquement si valide ET pas déjà pris
const enriched = filteredApporteurs.map((m) => ({ ...m }));
for (const m of enriched) {
  if (isValidEmail(m.email) && !usedEmails.has(m.email.toLowerCase())) {
    m._authEmail = m.email.toLowerCase();
    usedEmails.add(m._authEmail);
  } else {
    m._authEmail = null;
  }
}
// Deuxième passage : synthétique pour ceux sans email valide
for (const m of enriched) {
  if (!m._authEmail) {
    let candidate = buildEmail(m);
    let n = 2;
    while (usedEmails.has(candidate)) {
      const slug = slugify(m._slugName || m.nom);
      candidate = `${slug}-${n}@${SYNTHETIC_DOMAIN}`;
      n++;
    }
    m._authEmail = candidate;
    usedEmails.add(candidate);
  }
}

// ---------- séparation : avec Auth vs apporteurs (pas de login) ----------
const withAuth = enriched.filter((m) => m.role !== "apporteur");
const apporteursOnly = enriched.filter((m) => m.role === "apporteur");

console.log(`📊 Membres actifs total      : ${activeMembers.length}`);
console.log(`   ↳ avec compte Firebase    : ${withAuth.length}`);
console.log(`   ↳ apporteurs (Firestore)  : ${apporteursOnly.length}`);
console.log(`   Mode                       : ${APPLY ? "APPLY 🚀" : "DRY-RUN 🧪"}`);
console.log("");

// ---------- init firebase-admin ----------
if (admin.apps.length === 0) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const auth = admin.auth();
const db = admin.firestore();

// ---------- exécution ----------
const report = { withAuth: [], apporteurs: [], errors: [] };
const credentialRows = [["nom", "rôle", "email", "PIN", "uid", "notes"]];

async function upsertAuthUser(email, password, displayName) {
  try {
    const existing = await auth.getUserByEmail(email);
    if (APPLY) {
      await auth.updateUser(existing.uid, { password, displayName });
    }
    return { uid: existing.uid, created: false };
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    if (!APPLY) return { uid: "(dry-run-uid)", created: true };
    const created = await auth.createUser({ email, password, displayName });
    return { uid: created.uid, created: true };
  }
}

for (const m of withAuth) {
  const pin = pinFor(m.nom);
  const password = pwFromPin(pin);
  try {
    const { uid, created } = await upsertAuthUser(m._authEmail, password, m.nom);
    const docData = {
      uid,
      nom: m.nom,
      role: m.role,
      email: m._authEmail,
      contactEmail: isValidEmail(m.email) ? m.email : null,
      telephone: m.telephone || null,
      actif: true,
      notes: m.notes || null,
      salaireJournalier: m.salaireJournalier ?? null,
      primeVelo: m.primeVelo ?? null,
      legacyId: m.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (APPLY) {
      await db.collection("equipe").doc(uid).set(docData, { merge: true });
    }
    report.withAuth.push({ nom: m.nom, role: m.role, email: m._authEmail, uid, created });
    credentialRows.push([
      m.nom,
      m.role,
      m._authEmail,
      pin,
      uid,
      created ? "nouveau compte" : "déjà existant — mdp mis à jour",
    ]);
    console.log(
      `✅ ${m.nom.padEnd(20)} ${m.role.padEnd(13)} ${m._authEmail.padEnd(40)} PIN=${pin} ${created ? "(créé)" : "(MAJ)"}`,
    );
  } catch (e) {
    report.errors.push({ nom: m.nom, role: m.role, email: m._authEmail, error: e.message });
    console.error(`❌ ${m.nom} : ${e.message}`);
  }
}

for (const m of apporteursOnly) {
  try {
    const docData = {
      uid: null,
      nom: m.nom,
      role: m.role,
      email: null,
      contactEmail: isValidEmail(m.email) ? m.email : null,
      telephone: m.telephone || null,
      actif: true,
      notes: m.notes || null,
      legacyId: m.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (APPLY) {
      await db.collection("equipe").doc(m.id).set(docData, { merge: true });
    }
    report.apporteurs.push({ nom: m.nom, legacyId: m.id });
    console.log(`📋 ${m.nom.padEnd(20)} apporteur     (Firestore seul, pas de login)`);
  } catch (e) {
    report.errors.push({ nom: m.nom, role: m.role, error: e.message });
    console.error(`❌ ${m.nom} : ${e.message}`);
  }
}

// ---------- exports ----------
const csv = credentialRows
  .map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
  .join("\n");
writeFileSync(join(dataDir, "credentials.csv"), csv, "utf8");
writeFileSync(join(dataDir, "seed-report.json"), JSON.stringify(report, null, 2), "utf8");

console.log("");
console.log(`📝 credentials.csv  : ${report.withAuth.length} lignes`);
console.log(`📝 seed-report.json : ${report.errors.length} erreur(s)`);
if (!APPLY) {
  console.log("");
  console.log("⚠️  DRY-RUN. Aucune écriture sur Firebase.");
  console.log("   Relance avec --apply pour exécuter pour de vrai.");
}
process.exit(report.errors.length > 0 ? 1 : 0);
