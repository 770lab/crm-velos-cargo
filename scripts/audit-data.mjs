import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").get();
const lSnap = await db.collection("livraisons").get();
const vSnap = await db.collection("velos").get();

console.log(`=== Volumétrie Firestore ===`);
console.log(`clients: ${cSnap.size}, livraisons: ${lSnap.size}, vélos: ${vSnap.size}\n`);

// Index par id
const clientsById = new Map();
for (const d of cSnap.docs) clientsById.set(d.id, { id: d.id, ...d.data() });
const livraisonsByClient = new Map();
for (const d of lSnap.docs) {
  const o = d.data();
  const cid = o.clientId;
  if (!cid) continue;
  if (!livraisonsByClient.has(cid)) livraisonsByClient.set(cid, []);
  livraisonsByClient.get(cid).push({ id: d.id, ...o });
}
const velosByClient = new Map();
for (const d of vSnap.docs) {
  const o = d.data();
  const cid = o.clientId;
  if (!cid) continue;
  if (!velosByClient.has(cid)) velosByClient.set(cid, []);
  velosByClient.get(cid).push({ id: d.id, ...o });
}

// ========== INCOHÉRENCES ==========
const issues = {
  "Clients sans entreprise": [],
  "Clients sans adresse": [],
  "Clients sans coords (invisibles carte)": [],
  "Clients sans nbVelosCommandes": [],
  "Clients : nbVelosCommandes ≠ stats.totalVelos": [],
  "Clients : stats.totalVelos ≠ count(vélos non annulés)": [],
  "Clients : stats.livres ≠ count(vélos avec dateLivraisonScan)": [],
  "Vélos orphelins (clientId inexistant)": [],
  "Livraisons orphelines (clientId inexistant)": [],
  "Livraisons sans clientSnapshot.entreprise": [],
  "Vélos avec FNUCI dupliqué": [],
  "Doublons clients (même nom)": [],
  "Clients : sum(planifiees.nbVelos) > nbVelosCommandes": [],
  "Clients soft-cancelled mais avec livraisons planifiées actives": [],
};

// Clients
const nameMap = new Map();
for (const c of clientsById.values()) {
  if (!c.entreprise) issues["Clients sans entreprise"].push(c.id);
  if (!c.adresse) issues["Clients sans adresse"].push(`${c.entreprise || c.id}`);
  if (typeof c.latitude !== "number" || typeof c.longitude !== "number") {
    issues["Clients sans coords (invisibles carte)"].push(`${c.entreprise} (${c.ville||"?"})`);
  }
  if (!c.nbVelosCommandes) issues["Clients sans nbVelosCommandes"].push(`${c.entreprise}`);

  const nbCmd = Number(c.nbVelosCommandes) || 0;
  const totalSt = Number(c.stats?.totalVelos) || 0;
  if (nbCmd !== totalSt) {
    issues["Clients : nbVelosCommandes ≠ stats.totalVelos"]
      .push(`${c.entreprise} cmd=${nbCmd} totalVelos=${totalSt}`);
  }

  const velos = (velosByClient.get(c.id) || []).filter((v) => v.annule !== true);
  if (totalSt !== velos.length) {
    issues["Clients : stats.totalVelos ≠ count(vélos non annulés)"]
      .push(`${c.entreprise} totalVelos=${totalSt} vélos=${velos.length}`);
  }
  const livresReels = velos.filter((v) => v.dateLivraisonScan).length;
  const livresSt = Number(c.stats?.livres) || 0;
  if (livresReels !== livresSt) {
    issues["Clients : stats.livres ≠ count(vélos avec dateLivraisonScan)"]
      .push(`${c.entreprise} stats.livres=${livresSt} reels=${livresReels}`);
  }

  // Sum des planifs > devis
  const livs = (livraisonsByClient.get(c.id) || []).filter((l) => l.statut === "planifiee");
  const sumPlanif = livs.reduce((s, l) => s + (Number(l.nbVelos)||0), 0);
  if (sumPlanif > nbCmd && nbCmd > 0) {
    issues["Clients : sum(planifiees.nbVelos) > nbVelosCommandes"]
      .push(`${c.entreprise} planif=${sumPlanif} cmd=${nbCmd}`);
  }

  if (c.statut === "annulee" && livs.length > 0) {
    issues["Clients soft-cancelled mais avec livraisons planifiées actives"]
      .push(`${c.entreprise} (${livs.length} planif)`);
  }

  const key = String(c.entreprise || "").trim().toLowerCase();
  if (key) {
    if (!nameMap.has(key)) nameMap.set(key, []);
    nameMap.get(key).push(c.id);
  }
}
for (const [name, ids] of nameMap.entries()) {
  if (ids.length > 1) issues["Doublons clients (même nom)"].push(`"${name}" → ${ids.length} docs (${ids.join(", ")})`);
}

// Vélos orphelins
for (const d of vSnap.docs) {
  const o = d.data();
  if (o.clientId && !clientsById.has(o.clientId)) {
    issues["Vélos orphelins (clientId inexistant)"].push(`vélo ${d.id} clientId=${o.clientId} fnuci=${o.fnuci||"-"}`);
  }
}
// Livraisons orphelines + sans snapshot
for (const d of lSnap.docs) {
  const o = d.data();
  if (o.clientId && !clientsById.has(o.clientId)) {
    issues["Livraisons orphelines (clientId inexistant)"].push(`liv ${d.id} clientId=${o.clientId}`);
  }
  if (!o.clientSnapshot?.entreprise) {
    issues["Livraisons sans clientSnapshot.entreprise"].push(`liv ${d.id} clientId=${o.clientId}`);
  }
}
// FNUCI dupliqués
const fnuciMap = new Map();
for (const d of vSnap.docs) {
  const o = d.data();
  if (!o.fnuci) continue;
  const key = String(o.fnuci).toUpperCase();
  if (!fnuciMap.has(key)) fnuciMap.set(key, []);
  fnuciMap.get(key).push({ veloId: d.id, clientId: o.clientId });
}
for (const [fnuci, list] of fnuciMap.entries()) {
  if (list.length > 1) {
    issues["Vélos avec FNUCI dupliqué"].push(`${fnuci} → ${list.length} vélos`);
  }
}

// Print
let total = 0;
for (const [k, arr] of Object.entries(issues)) {
  if (arr.length === 0) continue;
  total += arr.length;
  console.log(`\n━━ ${k} (${arr.length}) ━━`);
  for (const x of arr.slice(0, 15)) console.log(`  ${x}`);
  if (arr.length > 15) console.log(`  … +${arr.length - 15} autres`);
}
console.log(`\n=== TOTAL ${total} incohérences ===`);
