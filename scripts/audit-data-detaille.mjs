import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").get();
const lSnap = await db.collection("livraisons").get();
const vSnap = await db.collection("velos").get();

const clientsById = new Map();
for (const d of cSnap.docs) clientsById.set(d.id, { id: d.id, ...d.data() });

// Group vélos par client
const velosByClient = new Map();
for (const d of vSnap.docs) {
  const o = d.data();
  if (!o.clientId) continue;
  if (!velosByClient.has(o.clientId)) velosByClient.set(o.clientId, []);
  velosByClient.get(o.clientId).push({ id: d.id, ...o });
}
const livraisonsByClient = new Map();
for (const d of lSnap.docs) {
  const o = d.data();
  if (!o.clientId) continue;
  if (!livraisonsByClient.has(o.clientId)) livraisonsByClient.set(o.clientId, []);
  livraisonsByClient.get(o.clientId).push({ id: d.id, ...o });
}

// === SECTION 1 : DOUBLONS L'AFRICA PARIS ===
console.log("\n━━━━━━━━━━ 1) DOUBLONS L'AFRICA PARIS ━━━━━━━━━━");
const africa = [...clientsById.values()].filter((c) =>
  String(c.entreprise || "").trim().toLowerCase() === "l'africa paris"
);
console.log(`${africa.length} docs trouvés :\n`);
console.log("ID                            | nbCmd | TotalVelos | Livrés | Velos | Livraisons | Adresse / Apporteur / créé");
console.log("─".repeat(140));
for (const c of africa) {
  const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule);
  const livres = vNonAnn.filter((v) => v.dateLivraisonScan).length;
  const livs = livraisonsByClient.get(c.id) || [];
  const created = c.createdAt?.toDate?.()?.toISOString?.()?.slice(0, 10) || "-";
  console.log(
    `${c.id.slice(0,28).padEnd(28)} | ${String(c.nbVelosCommandes||0).padEnd(5)} | ${String(c.stats?.totalVelos||0).padEnd(10)} | ${String(c.stats?.livres||0).padEnd(6)} | ${String(vNonAnn.length).padEnd(5)} | ${String(livs.length).padEnd(10)} | ${(c.adresse||"-").slice(0,30)} · ${c.apporteur||"-"} · ${created}`
  );
}

// === SECTION 2 : DOUBLONS LOCATEX / MILLENIUM ===
console.log("\n\n━━━━━━━━━━ 2) AUTRES DOUBLONS ━━━━━━━━━━");
for (const name of ["locatex", "millenium"]) {
  const list = [...clientsById.values()].filter((c) => String(c.entreprise || "").trim().toLowerCase() === name);
  console.log(`\n→ ${name.toUpperCase()} (${list.length} docs) :`);
  for (const c of list) {
    const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule);
    const livres = vNonAnn.filter((v) => v.dateLivraisonScan).length;
    const livs = livraisonsByClient.get(c.id) || [];
    console.log(`  ${c.id} · cmd=${c.nbVelosCommandes||0} · totalVelos=${c.stats?.totalVelos||0} · livrés=${livres} · livs=${livs.length} · ${c.adresse||"-"} · ${c.apporteur||"-"}`);
  }
}

// === SECTION 3 : 26 CLIENTS À DEVIS BIDON ===
console.log("\n\n━━━━━━━━━━ 3) CLIENTS nbVelosCommandes ≠ stats.totalVelos (suggestion correction) ━━━━━━━━━━");
console.log("Suggestion = count(vélos non annulés) si nbCmd actuel = 381 (clairement bidon) ou si entier propre");
console.log("Sinon : conserve nbCmd actuel mais align stats.totalVelos\n");
console.log("Entreprise                    | nbCmd actuel | totalVelos actuel | Vélos réels | Suggestion nbCmd");
console.log("─".repeat(120));
const corrections = [];
for (const c of [...clientsById.values()]) {
  const nbCmd = Number(c.nbVelosCommandes) || 0;
  const totalSt = Number(c.stats?.totalVelos) || 0;
  if (nbCmd === totalSt) continue;
  const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule);
  // Suggestion : si nbCmd = 381 (bug) ou = float bizarre, prends totalSt (= count vélos vrai)
  const isBidon = nbCmd === 381 || !Number.isInteger(nbCmd);
  const suggestion = isBidon ? totalSt : nbCmd;
  corrections.push({ c, suggestion, nbCmd, totalSt, vrais: vNonAnn.length });
}
for (const x of corrections) {
  const flag = x.nbCmd === 381 ? " 🚨" : (!Number.isInteger(x.nbCmd) ? " ⚠️float" : "");
  console.log(
    `${(x.c.entreprise||"?").slice(0,30).padEnd(30)} | ${String(x.nbCmd).padEnd(12)} | ${String(x.totalSt).padEnd(17)} | ${String(x.vrais).padEnd(11)} | → ${x.suggestion}${flag}`
  );
}

