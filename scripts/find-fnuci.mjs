// Cherche un FNUCI précis dans la base + son historique.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const TARGET = process.argv[2] || "BC6AHEK88E";
console.log(`\n=== Recherche FNUCI "${TARGET}" ===\n`);

// 1. Match exact
const exactSnap = await db.collection("velos").where("fnuci", "==", TARGET).get();
console.log(`Match exact : ${exactSnap.size} vélo(s)\n`);
for (const d of exactSnap.docs) {
  const v = d.data();
  console.log(`  veloId=${d.id}`);
  console.log(`  fnuci=${v.fnuci}`);
  console.log(`  clientId=${v.clientId}`);
  console.log(`  annule=${v.annule || false}`);
  const fmt = (x) => {
    if (!x) return "—";
    if (x.toDate) return x.toDate().toISOString().slice(0, 19);
    return String(x).slice(0, 19);
  };
  console.log(`  datePreparation=${fmt(v.datePreparation)}`);
  console.log(`  dateChargement=${fmt(v.dateChargement)}`);
  console.log(`  dateLivraisonScan=${fmt(v.dateLivraisonScan)}`);
  console.log(`  dateMontage=${fmt(v.dateMontage)}`);
  console.log(`  fnuciPrevious=${v.fnuciPrevious || "—"} (avant correction)`);
  if (v.clientId) {
    const c = await db.collection("clients").doc(v.clientId).get();
    if (c.exists) console.log(`  client=${c.data().entreprise}`);
  }
  console.log("");
}

// 2. Match dans fnuciPrevious (corrections d'hallucinations Gemini)
const prevSnap = await db.collection("velos").where("fnuciPrevious", "==", TARGET).get();
if (prevSnap.size > 0) {
  console.log(`\nMatch dans fnuciPrevious (= ce vélo a été CORRIGÉ depuis ce FNUCI) : ${prevSnap.size}\n`);
  for (const d of prevSnap.docs) {
    const v = d.data();
    console.log(`  veloId=${d.id} : ${TARGET} -> ${v.fnuci} (nouveau)`);
    console.log(`  fixedAt=${v.fnuciFixedAt?.toDate?.()?.toISOString?.() || "?"}`);
    console.log(`  reason=${v.fnuciFixedReason || "?"}`);
  }
}

// 3. Recherche fuzzy : chars confusables (S↔5↔6↔8, 0↔O↔D, Z↔2, B↔8, etc.)
console.log(`\n=== Recherche fuzzy (chars confusables OCR Gemini) ===\n`);
const SUBS = [
  ["0", "O"], ["O", "0"], ["0", "D"], ["D", "0"],
  ["5", "S"], ["S", "5"], ["S", "6"], ["6", "S"], ["S", "8"], ["8", "S"],
  ["8", "B"], ["B", "8"], ["6", "G"], ["G", "6"],
  ["1", "I"], ["I", "1"], ["1", "L"], ["L", "1"],
  ["Z", "2"], ["2", "Z"],
];
const candidates = new Set();
for (let i = 0; i < TARGET.length; i++) {
  const ch = TARGET[i];
  for (const [a, b] of SUBS) {
    if (ch === a) {
      candidates.add(TARGET.slice(0, i) + b + TARGET.slice(i + 1));
    }
  }
}
console.log(`${candidates.size} variantes à tester\n`);
for (const cand of candidates) {
  if (cand === TARGET) continue;
  const s = await db.collection("velos").where("fnuci", "==", cand).get();
  if (s.size > 0) {
    for (const d of s.docs) {
      const v = d.data();
      const c = v.clientId ? await db.collection("clients").doc(v.clientId).get() : null;
      console.log(`  ⚠ MATCH FUZZY : ${cand} (${v.annule ? "ANNULÉ" : "actif"}) clientId=${v.clientId} client=${c?.data()?.entreprise || "?"}`);
    }
  }
}

// 4. Cherche dans bonsEnlevement / commandes Tiffany pour voir si le FNUCI a transité
// Note : les bons stockent souvent une référence textuelle, pas le FNUCI direct

console.log(`\n=== Fin recherche ===\n`);
process.exit(0);
