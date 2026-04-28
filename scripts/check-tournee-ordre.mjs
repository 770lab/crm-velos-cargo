// Diagnostic ordre LIFO d'une (ou des) tournée(s) avant chargement.
// Usage :
//   node scripts/check-tournee-ordre.mjs                    → tournées du jour J+1
//   node scripts/check-tournee-ordre.mjs 2026-04-30         → tournées de cette date
//   node scripts/check-tournee-ordre.mjs <tourneeId>        → cette tournée précise
//
// Pour chaque tournée : liste les arrêts triés par champ `ordre`
// (avec fallback regex "arrêt X/N" sur notes legacy) et indique si le
// verrou LIFO inter-clients pourra s'activer côté serveur.

import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const arg = process.argv[2];

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function ordreFromNotes(notes) {
  if (typeof notes !== "string") return null;
  const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
  return m ? parseInt(m[1], 10) : null;
}

function dateKey(dp) {
  if (!dp) return "";
  if (typeof dp === "string") return dp.slice(0, 10);
  if (dp.toDate) return dp.toDate().toISOString().slice(0, 10);
  return "";
}

async function listLivsByTourneeId(tid) {
  const snap = await db.collection("livraisons").where("tourneeId", "==", tid).get();
  return snap.docs;
}

async function listLivsByDate(dateISO) {
  // Firestore ne peut pas filtrer un champ datePrevue stocké sous formats variés
  // (string vs Timestamp). On filtre côté JS — collection livraisons est de
  // taille gérable.
  const snap = await db.collection("livraisons").get();
  return snap.docs.filter((d) => dateKey(d.data().datePrevue) === dateISO);
}

function groupByTournee(docs) {
  const m = new Map();
  for (const d of docs) {
    const tid = d.data().tourneeId || "(sans-tourneeId)";
    if (!m.has(tid)) m.set(tid, []);
    m.get(tid).push(d);
  }
  return m;
}

function printTournee(tid, docs) {
  console.log(`\n━━━ Tournée ${tid} ━━━`);
  if (!docs.length) {
    console.log("  (aucune livraison)");
    return;
  }
  const first = docs[0].data();
  console.log(
    `  datePrevue=${dateKey(first.datePrevue)} · tourneeNumero=${first.tourneeNumero ?? "?"} · mode=${first.mode || "?"}`,
  );

  const enriched = docs.map((d) => {
    const data = d.data();
    const ordre =
      typeof data.ordre === "number" ? data.ordre : ordreFromNotes(data.notes);
    const source =
      typeof data.ordre === "number"
        ? "champ"
        : ordre != null
          ? "notes"
          : "—";
    return { d, data, ordre, source };
  });

  enriched.sort((a, b) => {
    if (a.ordre != null && b.ordre != null) return a.ordre - b.ordre;
    if (a.ordre != null) return -1;
    if (b.ordre != null) return 1;
    return 0;
  });

  const allHaveOrdre = enriched.every((e) => typeof e.ordre === "number");
  const sourceMix = new Set(enriched.map((e) => e.source));

  console.log(
    `  Verrou LIFO inter-clients : ${
      allHaveOrdre
        ? `✅ ACTIF (sources : ${[...sourceMix].join("+")})`
        : "❌ INACTIF (au moins une livraison sans ordre détectable)"
    }`,
  );
  console.log("  Ordre TOURNÉE (= ordre de livraison) :");
  enriched.forEach((e, i) => {
    const nom = (e.data.clientSnapshot?.entreprise || e.data.clientId || "?").slice(0, 32);
    const ordreStr = e.ordre != null ? `#${e.ordre}` : "—";
    console.log(
      `    ${String(i + 1).padStart(2)}. ${ordreStr.padEnd(4)} (src:${e.source.padEnd(5)}) ${nom.padEnd(32)} · ${e.data.nbVelos || 0}v · statut=${e.data.statut || "?"}`,
    );
  });

  if (allHaveOrdre && enriched.length > 1) {
    console.log(
      "\n  Ordre CHARGEMENT camion (LIFO inversé — premier rentré = dernier livré) :",
    );
    [...enriched].reverse().forEach((e, i) => {
      const nom = (e.data.clientSnapshot?.entreprise || e.data.clientId || "?").slice(0, 32);
      console.log(
        `    ${String(i + 1).padStart(2)}. ${nom.padEnd(32)} · ${e.data.nbVelos || 0}v`,
      );
    });
  }
}

const looksLikeDate = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg);
const looksLikeTourneeId = arg && !looksLikeDate;

let docs = [];
let label = "";
if (looksLikeTourneeId) {
  label = `Tournée ${arg}`;
  docs = await listLivsByTourneeId(arg);
} else {
  const dateISO = looksLikeDate ? arg : tomorrowISO();
  label = `Tournées du ${dateISO}${looksLikeDate ? "" : " (demain)"}`;
  docs = await listLivsByDate(dateISO);
}

console.log(`\n=== ${label} ===`);
console.log(`Total : ${docs.length} livraisons trouvées`);

if (!docs.length) {
  console.log("\n⚠️  Aucune livraison pour cette cible.");
  console.log(
    "   Si tu attendais une tournée demain : crée-la via le planning Gemini (page /carte ou /livraisons → bouton « Planifier »).",
  );
  process.exit(0);
}

const byT = groupByTournee(docs);
for (const [tid, ds] of byT) {
  printTournee(tid, ds);
}

console.log(`\n✅ ${byT.size} tournée(s) inspectée(s).`);
process.exit(0);
