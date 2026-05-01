// Distribution taille des commandes restantes pour aider Yoann à choisir
// entre montage chez client (cartons) vs montage atelier (vélos assemblés).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const cSnap = await db.collection("clients").get();
const buckets = {
  "1-3": 0,
  "4-9": 0,
  "10-19": 0,
  "20-34": 0,
  "35+": 0,
};
const detail = [];
let totalRestants = 0;
let totalCommandes = 0;
let totalLivres = 0;
let nbClientsRestants = 0;

for (const d of cSnap.docs) {
  const c = d.data();
  if (c.statut === "annulee") continue;
  const cmd = Number(c.nbVelosCommandes || 0);
  const liv = Number(c.stats?.livres || 0);
  totalCommandes += cmd;
  totalLivres += liv;
  const reste = Math.max(0, cmd - liv);
  if (reste === 0) continue;
  totalRestants += reste;
  nbClientsRestants++;
  detail.push({ name: c.entreprise || d.id, reste, cmd, liv });
  if (reste <= 3) buckets["1-3"]++;
  else if (reste <= 9) buckets["4-9"]++;
  else if (reste <= 19) buckets["10-19"]++;
  else if (reste <= 34) buckets["20-34"]++;
  else buckets["35+"]++;
}

console.log("\n=== Distribution clients restants par volume de vélos ===\n");
console.log(`Total clients avec vélos restants : ${nbClientsRestants}`);
console.log(`Total vélos restants à livrer    : ${totalRestants}`);
console.log(`Total vélos commandés (objectif) : ${totalCommandes}`);
console.log(`Total vélos déjà livrés          : ${totalLivres}\n`);

console.log("Tranche       | Nb clients | % clients | Vélos cumulés | % vélos");
console.log("--------------+------------+-----------+---------------+--------");
const cumulVelos = { "1-3": 0, "4-9": 0, "10-19": 0, "20-34": 0, "35+": 0 };
for (const c of detail) {
  if (c.reste <= 3) cumulVelos["1-3"] += c.reste;
  else if (c.reste <= 9) cumulVelos["4-9"] += c.reste;
  else if (c.reste <= 19) cumulVelos["10-19"] += c.reste;
  else if (c.reste <= 34) cumulVelos["20-34"] += c.reste;
  else cumulVelos["35+"] += c.reste;
}
for (const tranche of ["1-3", "4-9", "10-19", "20-34", "35+"]) {
  const nb = buckets[tranche];
  const v = cumulVelos[tranche];
  const pctC = nbClientsRestants > 0 ? ((nb / nbClientsRestants) * 100).toFixed(1) : 0;
  const pctV = totalRestants > 0 ? ((v / totalRestants) * 100).toFixed(1) : 0;
  console.log(`${tranche.padEnd(13)} | ${String(nb).padStart(10)} | ${String(pctC).padStart(7)}%  | ${String(v).padStart(13)} | ${String(pctV).padStart(5)}%`);
}

console.log("\n=== Top 10 plus grosses commandes restantes ===\n");
detail.sort((a, b) => b.reste - a.reste);
for (const c of detail.slice(0, 10)) {
  console.log(`  ${String(c.reste).padStart(3)} vélos · ${c.name}`);
}

// Capacités camion
console.log("\n=== Capacités camions ===\n");
console.log("Cartons (montage client) :");
console.log("  - Gros camion : 70 vélos");
console.log("  - Petit camion : 30 vélos (estimation)");
console.log("Vélos montés atelier (montage atelier) :");
console.log("  - Gros camion : 35 vélos");
console.log("  - Petit camion : 20 vélos");

// Estimation nb tournées par scenario
console.log("\n=== Estimation tournées totales pour livrer les " + totalRestants + " vélos restants ===\n");

function estimateTrips(clients, bigCap, smallCap) {
  // Stratégie simple : chaque client se résout par lui-même.
  // - Si client ≤ smallCap → 1 tournée petit camion possible (mais on optimise)
  // - Si client > bigCap → ceil(reste / bigCap) tournées gros camion
  // Heuristique : on prend gros camion par défaut sauf si client unique ≤ smallCap
  // (réalité : on bin-pack plusieurs petits clients par tournée, mais ici on
  // ne le fait pas — c'est une borne SUPÉRIEURE)
  let trips = 0;
  let velosTransportes = 0;
  for (const c of clients) {
    let r = c.reste;
    while (r > 0) {
      const cap = bigCap;
      const take = Math.min(r, cap);
      trips++;
      velosTransportes += take;
      r -= take;
    }
  }
  return { trips, velosTransportes };
}

function estimateTripsBinPack(clients, bigCap) {
  // Bin packing First Fit Decreasing : meilleur cas réaliste pour montage
  // atelier (1-3 clients par tournée).
  const sorted = [...clients].sort((a, b) => b.reste - a.reste);
  const bins = [];
  for (const c of sorted) {
    let placed = false;
    let r = c.reste;
    // Si client > bigCap, il a forcément ses propres tournées dédiées
    while (r > bigCap) {
      bins.push({ load: bigCap, clients: [c.name + " (partial)"] });
      r -= bigCap;
    }
    if (r === 0) continue;
    for (const b of bins) {
      if (b.load + r <= bigCap) {
        b.load += r;
        b.clients.push(c.name);
        placed = true;
        break;
      }
    }
    if (!placed) bins.push({ load: r, clients: [c.name] });
  }
  return { trips: bins.length, totalLoad: bins.reduce((s, b) => s + b.load, 0) };
}

// Scenario A : tout en cartons + montage client
const sA = estimateTripsBinPack(detail, 70);
const sAsmall = estimateTripsBinPack(detail, 30);
// Scenario B : tout en vélos montés
const sB = estimateTripsBinPack(detail, 35);
const sBsmall = estimateTripsBinPack(detail, 20);

console.log("Scénario A : cartons + montage chez client (gros camion 70 v.)");
console.log(`  Tournées nécessaires (bin packing optimal) : ${sA.trips}`);
console.log(`  Soit ~${(totalRestants / sA.trips).toFixed(1)} vélos/tournée moyenne\n`);

console.log("Scénario B : vélos montés atelier (gros camion 35 v.)");
console.log(`  Tournées nécessaires (bin packing optimal) : ${sB.trips}`);
console.log(`  Soit ~${(totalRestants / sB.trips).toFixed(1)} vélos/tournée moyenne\n`);

console.log("Différence : " + (sB.trips - sA.trips) + " tournées en plus pour scénario B");

process.exit(0);
