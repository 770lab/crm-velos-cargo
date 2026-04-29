// Cloud Function `proposeTournee` — vague 3 migration GAS → Firestore.
//
// Réplique fidèlement la logique de `gas/Code.js:proposeTournee` (5393-5587)
// + helpers (_capaciteDuJour, _clientsLivrablesPourDate, _buildProposeTourneePrompt,
// _sanitizeProposeSplit, _extractFirstJsonObject) en lisant Firestore au lieu
// du Sheet GAS.
//
// Contrat de réponse identique à GAS pour ne pas casser le frontend
// (day-planner-modal.tsx qui consomme `ProposeResponse`).

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// AXDIS PRO - Le Blanc-Mesnil (cf. gas/Code.js:5388-5389).
const DEPOT_LAT = 48.9356;
const DEPOT_LNG = 2.4636;

const PLAFOND_JOUR = 480; // 8h en minutes
const RECHARGE_MIN = 30;

// ----------------------- Types Firestore -----------------------

type Camion = {
  id: string;
  nom: string;
  type: string;
  capaciteVelos: number;
  peutEntrerParis: boolean;
  actif?: boolean;
};

type Membre = {
  id: string;
  nom: string;
  role: string;
  actif?: boolean;
};

type Client = {
  id: string;
  entreprise: string;
  ville: string;
  codePostal: string;
  nbVelosCommandes: number;
  nbVelosLivres: number;
  latitude: number | null;
  longitude: number | null;
  apporteur?: string | null;
};

type Livraison = {
  clientId: string;
  date: string;
  statut: string;
  nbVelos: number;
  tourneeId: string;
};

type CamionAvecRestant = Camion & { restant: number };

type ClientEnrichi = {
  id: string;
  entreprise: string;
  ville: string;
  codePostal: string;
  nbVelosRestants: number;
  estParis: boolean;
  distanceKmDepot: number;
  apporteur: string | null;
};

type AffectesParTournee = Record<
  string,
  Array<{ clientId: string; nbVelos: number; client: Client | null }>
>;

type Capacite = {
  camions: Camion[];
  chauffeurs: Membre[];
  chefs: Membre[];
  monteurs: Membre[];
  capaciteTotaleVelos: number;
};

type ClientTropGros = {
  clientId: string;
  entreprise: string;
  ville: string;
  nbVelosRestants: number;
  raison: string;
};

type ProposeContext = {
  date: string;
  mode: string;
  camionsAvecRestant: CamionAvecRestant[];
  clientsEnrichis: ClientEnrichi[];
  clientsTropGros: ClientTropGros[];
  capa: Capacite;
  totalAffecte: number;
  finishReason?: string | null;
};

// ----------------------- Helpers métier -----------------------

function clientLivrable(c: Client): boolean {
  if (!c) return false;
  const nbCmd = Number(c.nbVelosCommandes || 0);
  const nbLivre = Number(c.nbVelosLivres || 0);
  if (nbCmd <= 0) return false;
  if (nbLivre >= nbCmd) return false;
  if (c.latitude == null || c.longitude == null) return false;
  return true;
}