// === SECTION 4 : 4 CLIENTS stats.livres DÉSYNC ===
console.log("\n\n━━━━━━━━━━ 4) CLIENTS stats.livres désync (recalcul auto = count vélos avec dateLivraisonScan) ━━━━━━━━━━");
for (const c of [...clientsById.values()]) {
  const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule);
  const livresReels = vNonAnn.filter((v) => v.dateLivraisonScan).length;
  const livresSt = Number(c.stats?.livres) || 0;
  if (livresReels === livresSt) continue;
  console.log(`  ${c.entreprise} : stats.livres=${livresSt} → recalcul=${livresReels}`);
}

// === SECTION 5 : FNUCI DUPLIQUÉS ===
console.log("\n\n━━━━━━━━━━ 5) FNUCI DUPLIQUÉS ━━━━━━━━━━");
const fnuciMap = new Map();
for (const d of vSnap.docs) {
  const o = d.data();
  if (!o.fnuci) continue;
  const key = String(o.fnuci).toUpperCase();
  if (!fnuciMap.has(key)) fnuciMap.set(key, []);
  fnuciMap.get(key).push({ veloId: d.id, data: o });
}
for (const [fnuci, list] of fnuciMap.entries()) {
  if (list.length < 2) continue;
  console.log(`\n→ FNUCI ${fnuci} sur ${list.length} vélos :`);
  for (const v of list) {
    const c = clientsById.get(v.data.clientId);
    const livre = !!v.data.dateLivraisonScan;
    const monte = !!v.data.dateMontage;
    console.log(`  vélo ${v.veloId} · client=${c?.entreprise||"?"} · livré=${livre} · monté=${monte} · annule=${!!v.data.annule}`);
  }
}

// === SECTION 6 : MANI UNIVERS ===
console.log("\n\n━━━━━━━━━━ 6) DIVERS ━━━━━━━━━━");
const mani = [...clientsById.values()].find((c) => String(c.entreprise||"").includes("MANI UNIVERS"));
if (mani) {
  const v = velosByClient.get(mani.id) || [];
  console.log(`MANI UNIVERS (${mani.id}) : nbCmd=${mani.nbVelosCommandes} totalSt=${mani.stats?.totalVelos} vélos doc=${v.length}`);
}
const alyssar = [...clientsById.values()].find((c) => String(c.entreprise||"").includes("ALYSSAR"));
if (alyssar) {
  const v = velosByClient.get(alyssar.id) || [];
  console.log(`ALYSSAR (${alyssar.id}) : nbCmd=${alyssar.nbVelosCommandes||"VIDE"} totalSt=${alyssar.stats?.totalVelos} vélos doc=${v.length}`);
}

// === SOMMES ===
console.log("\n\n━━━━━━━━━━ TOTAUX ━━━━━━━━━━");
let sumNbCmd = 0, sumTotalSt = 0, sumVraisVelos = 0;
for (const c of clientsById.values()) {
  sumNbCmd += Number(c.nbVelosCommandes) || 0;
  sumTotalSt += Number(c.stats?.totalVelos) || 0;
  const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule);
  sumVraisVelos += vNonAnn.length;
}
console.log(`SUM(nbVelosCommandes) actuel = ${sumNbCmd}`);
console.log(`SUM(stats.totalVelos) actuel = ${sumTotalSt}  ← affiché dans le dashboard`);
console.log(`COUNT(vélos non annulés)     = ${sumVraisVelos}`);
console.log(`\nSi on applique la correction (nbCmd = totalSt pour les bidons), le total devis remontera à environ : ${sumNbCmd - corrections.filter(x => x.nbCmd === 381).reduce((s,x) => s + (x.nbCmd - x.suggestion), 0)}`);