function distanceKm(
  lat1: number | null,
  lng1: number | null,
  lat2: number | null,
  lng2: number | null,
): number {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 9999;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function estParis(client: { codePostal?: string }): boolean {
  const cp = String(client.codePostal || "").trim();
  return /^750\d{2}$/.test(cp) && Number(cp) >= 75001 && Number(cp) <= 75020;
}

// ----------------------- Lecture Firestore -----------------------

async function loadCapaciteDuJour(date: string): Promise<Capacite> {
  const db = getFirestore();
  // 1) Dispos actives pour la date
  const dSnap = await db
    .collection("disponibilites")
    .where("date", "==", date)
    .get();
  const camionIds: string[] = [];
  const chauffeurIds: string[] = [];
  const chefIds: string[] = [];
  const monteurIds: string[] = [];
  for (const d of dSnap.docs) {
    const o = d.data() as { ressourceType?: string; ressourceId?: string; actif?: boolean };
    if (o.actif === false) continue;
    if (!o.ressourceId) continue;
    if (o.ressourceType === "camion") camionIds.push(o.ressourceId);
    else if (o.ressourceType === "chauffeur") chauffeurIds.push(o.ressourceId);
    else if (o.ressourceType === "chef") chefIds.push(o.ressourceId);
    else if (o.ressourceType === "monteur") monteurIds.push(o.ressourceId);
  }

  // 2) Flotte active
  const flotteSnap = await db.collection("camions").get();
  const flotte: Camion[] = flotteSnap.docs
    .map((doc) => {
      const o = doc.data() as Partial<Camion>;
      return {
        id: doc.id,
        nom: String(o.nom || ""),
        type: String(o.type || ""),
        capaciteVelos: Number(o.capaciteVelos || 0),
        peutEntrerParis: !!o.peutEntrerParis,
        actif: o.actif !== false,
      };
    })
    .filter((c) => c.actif);

  // 3) Équipe active
  const equipeSnap = await db.collection("equipe").get();
  const equipe: Membre[] = equipeSnap.docs
    .map((doc) => {
      const o = doc.data() as Partial<Membre>;
      return {
        id: doc.id,
        nom: String(o.nom || ""),
        role: String(o.role || ""),
        actif: o.actif !== false,
      };
    })
    .filter((m) => m.actif);

  const camions = flotte.filter((c) => camionIds.includes(c.id));
  const chauffeurs = equipe.filter(
    (m) => m.role === "chauffeur" && chauffeurIds.includes(m.id),
  );
  const chefs = equipe.filter((m) => m.role === "chef" && chefIds.includes(m.id));
  const monteurs = equipe.filter(
    (m) => m.role === "monteur" && monteurIds.includes(m.id),
  );

  return {
    camions,
    chauffeurs,
    chefs,
    monteurs,
    capaciteTotaleVelos: camions.reduce((s, c) => s + (c.capaciteVelos || 0), 0),
  };
}

async function loadClientsLivrablesPourDate(date: string): Promise<{
  affectes: AffectesParTournee;
  dispo: Client[];
}> {
  const db = getFirestore();
  // Tous les clients
  const cSnap = await db.collection("clients").get();
  const clientsParId: Record<string, Client> = {};
  for (const doc of cSnap.docs) {
    const o = doc.data() as Partial<Client>;
    clientsParId[doc.id] = {
      id: doc.id,
      entreprise: String(o.entreprise || ""),
      ville: String(o.ville || ""),
      codePostal: String(o.codePostal || ""),
      nbVelosCommandes: Number(o.nbVelosCommandes || 0),
      nbVelosLivres: Number(o.nbVelosLivres || 0),
      latitude: o.latitude == null ? null : Number(o.latitude),
      longitude: o.longitude == null ? null : Number(o.longitude),
      apporteur: o.apporteur || null,
    };
  }

  // Toutes les livraisons (tous statuts) pour identifier celles qui couvrent
  // déjà un client (peu importe la date — règle métier : 1 client = 1
  // livraison intégrale, pas de split entre dates).
  const lSnap = await db.collection("livraisons").get();
  const livraisons: Livraison[] = lSnap.docs.map((doc) => {
    const o = doc.data() as Partial<Livraison> & { date?: unknown };
    let dateStr = "";
    const raw: unknown = o.date;
    if (raw && typeof (raw as { toDate?: () => Date }).toDate === "function") {
      dateStr = (raw as { toDate: () => Date }).toDate().toISOString().slice(0, 10);
    } else if (typeof raw === "string") {
      dateStr = raw.slice(0, 10);
    } else if (Object.prototype.toString.call(raw) === "[object Date]") {
      dateStr = (raw as Date).toISOString().slice(0, 10);
    }
    return {
      clientId: String(o.clientId || ""),
      date: dateStr,
      statut: String(o.statut || ""),
      nbVelos: Number(o.nbVelos || 0),
      tourneeId: String(o.tourneeId || ""),
    };
  });

  const affectesParTournee: AffectesParTournee = {};
  const clientIdsAvecLivraisonPending = new Set<string>();
  for (const lv of livraisons) {
    const statut = lv.statut.toLowerCase();
    if (statut === "annulee" || statut === "annulée" || statut === "livree" || statut === "livrée") continue;
    clientIdsAvecLivraisonPending.add(lv.clientId);
    if (lv.date === date) {
      const tid = lv.tourneeId || "";
      if (!affectesParTournee[tid]) affectesParTournee[tid] = [];
      affectesParTournee[tid].push({
        clientId: lv.clientId,
        nbVelos: lv.nbVelos,
        client: clientsParId[lv.clientId] || null,
      });
    }
  }

  const dispo: Client[] = [];
  for (const cid of Object.keys(clientsParId)) {
    if (clientIdsAvecLivraisonPending.has(cid)) continue;
    const c = clientsParId[cid];
    if (!clientLivrable(c)) continue;
    dispo.push(c);
  }

  return { affectes: affectesParTournee, dispo };
}

// ----------------------- Build prompt -----------------------

function buildProposeTourneePrompt(
  date: string,
  camions: CamionAvecRestant[],
  clients: ClientEnrichi[],
  affectesExistants: AffectesParTournee,
  mode: string,
  capa: Capacite,
): string {
  const camionsStr = camions
    .map((c) => {
      const noteRetrait =
        c.type === "retrait"
          ? ", RETRAIT CLIENT (le client vient chercher avec son propre véhicule, pas besoin de chauffeur côté nous, mais besoin monteurs+chef pour préparer/assembler avant remise)"
          : "";
      const capStr =
        c.type === "retrait" && c.capaciteVelos === 0
          ? "capacité non plafonnée (à toi de mettre un volume raisonnable selon les monteurs dispo)"
          : `capacité ${c.capaciteVelos} vélos`;
      return `- ${c.nom} (id=${c.id}, type=${c.type}, ${capStr}, ${
        c.peutEntrerParis ? "PEUT entrer Paris" : "NE PEUT PAS entrer Paris (>3.5T)"
      }${noteRetrait})`;
    })
    .join("\n");

  const fmtMembre = (m: Membre) => `${m.nom} (id=${m.id})`;
  const equipeStr =
    "ÉQUIPE DISPONIBLE CE JOUR (utilise les ids exacts dans les tournées) :\n" +
    `- Chauffeurs (${capa.chauffeurs.length}) : ${capa.chauffeurs.map(fmtMembre).join(", ") || "aucun"}\n` +
    `- Chefs d'équipe (${capa.chefs.length}) : ${capa.chefs.map(fmtMembre).join(", ") || "aucun"}\n` +
    `- Monteurs (${capa.monteurs.length}) : ${capa.monteurs.map(fmtMembre).join(", ") || "aucun"}`;

  const clientsStr = clients
    .map(
      (c) =>
        `- ${c.entreprise} (id=${c.id}, ${c.codePostal} ${c.ville}, ${c.nbVelosRestants} vélos restants, ${c.distanceKmDepot}km dépôt${
          c.estParis ? ", PARIS intra-muros" : ""
        })`,
    )
    .join("\n");

  let affectesStr = "Aucune affectation existante.";
  const affectesIds = Object.keys(affectesExistants);
  if (affectesIds.length > 0) {
    affectesStr = "Tournées déjà partiellement remplies (à compléter sans modifier l'existant) :\n";
    for (const tid of affectesIds) {
      const lignes = affectesExistants[tid];
      const totalT = lignes.reduce((s, l) => s + l.nbVelos, 0);
      affectesStr += `- Tournée ${tid} : ${lignes.length} arrêt(s), ${totalT} vélos\n`;
      for (const l of lignes) {
        affectesStr += `    · ${l.client ? l.client.entreprise : l.clientId} (${l.nbVelos}v)\n`;
      }
    }
  }

  const modeInstr =
    mode === "fromScratch"
      ? "Mode FROM SCRATCH : ignore les tournées existantes et propose une ventilation complète à partir de zéro."
      : "Mode FILL GAPS : si des tournées existent déjà (cf bloc 'Tournées déjà partiellement remplies'), NE LES MODIFIE PAS. Propose seulement des AJOUTS de clients dans ces tournées si la capacité du camion le permet, ou de nouvelles tournées avec les camions encore non utilisés.";

  return [
    "Tu es un planificateur de tournées de livraison de vélos cargo.",
    `DÉPÔT DE DÉPART : AXDIS PRO, 2 Rue des Frères Lumière, 93150 Le Blanc-Mesnil (lat ${DEPOT_LAT}, lng ${DEPOT_LNG}).`,
    `DATE DE LIVRAISON : ${date}`,
    "",
    "RESSOURCES DISPONIBLES — CAMIONS :",
    camionsStr,
    "",
    equipeStr,
    "",
    affectesStr,
    "",
    "CLIENTS À LIVRER (triés par distance dépôt croissante) :",
    clientsStr,
    "",
    "PARAMÈTRES TEMPS (estimation pour budgéter la journée) :",
    "- Journée de TRAVAIL effectif : 8h (480 min). dureeMinutesEstimee mesure le travail effectif, PAS la durée de présence.",
    "- Pause déjeuner : 45 min vers midi, NON comptée dans dureeMinutesEstimee (gérée séparément côté UI). Tu n'as donc pas à l'inclure dans tes calculs — vise 480 min de travail pur.",
    "- Premier chargement au dépôt entre 8h30 et 9h00. Donc fin de journée de présence vers 17h15 (8h30 + 8h travail + 45min pause).",
    "- Vitesse moyenne en ville : 30 km/h (donc 2 min par km de trajet).",
    "- Montage : 12 min/vélo, parallélisable entre les monteurs (durée_montage = nbVelos * 12 / nbMonteurs).",
    "- Rechargement au dépôt entre 2 tournées du même camion : 30 min (chargement + retour dépôt).",
    "- Estimation durée d'une tournée : (km_aller_retour * 2 min/km) + (totalVelos * 12 min / nbMonteurs).",
    "",
    "CONTRAINTES STRICTES :",
    "1. Un camion 'NE PEUT PAS entrer Paris' (>3.5T) ne peut PAS livrer un client marqué 'PARIS intra-muros'. Affecte ces clients uniquement aux camions qui PEUVENT entrer Paris.",
    "2. La somme des vélos d'une tournée ≤ capacité du camion (capaciteVelos). NE DÉPASSE JAMAIS la capacité. Vérifie le total avant de répondre.",
    `3. ${modeInstr}`,
    "4. Boucle Paris en priorité (vide les arrondissements 75001-75020 d'abord avec les petits camions, libère les chauffeurs vite).",
    "5. Pour chaque tournée, ordonne les clients du PLUS PROCHE au PLUS LOIN du dépôt.",
    "6. Maximise le nombre TOTAL de vélos livrés ce jour, mais SANS sacrifier la cohérence géographique : ne mélange pas un client de Bordeaux avec un client de Lille.",
    "7. INTERDICTION DE SPLITTER UN CLIENT. Chaque client doit recevoir TOUS ses vélos (nbVelosRestants) en UNE SEULE livraison dans UNE SEULE tournée. Si la commande d'un client ne tient pas dans le camion auquel tu l'affectes, choisis un autre camion plus gros, OU laisse ce client dans clientsNonAffectes avec raison='commande trop grosse pour la flotte du jour'. Le nbVelos d'un arrêt doit TOUJOURS = nbVelosRestants du client.",
    "8. CHAQUE CAMION ACTIVÉ DOIT AVOIR ≥ 1 TOURNÉE. Si un camion ne sert à rien (aucun client compatible), mets-le quand même dans tournees[] avec arrets=[] et motifGlobal expliquant pourquoi. Ne fusionne JAMAIS les arrêts de deux camions différents dans une seule tournée — chaque camion roule séparément avec son propre chauffeur.",
    "9. INTERDICTION D'ARRÊT FANTÔME. Chaque arrêt doit avoir nbVelos > 0. Pas de stop avec 0 vélo.",
    "10. MULTI-TOURNÉES PAR CAMION : règle de DERNIER RECOURS (cf. règle 17 pour la priorité). Si après une 1ère tournée d'un camion il reste du temps avant la fin de journée (8h - durée_T1 - 30 min rechargement ≥ durée_T2 estimée) ET qu'il reste des clients compatibles non affectés ET TOUS LES AUTRES CAMIONS ACTIFS ONT DÉJÀ AU MOINS 1 TOURNÉE, propose une 2ème tournée pour ce camion. Plusieurs entrées dans tournees[] peuvent partager le même camionId — séquencées via ordreCamion (1, 2, 3).",
    "11. ASSIGNATION ÉQUIPE PAR TOURNÉE : pour chaque tournée tu DOIS remplir chauffeurId (1 chauffeur), chefEquipeIds (1 chef minimum), et monteurIds (≥ 1 monteur). Utilise les ids exacts du bloc ÉQUIPE DISPONIBLE. Règles d'allocation :",
    "    a) Tournées séquentielles d'un MÊME camion (ordreCamion 1, 2, 3) : peuvent partager la même équipe (ils reviennent au dépôt entre).",
    "    b) Tournées parallèles de camions DIFFÉRENTS : équipes DISTINCTES (un chauffeur ne peut pas conduire deux camions en même temps, idem chef).",
    "    c) Distribue les monteurs sur les tournées parallèles selon le volume de vélos (plus de monteurs sur les grosses tournées). Exemple : 5 monteurs + 2 tournées parallèles 60v / 30v → 4 monteurs sur la grosse + 1 sur la petite (ou plus équilibré si l'effectif le permet).",
    "    d) Si tu manques de chauffeurs/chefs pour le nombre de tournées parallèles que tu voudrais, REDUIS le nombre de tournées parallèles (mets les clients en clientsNonAffectes avec raison='équipe insuffisante').",
    "12. PLAFOND DUR PAR TOURNÉE INDIVIDUELLE : dureeMinutesEstimee ≤ 480 min (8h). Si tu calcules > 480 pour une tournée donnée, tu DOIS la découper en T1 + T2 (même camionId, ordreCamion 1 puis 2) en répartissant les arrêts entre elles. Vérifie chaque dureeMinutesEstimee AVANT de répondre. Les tournées de 9h, 10h, 11h sont INTERDITES, pas de cas spécial.",
    "13. RÈGLES MONTEURS — pas de double comptage : un monteur peut figurer dans plusieurs tournées séquentielles d'un MÊME camion (règle 11.a) — c'est attendu. Mais sur les tournées PARALLÈLES (camions différents qui roulent simultanément), un monteur donné NE PEUT apparaître QUE dans UNE seule de ces tournées parallèles. Sur la journée entière, le nombre de monteurs uniques (déduplication par id) doit être ≤ au nombre de monteurs disponibles annoncé dans ÉQUIPE DISPONIBLE.",
    "14. PLAFOND DUR CUMULÉ PAR CAMION SUR LA JOURNÉE : pour chaque camionId, somme(dureeMinutesEstimee de toutes ses tournées) + 30 × (nb_tournées_ce_camion - 1) ≤ 480 min. Exemple : si tu mets T1=180min et T2=180min sur le même camion, cumul = 180+180+30 = 390 min ≤ 480, OK. Mais T1+T2+T3 à 180min chacune = 540+60 = 600 min > 480 → INTERDIT, tu dois soit raccourcir une tournée, soit RETIRER une tournée et mettre ses arrêts en clientsNonAffectes avec raison='journée trop courte cumulée sur ce camion'. PAS DE 5 TOURNÉES À 3H SUR LE MÊME CAMION — un camion physique ne peut pas rouler 16h dans la journée. Vérifie le cumul par camion AVANT de répondre.",
    "15. PLAFOND DUR : MAX 3 TOURNÉES PAR CAMION PAR JOUR (ordreCamion ∈ {1, 2, 3}). Si tu n'arrives pas à caser tous les clients en 3 tournées par camion, le surplus VA en clientsNonAffectes — n'invente pas une 4e, 5e, 35e tournée. Vérifie ce plafond AVANT de répondre.",
    "16. RÉPONSE COMPACTE — RÈGLE TOKENS : tu as un budget JSON limité. Garde tous les champs texte (motif, motifGlobal, raison, resume) courts (< 80 caractères chacun). Pas de raisonnement détaillé dans le JSON, juste une raison synthétique. Si tu sens que la réponse va dépasser, AGRÈGE plusieurs petits camions en moins de tournées et mets le reste dans clientsNonAffectes.",
    "17. PRIORITÉ PARALLÉLISATION (règle anti-empilement) : si tu as N camions actifs et M chauffeurs (M ≥ N), tu DOIS d'abord remplir N tournées parallèles (UNE par camion, UNE par chauffeur) AVANT de commencer une 2e tournée séquentielle sur un camion déjà utilisé. Une tournée séquentielle (multi-tournées sur le même camion) coûte 30 min de rechargement et fatigue le chauffeur ; mieux vaut paralléliser quand on a les ressources. Exception : un client de XX vélos qui ne tient que dans le plus gros camion → mets-le dans le plus gros, et utilise les petits camions pour le reste. Vérifie : pour chaque camion actif sans tournée, tu DOIS justifier 'aucun client compatible' dans motifGlobal — sinon redistribue les clients pour utiliser ce camion en parallèle.",
    "18. FIN DE JOURNÉE STRICTE — RETOUR DÉPÔT ≤ 18h00 : pour CHAQUE tournée individuelle, l'heure de fin (départ + dureeMinutesEstimee + 45 min pause si traverse midi + trajet retour dépôt) doit être ≤ 18h00. Premier départ dépôt vers 8h30-9h00 → fenêtre travail = 8h30-18h00 = 9h30 max présence (dont 45 min pause = 8h45 travail). Si une tournée que tu prépares se termine à 19h, 20h, ou 27h, c'est INTERDIT — tu DOIS soit raccourcir, soit retirer des arrêts vers clientsNonAffectes avec raison='retour dépôt > 18h impossible'. Pour les multi-tournées séquentielles : T2 démarre à fin(T1)+30min ; si fin(T2) > 18h, ne fais PAS la T2.",
    "",
    "FORMAT DE RÉPONSE (JSON STRICT, rien d'autre) :",
    'RAPPEL : tu réponds avec UN SEUL objet JSON, jamais deux à la suite. Pas de "correction" ou "version améliorée" en deuxième objet — un seul objet final.',
    "{",
    '  "tournees": [',
    "    {",
    '      "camionId": "...",',
    '      "camionNom": "...",',
    '      "ordreCamion": 1,',
    '      "totalVelos": N,',
    '      "dureeMinutesEstimee": N,',
    '      "chauffeurId": "...",',
    '      "chefEquipeIds": ["..."],',
    '      "monteurIds": ["...", "..."],',
    '      "arrets": [',
    '        { "clientId": "...", "entreprise": "...", "nbVelos": N, "distanceKmDepot": N, "motif": "raison courte" }',
    "      ],",
    '      "motifGlobal": "pourquoi cette ventilation pour ce camion + estimation temps"',
    "    }",
    "  ],",
    '  "clientsNonAffectes": [',
    '    { "clientId": "...", "entreprise": "...", "nbVelos": N, "raison": "trop loin / pas de camion adapté / capacité saturée / équipe insuffisante" }',
    "  ],",
    '  "resume": "phrase courte expliquant la stratégie globale et le total de tournées"',
    "}",
  ].join("\n");
}

// ----------------------- Parse + sanitize -----------------------

function extractFirstJsonObject(s: string): string | null {
  if (!s || typeof s !== "string") return null;
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s.charAt(i);
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

type Arret = {
  clientId?: string;
  entreprise?: string;
  nbVelos?: number;
  distanceKmDepot?: number;
  motif?: string;
};
type Tournee = {
  camionId?: string;
  camionNom?: string;
  ordreCamion?: number;
  totalVelos?: number;
  dureeMinutesEstimee?: number;
  chauffeurId?: string;
  chefEquipeIds?: string[];
  monteurIds?: string[];
  arrets?: Arret[];
  motifGlobal?: string;
};
type ClientNonAffecte = { clientId: string; entreprise: string; nbVelos: number; raison: string };
type Proposition = {
  tournees: Tournee[];
  clientsNonAffectes: ClientNonAffecte[];
  warnings?: string[];
  resume?: string;
};

function sanitizeProposeSplit(
  parsed: Proposition,
  clientsEnrichis: ClientEnrichi[],
  camions: CamionAvecRestant[],
  clientsTropGros: ClientTropGros[],
): void {
  if (!parsed || !Array.isArray(parsed.tournees)) return;
  const byId: Record<string, ClientEnrichi> = {};
  for (const c of clientsEnrichis) byId[String(c.id)] = c;
  const capByCamion: Record<string, CamionAvecRestant> = {};
  for (const c of camions) capByCamion[String(c.id)] = c;
  const capaMax = camions.reduce(
    (m, c) => (c.type === "retrait" ? m : Math.max(m, Number(c.capaciteVelos) || 0)),
    0,
  );
  const aRetrait = camions.some((c) => c.type === "retrait");

  parsed.clientsNonAffectes = Array.isArray(parsed.clientsNonAffectes)
    ? parsed.clientsNonAffectes
    : [];
  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  for (const t of parsed.tournees) {
    if (!t || !Array.isArray(t.arrets)) continue;
    const camion = capByCamion[String(t.camionId)];
    const camionNom = (camion && camion.nom) || t.camionNom || `camion ${t.camionId}`;
    const camionCap =
      camion && camion.type !== "retrait" ? Number(camion.capaciteVelos) || 0 : Infinity;
    const kept: Arret[] = [];
    let sum = 0;

    for (const a of t.arrets) {
      const propose = Number(a.nbVelos) || 0;
      if (propose <= 0) {
        parsed.warnings.push(
          `Arrêt fantôme ignoré dans ${camionNom} : ${a.entreprise || a.clientId} (nbVelos=${propose}).`,
        );
        continue;
      }
      const ref = byId[String(a.clientId)];
      if (ref) {
        const demande = Number(ref.nbVelosRestants) || 0;
        if (propose !== demande) {
          if (demande > capaMax && !aRetrait) {
            clientsTropGros.push({
              clientId: ref.id,
              entreprise: ref.entreprise,
              ville: ref.ville,
              nbVelosRestants: demande,
              raison: `Commande de ${demande}v > capacité max camion dispo (${capaMax}v) et pas de retrait client. Gemini avait splitté en ${propose}v — corrigé.`,
            });
          } else {
            parsed.clientsNonAffectes.push({
              clientId: ref.id,
              entreprise: ref.entreprise,
              nbVelos: demande,
              raison: `Split refusé (Gemini proposait ${propose}v / ${demande}v dans ${camionNom}). Un client = une livraison intégrale.`,
            });
          }
          continue;
        }
      }
      if (sum + propose > camionCap) {
        parsed.clientsNonAffectes.push({
          clientId: a.clientId || "",
          entreprise: ref ? ref.entreprise : a.entreprise || a.clientId || "",
          nbVelos: propose,
          raison: `Capacité dépassée — ${camionNom} (${camionCap}v) saturé après ${sum}v déjà chargés.`,
        });
        continue;
      }
      kept.push(a);
      sum += propose;
    }
    t.arrets = kept;
    t.totalVelos = sum;
  }

  // Règle 3 : warning sur camions activés sans tournée.
  const camionsAvecTournee: Record<string, boolean> = {};
  for (const t of parsed.tournees) {
    if (t.arrets && t.arrets.length > 0) camionsAvecTournee[String(t.camionId)] = true;
  }
  for (const c of camions) {
    if (!camionsAvecTournee[String(c.id)]) {
      parsed.warnings.push(
        `Camion ${c.nom} activé mais sans tournée dans la proposition (Gemini ne l'a pas utilisé ou tous ses arrêts ont été refusés).`,
      );
    }
  }
  parsed.tournees = parsed.tournees.filter((t) => t.arrets && t.arrets.length > 0);

  // Plafond cumulé par camion sur la journée (8h).
  const byCamion: Record<string, Tournee[]> = {};
  for (const t of parsed.tournees) {
    const cid = String(t.camionId || "");
    if (!byCamion[cid]) byCamion[cid] = [];
    byCamion[cid].push(t);
  }
  for (const cid of Object.keys(byCamion)) {
    const ts = byCamion[cid];
    ts.sort((a, b) => (Number(a.ordreCamion) || 0) - (Number(b.ordreCamion) || 0));
    const cumul = (): number => {
      if (ts.length === 0) return 0;
      const sum = ts.reduce((s, t) => s + (Number(t.dureeMinutesEstimee) || 0), 0);
      return sum + RECHARGE_MIN * (ts.length - 1);
    };
    while (ts.length > 0 && cumul() > PLAFOND_JOUR) {
      const dropped = ts.pop()!;
      const camionNom = dropped.camionNom || `camion ${cid}`;
      const totalCumul =
        cumul() +
        (Number(dropped.dureeMinutesEstimee) || 0) +
        (ts.length > 0 ? RECHARGE_MIN : 0);
      const raison = `journée trop courte (${Math.round((totalCumul / 60) * 10) / 10}h cumulées sur ${camionNom} vs 8h max)`;
      for (const a of dropped.arrets || []) {
        parsed.clientsNonAffectes.push({
          clientId: a.clientId || "",
          entreprise: a.entreprise || "",
          nbVelos: Number(a.nbVelos) || 0,
          raison,
        });
      }
      parsed.warnings.push(
        `Tournée ${camionNom} T${dropped.ordreCamion || "?"} retirée par le post-processing : ${raison}. ${
          (dropped.arrets || []).length
        } arrêt(s) déplacé(s) en clientsNonAffectes.`,
      );
      const idx = parsed.tournees.indexOf(dropped);
      if (idx >= 0) parsed.tournees.splice(idx, 1);
    }
  }
}

function parseAndSanitize(rawText: string, ctx: ProposeContext): Record<string, unknown> {
  const cleaned = String(rawText || "")
    .replace(/^﻿/, "")
    .replace(/^\s*```(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/i, "")
    .trim();
  if (!cleaned) return { error: "Réponse Gemini vide", finishReason: ctx.finishReason || null };

  let parsed: Proposition;
  try {
    try {
      parsed = JSON.parse(cleaned);
    } catch (firstErr) {
      const msg = String(firstErr instanceof Error ? firstErr.message : firstErr);
      if (/non-whitespace character after JSON/i.test(msg)) {
        const firstObj = extractFirstJsonObject(cleaned);
        if (firstObj) parsed = JSON.parse(firstObj);
        else throw firstErr;
      } else {
        throw firstErr;
      }
    }
  } catch (parseErr) {
    const parseMsg = String(parseErr instanceof Error ? parseErr.message : parseErr);
    const posMatch = parseMsg.match(/position\s+(\d+)/);
    const errPos = posMatch ? parseInt(posMatch[1], 10) : -1;
    let errContext = null;
    if (errPos >= 0) {
      const ctxStart = Math.max(0, errPos - 200);
      const ctxEnd = Math.min(cleaned.length, errPos + 200);
      errContext = {
        position: errPos,
        before: cleaned.slice(ctxStart, errPos),
        at: cleaned.slice(errPos, errPos + 1),
        after: cleaned.slice(errPos + 1, ctxEnd),
      };
    }
    return {
      error: "Réponse Gemini non-JSON",
      parseError: parseMsg,
      finishReason: ctx.finishReason || null,
      rawLength: rawText.length,
      rawHead: cleaned.slice(0, 400),
      rawTail: cleaned.slice(-400),
      errContext,
    };
  }

  sanitizeProposeSplit(parsed, ctx.clientsEnrichis, ctx.camionsAvecRestant, ctx.clientsTropGros);
  return {
    ok: true,
    date: ctx.date,
    mode: ctx.mode,
    capacite: {
      camions: ctx.camionsAvecRestant,
      chauffeurs: ctx.capa.chauffeurs.length,
      chefs: ctx.capa.chefs.length,
      monteurs: ctx.capa.monteurs.length,
      capaciteTotaleVelos: ctx.capa.capaciteTotaleVelos,
      dejaAffecte: ctx.totalAffecte,
    },
    clientsCandidats: ctx.clientsEnrichis.length,
    clientsTropGros: ctx.clientsTropGros,
    proposition: parsed,
  };
}

// ----------------------- Appel Gemini -----------------------

const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
// Retry agressif court : on essaie 2x avec backoff léger puis on bascule sur
// flash-lite. Anciennement 5 retries × ~56s/modèle = 2 min/modèle = 4 min
// total → dépasse le timeout client SDK (300s) sur les pics de charge Gemini.
const RETRY_DELAYS_MS = [0, 4000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(
  apiKey: string,
  prompt: string,
  models?: string[],
): Promise<{ ok: true; text: string; finishReason: string | null } | { ok: false; error: string }> {
  const requestPayload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
      // thinkingBudget=0 libère 4k tokens pour la réponse. Bug observé
      // 2026-04-28 : flash-lite + thinking 4096 + 70 clients = MAX_TOKENS
      // atteint avec Gemini qui hallucine "Tournée 183" en boucle. Sans
      // thinking, le modèle suit le format direct et tient dans le budget.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  let lastCode: number | null = null;
  let lastBody = "";
  let lastModel: string | null = null;
  const modelList = models && models.length > 0 ? models : FALLBACK_MODELS;
  for (const model of modelList) {
    lastModel = model;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    let modelBlocked = false;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        });
        lastCode = res.status;
        if (res.status === 200) {
          const data = await res.json();
          const cand = (data?.candidates || [])[0] || {};
          const parts = cand.content?.parts;
          const finishReason = cand.finishReason || null;
          const text = parts?.[0]?.text || "";
          return { ok: true, text, finishReason };
        }
        lastBody = await res.text();
        if (res.status !== 503 && res.status !== 429 && res.status !== 500) {
          modelBlocked = true;
          break;
        }
      } catch (err) {
        lastBody = err instanceof Error ? err.message : String(err);
      }
    }
    if (modelBlocked) continue;
  }
  return {
    ok: false,
    error: `Gemini HTTP ${lastCode ?? "??"} (model ${lastModel}) ${lastBody.slice(0, 200)}`,
  };
}

// ----------------------- Cloud Function -----------------------

type ProposePayload = {
  date?: string;
  mode?: string;
  // ["gemini-2.5-flash-lite"] = mode rapide forcé sur le petit modèle.
  // undefined ou ["gemini-2.5-flash", "gemini-2.5-flash-lite"] = cascade
  // standard (flash robuste d'abord, fallback flash-lite si saturé).
  models?: string[];
};

export const proposeTournee = onCall<ProposePayload>(
  {
    secrets: [GEMINI_API_KEY],
    // Sur gros volumes (300+ clients candidats) Gemini 2.5-flash peut
    // réfléchir 60-90s, et avec retry+fallback flash-lite on peut grimper
    // à 3-4 min. 540s = max gen2 sans config VPC, on prend la marge.
    timeoutSeconds: 540,
    memory: "2GiB",
    region: "europe-west1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentification requise");
    }
    const date = String(request.data?.date || "").slice(0, 10);
    const mode = String(request.data?.mode || "fillGaps");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpsError("invalid-argument", "date YYYY-MM-DD requise");
    }
    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "GEMINI_API_KEY non configurée");
    }

    // 1) Capacité du jour
    const capa = await loadCapaciteDuJour(date);
    if (capa.camions.length === 0) {
      return {
        error: `Aucun camion déclaré disponible pour le ${date}. Renseigne les dispos du jour.`,
      };
    }

    // 2) Clients livrables + affectations existantes
    const ctx = await loadClientsLivrablesPourDate(date);

    // 3) Capacité restante par camion (= capacité totale, on ne soustrait pas
    // les vélos déjà affectés à des tournées existantes : Gemini reçoit le
    // bloc "Tournées déjà partiellement remplies" pour qu'il complète sans
    // dépasser. Cohérent avec gas/Code.js:5419-5428).
    const camionsAvecRestant: CamionAvecRestant[] = capa.camions.map((c) => ({
      ...c,
      restant: c.capaciteVelos,
    }));

    // 4) Total affecté (info pour le résumé final)
    let totalAffecte = 0;
    for (const tid of Object.keys(ctx.affectes)) {
      for (const a of ctx.affectes[tid]) totalAffecte += a.nbVelos;
    }

    // 5) Enrichit clients dispo (vélos restants > 0, distance dépôt, paris)
    const enrichisRaw: ClientEnrichi[] = ctx.dispo.map((c) => {
      const restant = Math.max(
        0,
        Number(c.nbVelosCommandes || 0) - Number(c.nbVelosLivres || 0),
      );
      return {
        id: c.id,
        entreprise: c.entreprise,
        ville: c.ville,
        codePostal: c.codePostal,
        nbVelosRestants: restant,
        estParis: estParis(c),
        distanceKmDepot:
          Math.round(distanceKm(DEPOT_LAT, DEPOT_LNG, c.latitude, c.longitude) * 10) / 10,
        apporteur: c.apporteur || null,
      };
    });
    let clientsEnrichis = enrichisRaw.filter((c) => c.nbVelosRestants > 0);

    if (clientsEnrichis.length === 0) {
      return {
        ok: true,
        date,
        message: "Aucun client à livrer pour ce jour (déjà tout affecté ou rien à faire).",
        proposition: { tournees: [] },
      };
    }

    // 6) Surface clients trop gros pour la flotte (sans retrait dispo).
    const camionsMotorises = camionsAvecRestant.filter((c) => c.type !== "retrait");
    const capaMaxMotorisee = camionsMotorises.reduce(
      (m, c) => Math.max(m, c.capaciteVelos || 0),
      0,
    );
    const aRetrait = camionsAvecRestant.some((c) => c.type === "retrait");
    const clientsTropGros: ClientTropGros[] = [];
    if (!aRetrait) {
      clientsEnrichis = clientsEnrichis.filter((c) => {
        if (c.nbVelosRestants > capaMaxMotorisee) {
          clientsTropGros.push({
            clientId: c.id,
            entreprise: c.entreprise,
            ville: c.ville,
            nbVelosRestants: c.nbVelosRestants,
            raison: `Commande de ${c.nbVelosRestants}v > capacité max camion dispo (${capaMaxMotorisee}v) et pas de retrait client. Active un plus gros camion ou le retrait.`,
          });
          return false;
        }
        return true;
      });
    }

    // 7) Tri par distance dépôt croissante
    clientsEnrichis.sort((a, b) => a.distanceKmDepot - b.distanceKmDepot);

    // 8) Build prompt + appel Gemini
    const prompt = buildProposeTourneePrompt(
      date,
      camionsAvecRestant,
      clientsEnrichis,
      ctx.affectes,
      mode,
      capa,
    );

    const callRes = await callGemini(apiKey, prompt, request.data?.models);
    if (!callRes.ok) {
      logger.warn("proposeTournee Gemini KO", { error: callRes.error });
      return { error: callRes.error };
    }
    if (!callRes.text) {
      return { error: "Réponse Gemini vide", finishReason: callRes.finishReason };
    }

    return parseAndSanitize(callRes.text, {
      date,
      mode,
      camionsAvecRestant,
      clientsEnrichis,
      clientsTropGros,
      capa,
      totalAffecte,
      finishReason: callRes.finishReason,
    });
  },
);
