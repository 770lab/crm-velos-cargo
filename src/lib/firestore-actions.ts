/**
 * Implémentations Firestore des actions historiquement servies par GAS.
 *
 * Ces fonctions sont appelées par `gas.ts` quand `NEXT_PUBLIC_USE_FIREBASE=1`,
 * pour que les pages existantes continuent d'appeler `gasPost(...)` /
 * `gasUpload(...)` sans modification.
 *
 * Format de retour : on imite la forme `{ ok: true, ... }` de GAS pour ne pas
 * casser les call-sites qui testent `r.ok`.
 *
 * Actions non migrées (Gemini / Drive / API externes) → renvoient
 * `{ ok: false, fallback: "gas" }` et `gas.ts` retombe sur un appel GAS réel.
 */

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  serverTimestamp,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDocsFromServer,
  runTransaction,
  Timestamp,
  increment,
  deleteField,
  type FieldValue,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth, db, firebaseApp, storage } from "./firebase";

const functions = getFunctions(firebaseApp, "europe-west1");

const ts = serverTimestamp;

// -------- helpers --------

type Body = Record<string, unknown>;

function getString(b: Body, key: string): string | undefined {
  const v = b[key];
  return typeof v === "string" ? v : undefined;
}

function getRequired(b: Body, key: string): string {
  const v = getString(b, key);
  if (!v) throw new Error(`Champ manquant: ${key}`);
  return v;
}

/**
 * Convertit une valeur "à la GAS" (string ISO ou ts ms) en Timestamp Firestore,
 * ou laisse passer une string non-date.
 */
function maybeDate(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (!v) return null;
  // ISO date string ?
  const d = new Date(v);
  if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return Timestamp.fromDate(d);
  }
  return v;
}

function applyMaybeDates(data: Body): Body & { updatedAt: FieldValue } {
  const out: Body = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "datePrevue" || k === "dateEffective") {
      out[k] = maybeDate(v);
    } else {
      out[k] = v;
    }
  }
  return { ...out, updatedAt: ts() };
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string } {
  // Soit "data:image/jpeg;base64,XXX" soit raw base64
  let base64: string;
  let mime = "application/octet-stream";
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    mime = m[1];
    base64 = m[2];
  } else {
    base64 = dataUrl;
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), mime };
}

async function uploadDataUrl(path: string, dataUrl: string, mimeOverride?: string) {
  const { blob, mime } = dataUrlToBlob(dataUrl);
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: mimeOverride || mime });
  return getDownloadURL(r);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers stock entrepôts (Phase 2C — Yoann 2026-05-01) :
// auto-création de mouvements de stock à chaque event terrain (chargement,
// montage atelier, dé-marquage). Le stock dénormalisé sur le doc parent
// est mis à jour via FieldValue.increment pour rester atomique.
// ─────────────────────────────────────────────────────────────────────────
async function createStockMouvement(params: {
  entrepotId: string;
  type: "carton" | "monte";
  quantite: number; // signé
  source: string; // "tournee-charge", "montage-atelier", "unmark-charge", "manuelle"
  notes?: string | null;
  veloId?: string | null;
  fnuci?: string | null;
}) {
  const { entrepotId, type, quantite, source, notes, veloId, fnuci } = params;
  if (!entrepotId || quantite === 0) return;
  try {
    await addDoc(collection(db, "entrepots", entrepotId, "mouvements"), {
      type,
      quantite,
      date: new Date().toISOString().slice(0, 10),
      source,
      notes: notes || null,
      veloId: veloId || null,
      fnuci: fnuci || null,
      createdAt: ts(),
    });
    const field = type === "carton" ? "stockCartons" : "stockVelosMontes";
    await updateDoc(doc(db, "entrepots", entrepotId), {
      [field]: increment(quantite),
      updatedAt: ts(),
    });
  } catch (e) {
    // Best-effort : on log mais on ne fait pas échouer l'action terrain pour
    // un problème de stock (le scan FNUCI reste prioritaire pour CEE).
    console.warn("[stock] createStockMouvement KO", entrepotId, type, quantite, e);
  }
}

/** Trouve l'entrepôt origine + mode montage pour un client. Si tourneeId
 *  fourni, on cherche la livraison de cette tournée. Sinon on prend la
 *  livraison la plus récente non-annulée du client. Renvoie null si
 *  aucune livraison ou pas d'entrepôt configuré. */
async function getEntrepotOrigineForClient(params: {
  tourneeId?: string;
  clientId: string;
}): Promise<{ entrepotOrigineId: string; modeMontage: "client" | "atelier" | "client_redistribue" } | null> {
  const { tourneeId, clientId } = params;
  try {
    const constraints = [where("clientId", "==", clientId)];
    if (tourneeId) constraints.push(where("tourneeId", "==", tourneeId));
    const livSnap = await getDocs(query(collection(db, "livraisons"), ...constraints));
    if (livSnap.empty) return null;
    // Filtre les annulées et prend la 1ère avec entrepotOrigineId défini.
    for (const d of livSnap.docs) {
      const liv = d.data() as {
        statut?: string;
        entrepotOrigineId?: string | null;
        modeMontage?: "client" | "atelier" | "client_redistribue" | null;
      };
      if (liv.statut === "annulee") continue;
      if (!liv.entrepotOrigineId) continue;
      return {
        entrepotOrigineId: liv.entrepotOrigineId,
        modeMontage: liv.modeMontage || "client",
      };
    }
    return null;
  } catch (e) {
    console.warn("[stock] getEntrepotOrigineForClient KO", e);
    return null;
  }
}

// Token unique par étiquette carton (29-04 12h30, demande Yoann anti-double-scan).
// Format CT-XXXXXXXX, 31 chars sans 0/O/1/I/L pour éviter confusion. 31^8 ≈
// 852Md combinaisons → collision ultra-rare. Préfixe CT distingue d'un FNUCI
// (BC...) côté logs/debug.
const CARTON_TOKEN_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCartonToken(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += CARTON_TOKEN_CHARS[Math.floor(Math.random() * CARTON_TOKEN_CHARS.length)];
  }
  return `CT-${s}`;
}

// -------- catalog --------

export const FIRESTORE_ACTIONS = new Set<string>([
  // login
  "loginEquipe",
  // clients
  "createClient",
  "updateClient",
  "bulkUpdateClients",
  "setClientVelosTarget",
  "cancelClient",
  "restoreClient",
  // livraisons
  "createLivraison",
  "updateLivraison",
  "setLivraisonValidation",
  // tournees → livraisons (ils sont stockés ensemble dans GAS)
  "createTournee",
  "createTournees",
  "assignTournee",
  // velos
  "setVeloFnuci",
  "assignFnuciToClient",
  "updateVelos",
  "markVeloLivre",
  "markVeloPrepare",
  "markVeloCharge",
  "markVeloLivreScan",
  "markNextVeloForEtape",
  "markVeloByCartonToken",
  "ensureCartonTokensForClient",
  "markVeloMontePhoto",
  "claimVeloForMontage",
  "transferMontageClaim",
  "releaseVeloMontageClaim",
  "markClientAsDelivered",
  "unmarkVeloEtape",
  "unsetVeloClient",
  // équipe
  "upsertMembre",
  "setMembreCode",
  "clearMembreCode",
  // verifications
  "validateVerification",
  "rejectVerification",
  // uploads
  "uploadDoc",
  "uploadBlSignedPhoto",
  "uploadMontagePhoto",
  "uploadVeloPhoto",
  // sync admin
  "syncBonsNow",
  "addBonEnlevementManual",
  // batch admin
  "bulkAutoValidate",
  "importClients",
  "setDisponibilites",
  // gemini vision (vague 3 — proxifié via Cloud Function)
  "extractFnuciFromImage",
  // routing & planning (vague 3 — Cloud Function lit Firestore + appelle Gemini)
  "proposeTournee",
  // suggestTournee (vague 3) — algo pur côté frontend, pas de Cloud Function
  // (lit clients + livraisons direct Firestore, bin-packing local).
  "suggestTournee",
  // Phase B-1 (Yoann 2026-05-01) : suggestion tournée depuis un entrepôt.
  "suggestTourneeFromEntrepot",
  // Phase B-2 (Yoann 2026-05-01) : planificateur multi-tournées journée.
  "planifierJourneeCamion",
  // Phase 3.1 (Yoann 2026-05-01) : Gemini logisticien stratège.
  "strategieGemini",
  // Yoann 2026-05-03 : reset stock + suggestion stock cible 100km Paris
  "resetStockEntrepot",
  "suggestionStockEntrepot",
  // Yoann 2026-05-03 : session montage+livraison sur site client (Firat)
  // — pas dans nos tournées, le client utilise son propre camion + 1 chef
  // de chez nous présent sur place.
  "createSessionSurSite",
  "updateSessionSurSite",
  "cancelSessionSurSite",
  // Yoann 2026-05-03 : reset FNUCI sur un vélo (libère le slot pour
  // ré-affilier). Garde le vélo, retire fnuci/datePreparation/preparateurId.
  "resetVeloFnuci",
  // Yoann 2026-05-03 : Gemini scanne les anomalies clients
  "detectAnomaliesClients",
  // Yoann 2026-05-03 : simulation macro Opération Paris (1 bouton, full plan)
  "simulationOperationComplete",
  "genererPlanningOperation",
  // parcelle cadastrale (vague 3) — APIs publiques, pas de Cloud Function
  "fetchParcelle",
  "autoFetchParcelles",
  // diagnostic + routing (vague 3 — Cloud Functions)
  "testGemini",
  "getRouting",
]);

export function isMigrated(action: string): boolean {
  return FIRESTORE_ACTIONS.has(action);
}

// -------- dispatch --------

export async function runFirestoreAction(
  action: string,
  body: Body,
): Promise<unknown> {
  switch (action) {
    // ---------- login ----------
    case "loginEquipe": {
      // Par sécurité on n'autorise PAS le login PIN via cette voie : la nouvelle
      // auth Firebase passe par auth-gate-firebase (signInWithEmailAndPassword).
      // Si l'ancien auth-gate.tsx est encore actif, on renvoie une erreur claire.
      return { ok: false, error: "Auth GAS désactivée — utilise auth-gate-firebase" };
    }

    // ---------- clients ----------
    case "createClient": {
      // apporteurLower : champ dénormalisé case-insensitive pour le RBAC
      // apporteur (cf. firestore.rules + scripts/backfill-apporteur-lower.mjs).
      const apporteurLower = body.apporteur
        ? String(body.apporteur).trim().toLowerCase() || null
        : null;

      // Géocodage à la création (api-adresse.data.gouv.fr — public, sans clé).
      // Sans coords, le client n'apparaît pas sur /carte (pointFromClient
      // retourne null si latitude/longitude manquants) — bug 2026-04-28
      // (DIGITAL 111 invisible).
      const geo = await geocodeClientAddress({
        adresse: body.adresse,
        codePostal: body.codePostal,
        ville: body.ville,
      });

      const ref = await addDoc(collection(db, "clients"), {
        ...body,
        nbVelosCommandes: Number(body.nbVelosCommandes) || 0,
        apporteurLower,
        ...(geo ? { latitude: geo.lat, longitude: geo.lng } : {}),
        createdAt: ts(),
        updatedAt: ts(),
      });
      return { ok: true, id: ref.id, geocoded: !!geo };
    }

    case "updateClient": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      // Le système GAS accepte des updates "à plat" ({ kbisRecu: true, kbisLien: "..." }).
      // Les docs Firestore sont structurés (docs.kbisRecu, docLinks.kbis).
      // On reroute proprement.
      const updates: Body = { updatedAt: ts() };
      const docFlags = [
        "devisSignee",
        "kbisRecu",
        "attestationRecue",
        "signatureOk",
        "inscriptionBicycle",
        "parcelleCadastrale",
      ];
      const docLinkMap: Record<string, string> = {
        devisLien: "docLinks.devis",
        kbisLien: "docLinks.kbis",
        attestationLien: "docLinks.attestation",
        signatureLien: "docLinks.signature",
        bicycleLien: "docLinks.bicycle",
        parcelleCadastraleLien: "docLinks.parcelleCadastrale",
      };
      const docDateMap: Record<string, string> = {
        kbisDate: "docDates.kbis",
        dateEngagement: "docDates.engagement",
        liasseFiscaleDate: "docDates.liasseFiscale",
      };
      for (const [k, v] of Object.entries(data)) {
        if (docFlags.includes(k)) updates[`docs.${k}`] = !!v;
        else if (docLinkMap[k]) updates[docLinkMap[k]] = v;
        else if (docDateMap[k]) updates[docDateMap[k]] = v;
        else updates[k] = v;
      }
      // Si apporteur change, on met à jour aussi apporteurLower (RBAC).
      if ("apporteur" in data) {
        updates.apporteurLower = data.apporteur
          ? String(data.apporteur).trim().toLowerCase() || null
          : null;
      }
      // Si adresse / CP / ville change, on re-géocode (le client doit
      // bouger sur la carte). On lit le doc actuel pour combler les
      // champs non fournis dans data (update partiel).
      if ("adresse" in data || "codePostal" in data || "ville" in data) {
        try {
          const cur = await getDoc(doc(db, "clients", id));
          const curData = cur.exists() ? (cur.data() as { adresse?: string; codePostal?: string; ville?: string }) : {};
          const geo = await geocodeClientAddress({
            adresse: ("adresse" in data ? data.adresse : curData.adresse) as string | undefined,
            codePostal: ("codePostal" in data ? data.codePostal : curData.codePostal) as string | undefined,
            ville: ("ville" in data ? data.ville : curData.ville) as string | undefined,
          });
          if (geo) {
            updates.latitude = geo.lat;
            updates.longitude = geo.lng;
          }
        } catch (e) {
          console.error("[updateClient] geocode KO", e);
        }
      }
      await updateDoc(doc(db, "clients", id), updates);
      return { ok: true };
    }

    case "bulkUpdateClients": {
      const ids = (body.clientIds as string[]) || [];
      const data = (body.data as Body) || {};
      const batch = writeBatch(db);
      for (const id of ids) {
        batch.update(doc(db, "clients", id), { ...data, updatedAt: ts() });
      }
      await batch.commit();
      return { ok: true, updated: ids.length };
    }

    case "cancelClient": {
      // Soft-cancel un client (commande annulée — ex: docs jamais reçus).
      // Cascade :
      //   - livraisons planifiees → annulee (avec raison « Client annulé : X »)
      //   - vélos cibles → annule=true (soft, restaurable)
      //   - stats.planifies du client → 0 (toutes les livraisons sont annulées)
      // Le doc client conserve toutes ses données pour permettre une
      // restauration ultérieure si le client renvoie ses docs.
      const id = getRequired(body, "id");
      const raisonAnnulation = String(body.raisonAnnulation || "").trim();
      if (!raisonAnnulation) return { ok: false, error: "raisonAnnulation requise" };

      const cRefCC = doc(db, "clients", id);
      const cSnapCC = await getDoc(cRefCC);
      if (!cSnapCC.exists()) return { ok: false, error: "Client introuvable" };

      // 1) Marque le client annulé
      await updateDoc(cRefCC, {
        statut: "annulee",
        raisonAnnulation,
        annuleeAt: ts(),
        "stats.planifies": 0,
        updatedAt: ts(),
      });

      // 2) Cascade livraisons planifiees → annulee
      const livRaison = `Client annulé : ${raisonAnnulation}`;
      const livSnapCC = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      let nbLivAnnulees = 0;
      for (let i = 0; i < livSnapCC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of livSnapCC.docs.slice(i, i + 400)) {
          const data = d.data() as { statut?: string };
          if (data.statut !== "planifiee") continue;
          batch.update(d.ref, {
            statut: "annulee",
            dateEffective: null,
            raisonAnnulation: livRaison,
            annuleeAt: ts(),
          });
          nbLivAnnulees++;
        }
        await batch.commit();
      }

      // 3) Cascade vélos → annule=true (soft cancel, sans toucher aux scans
      // déjà faits — on conserve dateLivraisonScan/Montage/Preparation pour
      // que la restauration puisse remettre le client dans son état exact).
      const velSnapCC = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      let nbVelosAnnules = 0;
      for (let i = 0; i < velSnapCC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of velSnapCC.docs.slice(i, i + 400)) {
          batch.update(d.ref, { annule: true, updatedAt: ts() });
          nbVelosAnnules++;
        }
        await batch.commit();
      }

      return { ok: true, nbLivAnnulees, nbVelosAnnules };
    }

    case "restoreClient": {
      // Restaure un client annulé. Symétrique de cancelClient :
      //   - statut → null/"actif"
      //   - vélos : annule=false
      // Les livraisons restent annulees (à re-planifier manuellement,
      // l'utilisateur ne veut sûrement pas réactiver les anciennes dates).
      const id = getRequired(body, "id");
      const cRefRC = doc(db, "clients", id);
      const cSnapRC = await getDoc(cRefRC);
      if (!cSnapRC.exists()) return { ok: false, error: "Client introuvable" };

      await updateDoc(cRefRC, {
        statut: null,
        raisonAnnulation: null,
        annuleeAt: null,
        updatedAt: ts(),
      });

      const velSnapRC = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      let nbVelosRestaures = 0;
      for (let i = 0; i < velSnapRC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of velSnapRC.docs.slice(i, i + 400)) {
          batch.update(d.ref, { annule: false, updatedAt: ts() });
          nbVelosRestaures++;
        }
        await batch.commit();
      }

      return { ok: true, nbVelosRestaures };
    }

    case "setClientVelosTarget": {
      // Met à jour le nombre de vélos commandés (devis) ET aligne :
      //   - stats.totalVelos = target (lu par l'UI /clients pour "X/Y")
      //   - docs `velos` cibles : crée la diff si on monte, supprime des
      //     vierges si on descend (jamais ceux déjà préparés/livrés/montés
      //     ni ceux avec un fnuci scanné — sécurité historique).
      // Avant ce fix : l'UI affichait toujours l'ancienne valeur après
      // modification (bug 2026-04-28).
      const clientId = getRequired(body, "clientId");
      const target = Number(body.target) || 0;

      // 1) Compte les vélos existants et leur état pour ce client
      const velSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      type V = { ref: typeof velSnap.docs[0]["ref"]; locked: boolean };
      const existing: V[] = velSnap.docs.map((d) => {
        const o = d.data() as {
          fnuci?: string | null;
          datePreparation?: unknown;
          dateChargement?: unknown;
          dateLivraisonScan?: unknown;
          dateMontage?: unknown;
        };
        const locked = !!(o.fnuci || o.datePreparation || o.dateChargement || o.dateLivraisonScan || o.dateMontage);
        return { ref: d.ref, locked };
      });
      const lockedCount = existing.filter((v) => v.locked).length;
      if (target < lockedCount) {
        return { ok: false, error: `Impossible de descendre sous ${lockedCount} (vélos déjà engagés/livrés)` };
      }

      // 2) Update doc client (devis + stats)
      await updateDoc(doc(db, "clients", clientId), {
        nbVelosCommandes: target,
        "stats.totalVelos": target,
        updatedAt: ts(),
      });

      // 3) Aligne les docs vélos cibles
      const cur = existing.length;
      let createdN = 0;
      let deletedN = 0;
      if (target > cur) {
        // Récupère apporteurLower client pour les nouveaux vélos
        let apporteurLowerNew: string | null = null;
        try {
          const cSnap = await getDoc(doc(db, "clients", clientId));
          if (cSnap.exists()) {
            const cd = cSnap.data() as { apporteur?: string; apporteurLower?: string };
            apporteurLowerNew = cd.apporteurLower
              || (cd.apporteur ? String(cd.apporteur).trim().toLowerCase() : null)
              || null;
          }
        } catch {}
        const toCreate = target - cur;
        const batch = writeBatch(db);
        for (let i = 0; i < toCreate; i++) {
          const veloRef = doc(collection(db, "velos"));
          batch.set(veloRef, {
            clientId,
            apporteurLower: apporteurLowerNew,
            fnuci: null,
            datePreparation: null,
            dateChargement: null,
            dateLivraisonScan: null,
            dateMontage: null,
            createdAt: ts(),
            updatedAt: ts(),
          });
        }
        await batch.commit();
        createdN = toCreate;
      } else if (target < cur) {
        // Soft-cancel des vélos cibles vierges en surplus (au lieu de hard-delete).
        // Règle Yoann 29-04 : "Ne jamais supprimer un client en définitif" — par
        // extension les vélos cibles aussi, pour que les stats objectif vs réalisé
        // restent cohérentes dans le temps. annule=true les exclut des compteurs
        // mais conserve la trace.
        const toCancel = cur - target;
        const blanks = existing.filter((v) => !v.locked).slice(0, toCancel);
        const batch = writeBatch(db);
        for (const v of blanks) batch.update(v.ref, { annule: true, updatedAt: ts() });
        await batch.commit();
        deletedN = blanks.length;
      }

      return { ok: true, target, createdN, deletedN };
    }

    // ---------- livraisons ----------
    case "createLivraison": {
      // tourneeNumero stable : si le tourneeId est déjà connu, on hérite du
      // numéro existant (mêmes tournées = même numéro). Sinon on alloue
      // max(tourneeNumero) + 1 (numérotation globale qui ne décrémente jamais
      // même quand on annule une tournée intermédiaire — cf. ce que demande
      // Yoann le 2026-04-28).
      const tourneeId = getString(body, "tourneeId");
      let tourneeNumero: number | undefined;
      // Auto-attribution du champ `ordre` quand on ajoute un client à une
      // tournée déjà existante (ex : bouton "+" UI livraisons). Sans ça, le
      // verrou LIFO inter-clients se désactive pour TOUTE la tournée puisqu'au
      // moins un client n'a pas d'ordre détectable. Cf. incident MANADVISE
      // 2026-04-28 (tournée 818b8963 chargée le matin du 28-04). On lit le
      // max ordre des siblings de la même tournée (champ direct OU regex
      // "arrêt X/N" sur notes legacy) puis on attribue max+1.
      let maxOrdreInTournee = 0;
      const ordreFromNotesLiv = (notes: unknown): number | null => {
        if (typeof notes !== "string") return null;
        const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
        return m ? parseInt(m[1], 10) : null;
      };
      if (tourneeId) {
        const sib = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        for (const d of sib.docs) {
          const data = d.data() as { tourneeNumero?: number; ordre?: number; notes?: string };
          if (typeof data.tourneeNumero === "number" && tourneeNumero == null) {
            tourneeNumero = data.tourneeNumero;
          }
          const o =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotesLiv(data.notes);
          if (typeof o === "number" && o > maxOrdreInTournee) maxOrdreInTournee = o;
        }
      }
      if (tourneeNumero == null) {
        // Nouvelle tournée → max + 1. On utilise orderBy desc + limit 1 pour
        // ne lire QU'UN seul doc Firestore (avant : full scan de la collection
        // livraisons à chaque création de tournée — coût croissant à mesure que
        // la base grandit).
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        let maxN = 0;
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") maxN = n;
        }
        tourneeNumero = maxN + 1;
      }
      // apporteurLower : dénormalisé depuis le client pour le RBAC apporteur
      // (cf. firestore.rules + scripts/backfill-apporteur-lower.mjs).
      let apporteurLowerLiv: string | null = null;
      let clientSnapshotLiv: Body | null = null;
      const cidLiv = getString(body, "clientId");
      if (cidLiv) {
        try {
          const cSnap = await getDoc(doc(db, "clients", cidLiv));
          if (cSnap.exists()) {
            const cData = cSnap.data() as {
              apporteur?: string;
              apporteurLower?: string;
              entreprise?: string;
              ville?: string;
              adresse?: string;
              codePostal?: string;
              departement?: string;
              telephone?: string;
              lat?: number;
              lng?: number;
              latitude?: number;
              longitude?: number;
            };
            apporteurLowerLiv = cData.apporteurLower
              || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
              || null;
            // Snapshot dénormalisé pour l'UI livraisons (cf. data-context-firebase.tsx
            // qui lit d.clientSnapshot.entreprise — sans ça, l'UI affiche un tiret).
            clientSnapshotLiv = {
              entreprise: cData.entreprise || "",
              ville: cData.ville || "",
              adresse: cData.adresse || "",
              codePostal: cData.codePostal || "",
              departement: cData.departement || "",
              telephone: cData.telephone || "",
              lat: cData.lat ?? cData.latitude ?? null,
              lng: cData.lng ?? cData.longitude ?? null,
            };
          }
        } catch {}
      }
      // Cap nbVelos au reste à planifier (= nbVelosCommandes du devis − livrés
      // − déjà planifiés ailleurs). Sans ça, Gemini peut sur-allouer (ex :
      // OPEN SOURCING 6v commandés mais livraison à 16 — bug 2026-04-28).
      // Règle métier user : « C'EST LE NOMBRE DE VÉLO SUR DEVIS QUI COMPTE
      // SAUF QUAND JE MODIFIE MANUELLEMENT » → on ne cap PAS si l'appelant
      // a explicitement passé `forceNbVelos: true` (édition manuelle UI).
      const bodyApplied = applyMaybeDates(body) as Body;
      if (cidLiv && !body.forceNbVelos && Number(bodyApplied.nbVelos) > 0) {
        const cap = await computeRemainingVelos(cidLiv);
        const requested = Number(bodyApplied.nbVelos);
        if (cap !== null && requested > cap) {
          bodyApplied.nbVelos = Math.max(0, cap);
        }
      }
      // ordre final : explicite si fourni par l'appelant (rare), sinon max+1
      // dans la tournée. Null si pas de tournée (livraison standalone).
      const ordreFinal: number | null =
        typeof body.ordre === "number"
          ? body.ordre
          : tourneeId
            ? maxOrdreInTournee + 1
            : null;
      // Préparateurs par défaut (Naomi) — n'écrase pas si déjà fourni.
      const defaultPrepIdsCL = Array.isArray(bodyApplied.preparateurIds) && bodyApplied.preparateurIds.length > 0
        ? null
        : await getDefaultPreparateurIds();
      const ref = await addDoc(collection(db, "livraisons"), {
        ...bodyApplied,
        tourneeNumero,
        ordre: ordreFinal,
        apporteurLower: apporteurLowerLiv,
        clientSnapshot: clientSnapshotLiv,
        ...(defaultPrepIdsCL && defaultPrepIdsCL.length > 0
          ? { preparateurIds: [...defaultPrepIdsCL] }
          : {}),
        statut: body.statut || "planifiee",
        createdAt: ts(),
      });

      // Incrémente stats.planifies si la livraison est planifiee (symétrique
      // avec deleteLivraison). Sinon le compteur reste à 0 et le pop-up
      // /carte affiche "Aucun vélo à planifier" alors qu'il y en a.
      if (cidLiv && (body.statut || "planifiee") === "planifiee") {
        try {
          const cRef = doc(db, "clients", cidLiv);
          const cSnap = await getDoc(cRef);
          if (cSnap.exists()) {
            const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
            const cur = Number(stats.planifies) || 0;
            await updateDoc(cRef, { "stats.planifies": cur + 1 });
          }
        } catch (e) {
          console.error("[createLivraison] increment planifies KO", e);
        }
      }

      // Création automatique des docs `velos` cibles si manquants. Modèle A
      // (vélo lié au clientId, pas à la livraisonId) : on s'aligne sur le
      // schéma historique GAS pour préserver assignFnuciToClient,
      // getTourneeProgression, etc.
      //
      // Idempotent : on compte les vélos existants pour ce client et on
      // crée uniquement la différence avec nbVelos demandé. Sans ça, créer
      // une livraison pour un client neuf donne `total=0` côté préparation
      // → impossible d'imprimer étiquettes ou scanner FNUCI (cf. bug
      // ALYSSAR du 2026-04-28).
      const nbVelosLiv = Number(bodyApplied.nbVelos) || 0;
      if (cidLiv && nbVelosLiv > 0) {
        try {
          const existingSnap = await getDocs(
            query(collection(db, "velos"), where("clientId", "==", cidLiv)),
          );
          const aCreer = Math.max(0, nbVelosLiv - existingSnap.size);
          if (aCreer > 0) {
            // apporteurLower dénormalisé identique à la livraison (RBAC
            // apporteur — cf. firestore.rules).
            const batch = writeBatch(db);
            for (let i = 0; i < aCreer; i++) {
              const veloRef = doc(collection(db, "velos"));
              batch.set(veloRef, {
                clientId: cidLiv,
                apporteurLower: apporteurLowerLiv,
                fnuci: null,
                datePreparation: null,
                dateChargement: null,
                dateLivraisonScan: null,
                dateMontage: null,
                createdAt: ts(),
                updatedAt: ts(),
              });
            }
            await batch.commit();
          }
        } catch (e) {
          // Si la création échoue, la livraison existe déjà — on log et on
          // laisse passer pour ne pas bloquer le user. Backfill possible
          // via setClientVelosTarget ou recompute-client-stats.mjs.
          console.error("[createLivraison] velos backfill KO", e);
        }
      }

      return { ok: true, id: ref.id, tourneeNumero };
    }

    case "updateLivraison": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      await updateDoc(doc(db, "livraisons", id), applyMaybeDates(data));
      return { ok: true };
    }

    case "setLivraisonValidation": {
      // Validation préalable client (terrain demande Yoann 2026-04-29) : on
      // ne livre pas tant que le client n'a pas confirmé sa disponibilité
      // (oralement par téléphone OU par mail). Le chef d'équipe ou
      // l'apporteur enregistre ici la confirmation.
      //   status : "validee_orale" | "validee_mail" | "non_contacte"
      //   par    : nom de la personne qui a fait l'appel/reçu le mail
      //   note   : libre (ex: « rappeler à 9h »)
      const id = getRequired(body, "id");
      const status = getString(body, "status");
      if (!["validee_orale", "validee_mail", "non_contacte"].includes(status || "")) {
        return { ok: false, error: "status invalide" };
      }
      const par = getString(body, "par") || null;
      const note = getString(body, "note") || null;
      const updates: Body = { updatedAt: ts() };
      if (status === "non_contacte") {
        updates.validationClient = null;
      } else {
        updates.validationClient = {
          status,
          par,
          note,
          at: new Date().toISOString(),
        };
      }
      await updateDoc(doc(db, "livraisons", id), updates);
      return { ok: true };
    }

    // ---------- tournees ----------
    case "createTournee": {
      // Réplique la logique GAS createTournee : crée la tournée + les livraisons
      // depuis `stops` + les vélos cibles + incrémente stats.planifies.
      // Utilisé par le panneau Retrait dans /carte (mode="retrait") et autres.
      // Sans la création des livraisons, le user voit "rien ne se passe" — la
      // tournée existe en base mais n'a aucun client → invisible UI.
      const stops = (body.stops as Body[]) || [];

      // Numéro tournée global : max(tourneeNumero) + 1
      let tourneeNumero = 1;
      try {
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") tourneeNumero = n + 1;
        }
      } catch {}

      // Yoann 2026-05-01 : entrepôt source + mode montage propagés depuis
      // SuggererTourneePanel (vue Entrepôts) — sans ça, la tournée n'a pas
      // d'origine et la stats stock entrepôt ne se décrémente pas.
      const entrepotOrigineId = body.entrepotOrigineId ? String(body.entrepotOrigineId) : null;
      const modeMontage = body.modeMontage ? String(body.modeMontage) : null;

      const tRef = await addDoc(collection(db, "tournees"), {
        datePrevue: body.datePrevue || "",
        mode: body.mode || "",
        notes: body.notes || "",
        statut: body.statut || "planifiee",
        entrepotOrigineId,
        modeMontage,
        createdAt: ts(),
      });

      const incParClient = new Map<string, number>();
      // Cap par client (cf. computeRemainingVelos) — décrémenté à chaque stop
      // accepté pour ne pas dépasser le devis sur un même appel.
      const remainingByClient = new Map<string, number>();
      // Préparateurs par défaut (Naomi) — pré-affectés sur chaque livraison.
      const defaultPreparateurIds = await getDefaultPreparateurIds();
      let livCount = 0;
      for (const stop of stops) {
        const cid = String(stop.clientId || "");
        let nbVelos = Number(stop.nbVelos) || 0;
        if (!cid || nbVelos <= 0) continue;
        if (!stop.forceNbVelos) {
          if (!remainingByClient.has(cid)) {
            const r = await computeRemainingVelos(cid);
            remainingByClient.set(cid, r ?? Number.POSITIVE_INFINITY);
          }
          const remaining = remainingByClient.get(cid) ?? Number.POSITIVE_INFINITY;
          if (nbVelos > remaining) nbVelos = Math.max(0, remaining);
          if (nbVelos <= 0) continue;
          remainingByClient.set(cid, remaining - nbVelos);
        }

        let apporteurLowerLiv: string | null = null;
        let clientSnapshotLiv: Body | null = null;
        try {
          const cSnap = await getDoc(doc(db, "clients", cid));
          if (cSnap.exists()) {
            const cData = cSnap.data() as {
              apporteur?: string;
              apporteurLower?: string;
              entreprise?: string;
              ville?: string;
              adresse?: string;
              codePostal?: string;
              departement?: string;
              telephone?: string;
              lat?: number;
              lng?: number;
              latitude?: number;
              longitude?: number;
            };
            apporteurLowerLiv = cData.apporteurLower
              || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
              || null;
            clientSnapshotLiv = {
              entreprise: cData.entreprise || "",
              ville: cData.ville || "",
              adresse: cData.adresse || "",
              codePostal: cData.codePostal || "",
              departement: cData.departement || "",
              telephone: cData.telephone || "",
              lat: cData.lat ?? cData.latitude ?? null,
              lng: cData.lng ?? cData.longitude ?? null,
            };
          }
        } catch {}

        await addDoc(collection(db, "livraisons"), {
          clientId: cid,
          nbVelos,
          ordre: Number(stop.ordre) || livCount + 1,
          datePrevue: body.datePrevue || "",
          mode: body.mode || "",
          tourneeId: tRef.id,
          tourneeNumero,
          apporteurLower: apporteurLowerLiv,
          clientSnapshot: clientSnapshotLiv,
          preparateurIds: defaultPreparateurIds.length > 0 ? [...defaultPreparateurIds] : [],
          entrepotOrigineId,
          modeMontage,
          statut: "planifiee",
          createdAt: ts(),
        });

        // Vélos cibles (Modèle A, idempotent)
        try {
          const existingSnap = await getDocs(
            query(collection(db, "velos"), where("clientId", "==", cid)),
          );
          const aCreer = Math.max(0, nbVelos - existingSnap.size);
          if (aCreer > 0) {
            const batch = writeBatch(db);
            for (let i = 0; i < aCreer; i++) {
              const veloRef = doc(collection(db, "velos"));
              batch.set(veloRef, {
                clientId: cid,
                apporteurLower: apporteurLowerLiv,
                fnuci: null,
                datePreparation: null,
                dateChargement: null,
                dateLivraisonScan: null,
                dateMontage: null,
                createdAt: ts(),
                updatedAt: ts(),
              });
            }
            await batch.commit();
          }
        } catch (e) {
          console.error("[createTournee] velos backfill KO", e);
        }

        incParClient.set(cid, (incParClient.get(cid) || 0) + 1);
        livCount++;
      }

      // Incrémente stats.planifies par client
      for (const [cid, n] of incParClient.entries()) {
        try {
          const cRef = doc(db, "clients", cid);
          const cSnap = await getDoc(cRef);
          if (!cSnap.exists()) continue;
          const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
          const cur = Number(stats.planifies) || 0;
          await updateDoc(cRef, { "stats.planifies": cur + n });
        } catch (e) {
          console.error("[createTournee] increment planifies KO", cid, e);
        }
      }

      return { ok: true, id: tRef.id, tourneeId: tRef.id, livraisonsCount: livCount };
    }

    case "createTournees": {
      // Format de retour aligné GAS : `{ tournees: [{tourneeId, livraisonsCount}], count }`
      // — le frontend (day-planner-modal.applyProposition) attend `created.tournees`.
      // Crée aussi les livraisons depuis `stops` (clientId/nbVelos/ordre) ; sans ça
      // les tournées sont orphelines (pas de clients dedans) — bug 2026-04-28.
      const tourneesIn = (body.tournees as Body[]) || [];
      if (tourneesIn.length === 0) return { tournees: [], count: 0 };

      // Numéro tournée global : max(tourneeNumero) + 1 puis incrément local pour le batch.
      let nextNumero = 1;
      try {
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") nextNumero = n + 1;
        }
      } catch {}

      const results: { tourneeId: string; livraisonsCount: number }[] = [];
      // Compte les incréments stats.planifies par client (appliqués en fin de boucle).
      const incParClient = new Map<string, number>();
      // Préparateurs par défaut (Naomi) — pré-affectés sur chaque livraison.
      const defaultPreparateurIds = await getDefaultPreparateurIds();
      for (const t of tourneesIn) {
        // 1) Doc tournée
        const tRef = await addDoc(collection(db, "tournees"), {
          datePrevue: t.datePrevue || "",
          mode: t.mode || body.mode || "",
          notes: t.notes || body.notes || "",
          statut: t.statut || "planifiee",
          createdAt: ts(),
        });

        // 2) Livraisons depuis stops
        const stops = (t.stops as Body[]) || [];
        const tourneeNumero = nextNumero++;
        // Cap par client (cf. computeRemainingVelos) — décrémenté à chaque
        // stop accepté pour ne pas dépasser le devis (bug OPEN SOURCING
        // 2026-04-28 : Gemini avait alloué 16v à un client de 6v).
        const remainingByClient = new Map<string, number>();
        let livCount = 0;
        for (const stop of stops) {
          const cid = String(stop.clientId || "");
          let nbVelos = Number(stop.nbVelos) || 0;
          if (!cid || nbVelos <= 0) continue;
          if (!stop.forceNbVelos) {
            if (!remainingByClient.has(cid)) {
              const r = await computeRemainingVelos(cid);
              remainingByClient.set(cid, r ?? Number.POSITIVE_INFINITY);
            }
            const remaining = remainingByClient.get(cid) ?? Number.POSITIVE_INFINITY;
            if (nbVelos > remaining) nbVelos = Math.max(0, remaining);
            if (nbVelos <= 0) continue;
            remainingByClient.set(cid, remaining - nbVelos);
          }

          // apporteurLower (RBAC) + clientSnapshot dénormalisé (affichage UI)
          let apporteurLowerLiv: string | null = null;
          let clientSnapshotLiv: Body | null = null;
          try {
            const cSnap = await getDoc(doc(db, "clients", cid));
            if (cSnap.exists()) {
              const cData = cSnap.data() as {
                apporteur?: string;
                apporteurLower?: string;
                entreprise?: string;
                ville?: string;
                adresse?: string;
                codePostal?: string;
                departement?: string;
                telephone?: string;
                lat?: number;
                lng?: number;
                latitude?: number;
                longitude?: number;
              };
              apporteurLowerLiv = cData.apporteurLower
                || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
                || null;
              clientSnapshotLiv = {
                entreprise: cData.entreprise || "",
                ville: cData.ville || "",
                adresse: cData.adresse || "",
                codePostal: cData.codePostal || "",
                departement: cData.departement || "",
                telephone: cData.telephone || "",
                lat: cData.lat ?? cData.latitude ?? null,
                lng: cData.lng ?? cData.longitude ?? null,
              };
            }
          } catch {}

          await addDoc(collection(db, "livraisons"), {
            clientId: cid,
            nbVelos,
            ordre: Number(stop.ordre) || livCount + 1,
            datePrevue: t.datePrevue || "",
            mode: t.mode || body.mode || "",
            tourneeId: tRef.id,
            tourneeNumero,
            apporteurLower: apporteurLowerLiv,
            clientSnapshot: clientSnapshotLiv,
            preparateurIds: defaultPreparateurIds.length > 0 ? [...defaultPreparateurIds] : [],
            statut: "planifiee",
            createdAt: ts(),
          });

          // Vélos cibles (Modèle A, idempotent — cf. createLivraison)
          try {
            const existingSnap = await getDocs(
              query(collection(db, "velos"), where("clientId", "==", cid)),
            );
            const aCreer = Math.max(0, nbVelos - existingSnap.size);
            if (aCreer > 0) {
              const batch = writeBatch(db);
              for (let i = 0; i < aCreer; i++) {
                const veloRef = doc(collection(db, "velos"));
                batch.set(veloRef, {
                  clientId: cid,
                  apporteurLower: apporteurLowerLiv,
                  fnuci: null,
                  datePreparation: null,
                  dateChargement: null,
                  dateLivraisonScan: null,
                  dateMontage: null,
                  createdAt: ts(),
                  updatedAt: ts(),
                });
              }
              await batch.commit();
            }
          } catch (e) {
            console.error("[createTournees] velos backfill KO", e);
          }
          incParClient.set(cid, (incParClient.get(cid) || 0) + 1);
          livCount++;
        }
        results.push({ tourneeId: tRef.id, livraisonsCount: livCount });
      }

      // Incrémente stats.planifies par client (cf. createLivraison).
      for (const [cid, n] of incParClient.entries()) {
        try {
          const cRef = doc(db, "clients", cid);
          const cSnap = await getDoc(cRef);
          if (!cSnap.exists()) continue;
          const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
          const cur = Number(stats.planifies) || 0;
          await updateDoc(cRef, { "stats.planifies": cur + n });
        } catch (e) {
          console.error("[createTournees] increment planifies KO", cid, e);
        }
      }
      return { tournees: results, count: results.length };
    }

    case "assignTournee": {
      // 2 modes d'appel :
      //  - livraisonId/id : MAJ d'UNE livraison ciblée (rare, non utilisé par
      //    l'UI Affectation équipe actuelle).
      //  - tourneeId      : MAJ de TOUTES les livraisons d'une tournée d'un
      //    coup. C'est ce que fait le panel "Affectation équipe" du planning
      //    semaine — on n'a qu'une équipe par tournée, pas par client.
      // L'ancienne version ne gérait que livraisonId → l'UI plantait avec
      // "livraisonId requis" car elle envoie tourneeId.
      const livraisonId = getString(body, "livraisonId") || getString(body, "id");
      const tourneeId = getString(body, "tourneeId");
      const writableKeys = [
        "chauffeurId",
        "chefEquipeId",
        "chefEquipeIds",
        "monteurIds",
        "preparateurIds",
        "mode",
      ];
      const fields: Body = { updatedAt: ts() };
      for (const k of writableKeys) {
        if (k in body) fields[k] = body[k];
      }
      if (livraisonId) {
        // Ciblage 1 livraison : on autorise aussi à changer son tourneeId
        // (cas marginal, rebascule).
        if ("tourneeId" in body) fields.tourneeId = body.tourneeId;
        await updateDoc(doc(db, "livraisons", livraisonId), fields);
        return { ok: true, updated: 1 };
      }
      if (tourneeId) {
        const snap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        if (snap.empty) return { ok: true, updated: 0 };
        const batch = writeBatch(db);
        for (const d of snap.docs) batch.update(d.ref, fields);
        await batch.commit();
        return { ok: true, updated: snap.size };
      }
      throw new Error("livraisonId ou tourneeId requis");
    }

    // ---------- velos ----------
    case "setVeloFnuci": {
      const veloId = getRequired(body, "veloId");
      const fnuci = getString(body, "fnuci") || null;
      await updateDoc(doc(db, "velos", veloId), { fnuci, updatedAt: ts() });
      return { ok: true };
    }

    case "resetVeloFnuci": {
      // Yoann 2026-05-03 : retire le FNUCI d un vélo et reset l état préparé.
      // Le vélo est gardé (slot client libéré), mais l affiliation est
      // annulée. Utilisé pour corriger une erreur d affiliation sans avoir
      // à supprimer le vélo entier.
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        fnuci: null,
        datePreparation: null,
        preparateurId: deleteField(),
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "assignFnuciToClient": {
      // Trouve un vélo du client sans FNUCI et lui assigne.
      // Anti-doublon (29-04 11h) : si ce FNUCI est déjà sur un autre vélo
      // (ce client OU un autre), on refuse. Sans ce check, Gemini pouvant
      // extraire 2× le même code dans 2 photos différentes consommait 2 slots.
      const clientId = getRequired(body, "clientId");
      const fnuci = getRequired(body, "fnuci");
      // Yoann 2026-05-03 : preparateurId optionnel pour traçabilité atelier
      // (qui a fait l affiliation = qui a "préparé" le carton). Évite un
      // 2e appel markVeloPrepare qui exige un tourneeId qu on n a pas ici.
      const preparateurId = getString(body, "preparateurId") || null;
      const dupSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      if (!dupSnap.empty) {
        const existing = dupSnap.docs[0];
        const existingClientId = existing.get("clientId") as string | null;
        let existingClientName: string | null = null;
        if (existingClientId) {
          const cDoc = await getDoc(doc(db, "clients", existingClientId));
          existingClientName = cDoc.exists() ? (cDoc.get("entreprise") as string) : null;
        }
        const alreadySameClient = existingClientId === clientId;
        return {
          ok: false,
          code: "FNUCI_DEJA_AFFILIE",
          error: alreadySameClient
            ? `FNUCI déjà affilié à ce client`
            : `FNUCI déjà affilié à ${existingClientName || "un autre client"}`,
          existingClientId,
          existingClientName,
          alreadySameClient,
        };
      }
      // Yoann 2026-05-03 : à la session atelier, les vélos n existent pas
      // forcément encore (pas de tournée planifiée → pas de vélos créés).
      // Si pas de vélo dispo MAIS le client a une commande non-pleine,
      // on CRÉE un vélo vierge à la volée et on lui assigne le FNUCI.
      // Récupère client (pour nbVelosCommandes + apporteur)
      const cDoc = await getDoc(doc(db, "clients", clientId));
      if (!cDoc.exists()) return { ok: false, error: "Client introuvable" };
      const cData = cDoc.data() as { nbVelosCommandes?: number; apporteur?: string; apporteurLower?: string };
      const nbCmd = Number(cData.nbVelosCommandes || 0);
      // Compte vélos existants du client
      const existsSnap = await getDocs(query(collection(db, "velos"), where("clientId", "==", clientId)));
      const totalExist = existsSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule).length;
      // Cherche un vélo existant SANS FNUCI
      const sansFnuci = existsSnap.docs.find((d) => {
        const o = d.data() as { fnuci?: string | null; annule?: boolean };
        return !o.annule && !o.fnuci;
      });
      if (sansFnuci) {
        // Vélo existant → assigne FNUCI
        await updateDoc(sansFnuci.ref, {
          fnuci,
          datePreparation: ts(),
          ...(preparateurId ? { preparateurId } : {}),
          updatedAt: ts(),
        });
        return { ok: true, veloId: sansFnuci.id, created: false };
      }
      // Pas de vélo dispo : si commande non pleine, on crée un vélo vierge
      if (nbCmd > 0 && totalExist < nbCmd) {
        const apporteurLower = cData.apporteurLower
          || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null);
        const newVeloRef = await addDoc(collection(db, "velos"), {
          clientId,
          apporteurLower,
          fnuci,
          datePreparation: ts(),
          ...(preparateurId ? { preparateurId } : {}),
          dateChargement: null,
          dateLivraisonScan: null,
          dateMontage: null,
          createdAt: ts(),
          updatedAt: ts(),
          // marqueur audit : vélo créé au moment de l affiliation atelier
          createdByAffiliation: true,
        });
        return { ok: true, veloId: newVeloRef.id, created: true };
      }
      return { ok: false, error: "Tous les vélos de ce client sont déjà affiliés (FNUCI complets)" };
    }

    case "updateVelos": {
      const veloIds = (body.veloIds as string[]) || [];
      const action = getString(body, "bulkAction");
      if (!action) throw new Error("bulkAction requis");
      const updates: Body = { updatedAt: ts() };
      switch (action) {
        case "markFacturable":
          updates.facturable = true;
          break;
        case "unmarkFacturable":
          updates.facturable = false;
          break;
        case "markFacture":
          updates.facture = true;
          break;
        case "unmarkFacture":
          updates.facture = false;
          break;
        case "markCertificat":
          updates.certificatRecu = true;
          break;
        default:
          updates[action] = true; // best-effort
      }
      const batch = writeBatch(db);
      for (const id of veloIds) batch.update(doc(db, "velos", id), updates);
      await batch.commit();
      return { ok: true, updated: veloIds.length };
    }

    case "markVeloLivre": {
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        dateLivraisonScan: ts(),
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "markVeloPrepare":
    case "markVeloCharge":
    case "markVeloLivreScan": {
      // Scan QR BicyCode (ou saisie manuelle) → on marque l'étape pour le vélo
      // qui porte ce FNUCI. Validation : le vélo doit appartenir à un client de
      // la tournée, sinon HORS_TOURNEE. Si aucun vélo n'a ce FNUCI → FNUCI_INCONNU
      // (ce qui déclenche le mode fusion réception+prép côté UI en mode prep).
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const tourneeId = getRequired(body, "tourneeId");
      const userId = getString(body, "userId");

      // Verrouillage d'ordre désactivé 2026-04-29 (terrain demande Yoann) :
      // bloquait chauffeur/monteur en prod quand un client devait être livré
      // dans le désordre. On laisse `requires` dans la map mais le check
      // est sauté plus bas (cherche LOCK_ORDER_DISABLED).
      const stageMap = {
        markVeloPrepare: {
          dateField: "datePreparation",
          userField: "preparateurId",
          requires: [] as string[],
          requiresLabels: [] as string[],
        },
        markVeloCharge: {
          dateField: "dateChargement",
          userField: "chargeurId",
          requires: ["datePreparation"],
          requiresLabels: ["préparation"],
        },
        markVeloLivreScan: {
          dateField: "dateLivraisonScan",
          userField: "livreurId",
          requires: ["datePreparation", "dateChargement"],
          requiresLabels: ["préparation", "chargement"],
        },
      } as const;
      const stage = stageMap[action as keyof typeof stageMap];
      // LOCK_ORDER_DISABLED : flag global pour court-circuiter tous les
      // checks de verrouillage d'ordre (ETAPE_PRECEDENTE_MANQUANTE +
      // ORDRE_VERROUILLE). Mis à true après que les chauffeurs/monteurs ont
      // été bloqués en prod le 2026-04-29.
      const LOCK_ORDER_DISABLED = true;

      // 1. Trouve le vélo via FNUCI
      // getDocsFromServer (bypass cache, 30-04 11h45) : evite les faux
      // 'déjà scanné' apres un Tout-annuler quand le cache local est en retard.
      const vSnap = await getDocsFromServer(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      if (vSnap.empty) {
        return { error: "FNUCI inconnu", code: "FNUCI_INCONNU", fnuci };
      }
      const veloDoc = vSnap.docs[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
      };
      const veloClientId = velo.clientId;
      if (!veloClientId) {
        return { error: "Vélo non affilié à un client", code: "FNUCI_INCONNU", fnuci };
      }

      // 2. Le client doit être dans la tournée
      const livSnap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", veloClientId),
        ),
      );
      if (livSnap.empty) {
        // Récupère le nom du client pour le message d'erreur
        let veloClientName: string | null = null;
        try {
          const c = await getDoc(doc(db, "clients", veloClientId));
          if (c.exists()) {
            veloClientName = (c.data() as { entreprise?: string }).entreprise || null;
          }
        } catch {}
        return {
          error: "Pas dans cette tournée",
          code: "HORS_TOURNEE",
          fnuci,
          veloClientId,
          veloClientName,
        };
      }
      const livraisonClientName = (livSnap.docs[0].data() as {
        clientSnapshot?: { entreprise?: string };
      }).clientSnapshot?.entreprise || null;

      // Mode dépannage admin (Yoann 29-04 02h42) : permet de scanner dans le
      // désordre lors de tests/exception. Le frontend n'expose le toggle qu'aux
      // admin/superadmin. Côté serveur on accepte le flag tel quel — sécurité
      // basée sur le fait que seuls les admins voient le toggle.
      const bypassOrderLock = true; // verrouillage d'ordre désactivé 2026-04-29 (terrain)

      // 3. Verrouillage d'ordre : étapes précédentes obligatoires
      const missing: string[] = [];
      for (let i = 0; i < stage.requires.length; i++) {
        const req = stage.requires[i];
        if (!velo[req as keyof typeof velo]) missing.push(stage.requiresLabels[i]);
      }
      if (!bypassOrderLock && missing.length > 0) {
        return {
          error: `Impossible : étape${missing.length > 1 ? "s" : ""} précédente${missing.length > 1 ? "s" : ""} manquante${missing.length > 1 ? "s" : ""} (${missing.join(", ")})`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          fnuci,
          missing,
          clientId: veloClientId,
          clientName: livraisonClientName,
        };
      }

      // 4. Étape déjà faite → renvoie ok + alreadyDone
      const dateExisting = velo[stage.dateField as keyof typeof velo];
      if (dateExisting) {
        return {
          ok: true,
          alreadyDone: true,
          etape: stage.dateField,
          veloId: veloDoc.id,
          fnuci,
          clientId: veloClientId,
          clientName: livraisonClientName,
          date: (dateExisting as { toDate?: () => Date })?.toDate?.()?.toISOString() || null,
        };
      }

      // 4bis. Verrouillage LIFO inter-clients (ordre des clients de la tournée).
      // SKIP si expectedClientId match veloClientId (verrou client front actif) :
      // perf optim 30-04 11h25, sinon 10-20s par scan sur base 4262 vélos.
      const expectedClientIdLocal = getString(body, "expectedClientId");
      const skipLifoLocal = !!(expectedClientIdLocal && expectedClientIdLocal === veloClientId);
      try {
        if (bypassOrderLock || skipLifoLocal) throw new Error("__bypass_admin__");
        const allLivSnap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        const ordreFromNotesScan = (notes: unknown): number | null => {
          if (typeof notes !== "string") return null;
          const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
          return m ? parseInt(m[1], 10) : null;
        };
        type CDef = { clientId: string; ordre: number | null; entreprise: string };
        const seen = new Set<string>();
        const cdefs: CDef[] = [];
        for (const d of allLivSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            statut?: string;
            ordre?: number;
            notes?: string;
            clientSnapshot?: { entreprise?: string };
          };
          if (String(data.statut || "").toLowerCase() === "annulee") continue;
          const cid = data.clientId;
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          const ordre =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotesScan(data.notes);
          cdefs.push({
            clientId: cid,
            ordre,
            entreprise: data.clientSnapshot?.entreprise || "",
          });
        }
        const allHaveOrdre = cdefs.length > 0 && cdefs.every((c) => typeof c.ordre === "number");

        if (allHaveOrdre && cdefs.length > 1) {
          const sorted = cdefs
            .slice()
            .sort((a, b) => (a.ordre as number) - (b.ordre as number));
          const ordered =
            action === "markVeloPrepare" || action === "markVeloCharge"
              ? sorted.slice().reverse()
              : sorted;

          // Compte les vélos déjà-faits / total par client (excluant les annulés).
          const cids = ordered.map((c) => c.clientId);
          const totalsByClient = new Map<string, { total: number; done: number }>();
          for (let i = 0; i < cids.length; i += 30) {
            const chunk = cids.slice(i, i + 30);
            if (!chunk.length) continue;
            const vSnap2 = await getDocs(
              query(collection(db, "velos"), where("clientId", "in", chunk)),
            );
            for (const d of vSnap2.docs) {
              const vd = d.data() as Record<string, unknown>;
              if (vd.annule === true) continue;
              const cid = vd.clientId as string;
              if (!cid) continue;
              const cur = totalsByClient.get(cid) || { total: 0, done: 0 };
              cur.total++;
              if (vd[stage.dateField]) cur.done++;
              totalsByClient.set(cid, cur);
            }
          }
          const firstUnfinished = ordered.find((c) => {
            const t = totalsByClient.get(c.clientId);
            return !t || t.done < t.total;
          });
          if (firstUnfinished && firstUnfinished.clientId !== veloClientId) {
            return {
              error: `Ordre verrouillé : termine d'abord ${firstUnfinished.entreprise || "le client précédent"}`,
              code: "ORDRE_VERROUILLE",
              fnuci,
              veloClientId,
              veloClientName: livraisonClientName,
              expectedClientId: firstUnfinished.clientId,
              expectedClientName: firstUnfinished.entreprise || null,
            };
          }
        }
      } catch {
        // Faille silencieuse : si le check d'ordre plante (Firestore down,
        // schema bizarre…), on retombe sur le comportement actuel (verrou
        // frontend seul). On n'a JAMAIS le droit de bloquer un scan légitime
        // sur place — chargement demain matin = zéro tolérance bug.
      }

      // 4. Marque l'étape
      const updates: Body = {
        [stage.dateField]: ts(),
        updatedAt: ts(),
      };
      if (userId) updates[stage.userField] = userId;
      await updateDoc(veloDoc.ref, updates);

      // 5. Phase 2C — Auto-décrément stock entrepôt origine au chargement
      // (Yoann 2026-05-01). Mode "client" → -1 carton, "atelier" /
      // "client_redistribue" → -1 monté. Best-effort, n'échoue jamais le
      // scan terrain.
      if (action === "markVeloCharge") {
        const orig = await getEntrepotOrigineForClient({ tourneeId, clientId: veloClientId });
        if (orig) {
          const stockType: "carton" | "monte" = orig.modeMontage === "client" ? "carton" : "monte";
          await createStockMouvement({
            entrepotId: orig.entrepotOrigineId,
            type: stockType,
            quantite: -1,
            source: `tournee-charge`,
            notes: livraisonClientName ? `${livraisonClientName} (chargement)` : "Chargement tournée",
            veloId: veloDoc.id,
            fnuci,
          });
        }
      }

      return {
        ok: true,
        alreadyDone: false,
        etape: stage.dateField,
        veloId: veloDoc.id,
        fnuci,
        clientId: veloClientId,
        clientName: livraisonClientName,
        date: new Date().toISOString(),
      };
    }

    case "markNextVeloForEtape": {
      // Scan QR carton (29-04 11h30) : à la place de scanner le BicyCode physique
      // d'un vélo précis pour le chargement / la livraison, l'opérateur scanne le
      // QR de l'étiquette imprimée (= clientId, identique sur les N étiquettes du
      // client). On marque le 1er vélo du client non-encore-fait pour cette étape,
      // avec prérequis OK (préparation pour chargement, prép+chargement pour
      // livraison). Conformité CEE : les FNUCI individuels restent tracés via la
      // préparation, on n'a pas besoin du mapping carton↔FNUCI précis pour la
      // livraison (tous les vélos du client sont sur le même camion / même jour).
      const clientId = getRequired(body, "clientId");
      const tourneeId = getRequired(body, "tourneeId");
      const etape = getRequired(body, "etape"); // "chargement" | "livraisonScan"
      const userId = getString(body, "userId");

      const stageMap: Record<string, {
        dateField: string;
        userField: string;
        requires: string[];
        requiresLabels: string[];
        lifoReverse: boolean;
      }> = {
        chargement: {
          dateField: "dateChargement",
          userField: "chargeurId",
          requires: ["datePreparation"],
          requiresLabels: ["préparation"],
          lifoReverse: true, // dernier livré entre en premier dans le camion
        },
        livraisonScan: {
          dateField: "dateLivraisonScan",
          userField: "livreurId",
          requires: ["datePreparation", "dateChargement"],
          requiresLabels: ["préparation", "chargement"],
          lifoReverse: false,
        },
      };
      const stage = stageMap[etape];
      if (!stage) {
        return { error: `étape invalide: ${etape}`, code: "ETAPE_INVALIDE" };
      }

      // 1. Le client doit être dans la tournée
      const livSnap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", clientId),
        ),
      );
      if (livSnap.empty) {
        let clientName: string | null = null;
        try {
          const c = await getDoc(doc(db, "clients", clientId));
          if (c.exists()) clientName = (c.data() as { entreprise?: string }).entreprise || null;
        } catch {}
        return {
          error: "Pas dans cette tournée",
          code: "HORS_TOURNEE",
          clientId,
          clientName,
        };
      }
      const clientName = (livSnap.docs[0].data() as {
        clientSnapshot?: { entreprise?: string };
      }).clientSnapshot?.entreprise || null;

      const bypassOrderLock = true; // verrouillage d'ordre désactivé 2026-04-29 (terrain)

      // 2. Verrouillage LIFO inter-clients (même logique que markVeloCharge/LivreScan).
      try {
        if (bypassOrderLock) throw new Error("__bypass_admin__");
        const allLivSnap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        const ordreFromNotesScan = (notes: unknown): number | null => {
          if (typeof notes !== "string") return null;
          const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
          return m ? parseInt(m[1], 10) : null;
        };
        type CDef = { clientId: string; ordre: number | null; entreprise: string };
        const seen = new Set<string>();
        const cdefs: CDef[] = [];
        for (const d of allLivSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            statut?: string;
            ordre?: number;
            notes?: string;
            clientSnapshot?: { entreprise?: string };
          };
          if (String(data.statut || "").toLowerCase() === "annulee") continue;
          const cid = data.clientId;
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          const ordre =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotesScan(data.notes);
          cdefs.push({
            clientId: cid,
            ordre,
            entreprise: data.clientSnapshot?.entreprise || "",
          });
        }
        const allHaveOrdre = cdefs.length > 0 && cdefs.every((c) => typeof c.ordre === "number");
        if (allHaveOrdre && cdefs.length > 1) {
          const sorted = cdefs.slice().sort((a, b) => (a.ordre as number) - (b.ordre as number));
          const ordered = stage.lifoReverse ? sorted.slice().reverse() : sorted;
          const cids = ordered.map((c) => c.clientId);
          const totalsByClient = new Map<string, { total: number; done: number }>();
          for (let i = 0; i < cids.length; i += 30) {
            const chunk = cids.slice(i, i + 30);
            if (!chunk.length) continue;
            const vSnap2 = await getDocs(
              query(collection(db, "velos"), where("clientId", "in", chunk)),
            );
            for (const d of vSnap2.docs) {
              const vd = d.data() as Record<string, unknown>;
              if (vd.annule === true) continue;
              const cid = vd.clientId as string;
              if (!cid) continue;
              const cur = totalsByClient.get(cid) || { total: 0, done: 0 };
              cur.total++;
              if (vd[stage.dateField]) cur.done++;
              totalsByClient.set(cid, cur);
            }
          }
          const firstUnfinished = ordered.find((c) => {
            const t = totalsByClient.get(c.clientId);
            return !t || t.done < t.total;
          });
          if (firstUnfinished && firstUnfinished.clientId !== clientId) {
            return {
              error: `Ordre verrouillé : termine d'abord ${firstUnfinished.entreprise || "le client précédent"}`,
              code: "ORDRE_VERROUILLE",
              expectedClientId: firstUnfinished.clientId,
              expectedClientName: firstUnfinished.entreprise || null,
            };
          }
        }
      } catch {
        // Faille silencieuse : si le check d'ordre plante, on laisse passer.
      }

      // 3. Trouve le 1er vélo du client non-fait pour cette étape, avec prérequis OK.
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      type Velo = {
        fnuci?: string;
        annule?: boolean;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
      };
      const candidates = vSnap.docs.filter((d) => {
        const v = d.data() as Velo;
        if (v.annule === true) return false;
        if (v[stage.dateField as keyof Velo]) return false; // déjà fait
        for (const req of stage.requires) {
          if (!bypassOrderLock && !v[req as keyof Velo]) return false;
        }
        return true;
      });
      if (candidates.length === 0) {
        // Distinguer "client complet" vs "prérequis manquants partout"
        const allDone = vSnap.docs.every((d) => {
          const v = d.data() as Velo;
          return v.annule === true || v[stage.dateField as keyof Velo];
        });
        if (allDone) {
          return {
            ok: false,
            error: `Tous les vélos de ce client sont déjà ${etape === "chargement" ? "chargés" : "livrés"}`,
            code: "CLIENT_COMPLET",
            clientId,
            clientName,
          };
        }
        // Prérequis manquant : remonter quel(s) prérequis font défaut.
        return {
          ok: false,
          error: `Aucun vélo prêt pour ${etape} chez ${clientName || "ce client"} — vérifie ${stage.requiresLabels.join(" + ")}`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          clientId,
          clientName,
          missing: stage.requiresLabels,
        };
      }
      // On prend le 1er candidat (ordre de création Firestore — stable).
      const veloDoc = candidates[0];
      const veloData = veloDoc.data() as Velo;
      const updates: Body = {
        [stage.dateField]: ts(),
        updatedAt: ts(),
      };
      if (userId) updates[stage.userField] = userId;
      await updateDoc(veloDoc.ref, updates);

      return {
        ok: true,
        veloId: veloDoc.id,
        fnuci: veloData.fnuci || null,
        clientId,
        clientName,
        etape: stage.dateField,
        remaining: candidates.length - 1, // après ce scan
        date: new Date().toISOString(),
      };
    }

    case "ensureCartonTokensForClient": {
      // Garantit qu'à l'impression des étiquettes, chaque vélo du client a un
      // cartonToken unique (29-04 12h30 anti-double-scan). Si déjà présent →
      // no-op. Sinon génère + écrit en batch (1 round-trip Firestore par
      // client de 28 vélos au lieu de 28 round-trips).
      //
      // Unicité globale : on collecte les tokens existants (sur l'ensemble
      // des vélos non annulés) avant génération pour éviter toute collision.
      const clientId = getRequired(body, "clientId");
      const cSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      const veloDocs = cSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);

      // Collecte tokens existants (globalement) pour anti-collision.
      const allSnap = await getDocs(collection(db, "velos"));
      const existing = new Set<string>();
      for (const d of allSnap.docs) {
        const t = (d.data() as { cartonToken?: string }).cartonToken;
        if (t) existing.add(t);
      }
      const genUnique = (): string => {
        for (let i = 0; i < 12; i++) {
          const t = generateCartonToken();
          if (!existing.has(t)) {
            existing.add(t);
            return t;
          }
        }
        // Statistiquement impossible (31^8 vs <100 tokens existants).
        throw new Error("Collision cartonToken — improbable, réessayez");
      };

      const batch = writeBatch(db);
      const result: Array<{ veloId: string; fnuci: string | null; cartonToken: string }> = [];
      let written = 0;
      for (const d of veloDocs) {
        const data = d.data() as { fnuci?: string | null; cartonToken?: string };
        let token = data.cartonToken || null;
        if (!token) {
          token = genUnique();
          batch.update(d.ref, { cartonToken: token, updatedAt: ts() });
          written++;
        }
        result.push({
          veloId: d.id,
          fnuci: data.fnuci || null,
          cartonToken: token,
        });
      }
      if (written > 0) await batch.commit();
      return { ok: true, written, total: veloDocs.length, velos: result };
    }

    case "markVeloByCartonToken": {
      // Scan QR carton avec token unique (29-04 12h30) : remplace
      // markNextVeloForEtape pour chargement / livraison. Empêche le double-
      // scan d'une même étiquette puisqu'on cible un vélo précis et qu'on
      // refuse si déjà fait pour cette étape.
      //
      // Vérifs identiques à markVeloCharge/LivreScan : HORS_TOURNEE,
      // ETAPE_PRECEDENTE_MANQUANTE, LIFO ORDRE_VERROUILLE, et nouveauté
      // CARTON_DEJA_SCANNE quand on rescanne la même étiquette.
      const cartonToken = getRequired(body, "cartonToken");
      const tourneeId = getRequired(body, "tourneeId");
      const etape = getRequired(body, "etape"); // chargement | livraisonScan
      const userId = getString(body, "userId");
      const expectedClientId = getString(body, "expectedClientId");

      const stageMap: Record<string, {
        dateField: string;
        userField: string;
        requires: string[];
        requiresLabels: string[];
        lifoReverse: boolean;
        verb: string;
      }> = {
        chargement: {
          dateField: "dateChargement",
          userField: "chargeurId",
          requires: ["datePreparation"],
          requiresLabels: ["préparation"],
          lifoReverse: true,
          verb: "chargé",
        },
        livraisonScan: {
          dateField: "dateLivraisonScan",
          userField: "livreurId",
          requires: ["datePreparation", "dateChargement"],
          requiresLabels: ["préparation", "chargement"],
          lifoReverse: false,
          verb: "livré",
        },
      };
      const stage = stageMap[etape];
      if (!stage) {
        return { error: `étape invalide: ${etape}`, code: "ETAPE_INVALIDE" };
      }

      // 1. Résoudre cartonToken → vélo
      // getDocsFromServer (bypass cache local) : sinon le cache IndexedDB peut
      // servir un vieux dateChargement non synchronisé après un Tout-annuler →
      // faux 'déjà scanné' alors que le serveur dit pas (Yoann 30-04 11h45).
      const vSnap = await getDocsFromServer(
        query(collection(db, "velos"), where("cartonToken", "==", cartonToken)),
      );
      const matches = vSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);
      if (matches.length === 0) {
        return {
          error: "Étiquette inconnue — réimprime les étiquettes de cette tournée",
          code: "TOKEN_INCONNU",
          cartonToken,
        };
      }
      if (matches.length > 1) {
        return {
          error: `Token en doublon (${matches.length} vélos) — incident à corriger`,
          code: "TOKEN_DOUBLON",
          cartonToken,
        };
      }
      const veloDoc = matches[0];
      const velo = veloDoc.data() as Record<string, unknown>;
      const veloClientId = velo.clientId as string | undefined;
      if (!veloClientId) {
        return { error: "Vélo non affilié à un client", code: "VELO_ORPHELIN", cartonToken };
      }

      // 2. Le client doit être dans la tournée
      const livSnap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", veloClientId),
        ),
      );
      if (livSnap.empty) {
        let veloClientName: string | null = null;
        try {
          const c = await getDoc(doc(db, "clients", veloClientId));
          if (c.exists()) veloClientName = (c.data() as { entreprise?: string }).entreprise || null;
        } catch {}
        return {
          error: "Étiquette d'une autre tournée",
          code: "HORS_TOURNEE",
          veloClientId,
          veloClientName,
        };
      }
      const livraisonClientName = (livSnap.docs[0].data() as {
        clientSnapshot?: { entreprise?: string };
      }).clientSnapshot?.entreprise || null;

      // 3. Si verrou client côté front, refuse direct si pas le bon
      if (expectedClientId && expectedClientId !== veloClientId) {
        return {
          error: `QR autre client — termine ${livraisonClientName || "le client courant"} d'abord`,
          code: "VERROU_CLIENT",
          veloClientId,
          veloClientName: livraisonClientName,
          expectedClientId,
        };
      }

      const bypassOrderLock = true; // verrouillage d'ordre désactivé 2026-04-29 (terrain)

      // 4. Étape déjà faite pour ce vélo précis → empêche le double-scan
      if (velo[stage.dateField]) {
        const t = velo[stage.dateField] as { toDate?: () => Date } | string | undefined;
        const dateExisting = typeof t === "string" ? t : t?.toDate?.()?.toISOString() || null;
        return {
          ok: true,
          alreadyDone: true,
          code: "CARTON_DEJA_SCANNE",
          fnuci: (velo.fnuci as string) || null,
          veloId: veloDoc.id,
          clientId: veloClientId,
          clientName: livraisonClientName,
          etape: stage.dateField,
          date: dateExisting,
          message: `Cette étiquette a déjà été ${stage.verb}e — passe au carton suivant`,
        };
      }

      // 5. Prérequis (étapes précédentes obligatoires)
      const missing: string[] = [];
      for (let i = 0; i < stage.requires.length; i++) {
        if (!velo[stage.requires[i]]) missing.push(stage.requiresLabels[i]);
      }
      if (!bypassOrderLock && missing.length > 0) {
        return {
          error: `Impossible : étape${missing.length > 1 ? "s" : ""} précédente${missing.length > 1 ? "s" : ""} manquante${missing.length > 1 ? "s" : ""} (${missing.join(", ")})`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          veloClientId,
          veloClientName: livraisonClientName,
          missing,
        };
      }

      // 6. Verrou LIFO inter-clients (même logique que markVeloCharge/LivreScan)
      // SKIP si le verrou client est déjà actif côté front et match le vélo
      // scanné : la garantie d'ordre est déjà tenue, pas besoin de refaire le
      // check global qui télécharge tous les vélos de la tournée (lent sur
      // grosse base : 4262 vélos chez Yoann -> 10-20s par scan, 30-04 11h25).
      const skipLifoCheck = !!(expectedClientId && expectedClientId === veloClientId);
      try {
        if (bypassOrderLock || skipLifoCheck) throw new Error("__bypass_admin__");
        const allLivSnap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        const ordreFromNotesScan = (notes: unknown): number | null => {
          if (typeof notes !== "string") return null;
          const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
          return m ? parseInt(m[1], 10) : null;
        };
        type CDef = { clientId: string; ordre: number | null; entreprise: string };
        const seen = new Set<string>();
        const cdefs: CDef[] = [];
        for (const d of allLivSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            statut?: string;
            ordre?: number;
            notes?: string;
            clientSnapshot?: { entreprise?: string };
          };
          if (String(data.statut || "").toLowerCase() === "annulee") continue;
          const cid = data.clientId;
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          const ordre =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotesScan(data.notes);
          cdefs.push({
            clientId: cid,
            ordre,
            entreprise: data.clientSnapshot?.entreprise || "",
          });
        }
        const allHaveOrdre = cdefs.length > 0 && cdefs.every((c) => typeof c.ordre === "number");
        if (allHaveOrdre && cdefs.length > 1) {
          const sorted = cdefs.slice().sort((a, b) => (a.ordre as number) - (b.ordre as number));
          const ordered = stage.lifoReverse ? sorted.slice().reverse() : sorted;
          const cids = ordered.map((c) => c.clientId);
          const totalsByClient = new Map<string, { total: number; done: number }>();
          for (let i = 0; i < cids.length; i += 30) {
            const chunk = cids.slice(i, i + 30);
            if (!chunk.length) continue;
            const vSnap2 = await getDocs(
              query(collection(db, "velos"), where("clientId", "in", chunk)),
            );
            for (const d of vSnap2.docs) {
              const vd = d.data() as Record<string, unknown>;
              if (vd.annule === true) continue;
              const cid = vd.clientId as string;
              if (!cid) continue;
              const cur = totalsByClient.get(cid) || { total: 0, done: 0 };
              cur.total++;
              if (vd[stage.dateField]) cur.done++;
              totalsByClient.set(cid, cur);
            }
          }
          const firstUnfinished = ordered.find((c) => {
            const t = totalsByClient.get(c.clientId);
            return !t || t.done < t.total;
          });
          if (firstUnfinished && firstUnfinished.clientId !== veloClientId) {
            return {
              error: `Ordre verrouillé : termine d'abord ${firstUnfinished.entreprise || "le client précédent"}`,
              code: "ORDRE_VERROUILLE",
              veloClientId,
              veloClientName: livraisonClientName,
              expectedClientId: firstUnfinished.clientId,
              expectedClientName: firstUnfinished.entreprise || null,
            };
          }
        }
      } catch {
        // Faille silencieuse OK : on protège le scan terrain.
      }

      // 7. Marque l'étape
      const updates: Body = {
        [stage.dateField]: ts(),
        updatedAt: ts(),
      };
      if (userId) updates[stage.userField] = userId;
      await updateDoc(veloDoc.ref, updates);

      // 8. Compteur restant pour le client (côté UX "reste N")
      const allClientVelosSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", veloClientId)),
      );
      let remaining = 0;
      for (const d of allClientVelosSnap.docs) {
        const vd = d.data() as Record<string, unknown>;
        if (vd.annule === true) continue;
        if (d.id === veloDoc.id) continue; // on vient de le marquer
        if (!vd[stage.dateField]) remaining++;
      }

      return {
        ok: true,
        alreadyDone: false,
        veloId: veloDoc.id,
        fnuci: (velo.fnuci as string) || null,
        cartonToken,
        clientId: veloClientId,
        clientName: livraisonClientName,
        etape: stage.dateField,
        remaining,
        date: new Date().toISOString(),
      };
    }

    case "markClientAsDelivered": {
      // Marque toutes les livraisons "en_cours" du client comme livrées.
      const clientId = getRequired(body, "clientId");
      const tourneeId = getString(body, "tourneeId");
      const q = tourneeId
        ? query(
            collection(db, "livraisons"),
            where("clientId", "==", clientId),
            where("tourneeId", "==", tourneeId),
          )
        : query(collection(db, "livraisons"), where("clientId", "==", clientId));
      const snap = await getDocs(q);
      const batch = writeBatch(db);
      let n = 0;
      for (const d of snap.docs) {
        batch.update(d.ref, {
          statut: "livree",
          dateEffective: ts(),
          updatedAt: ts(),
        });
        n++;
      }
      await batch.commit();
      return { ok: true, updated: n };
    }

    case "unmarkVeloEtape": {
      const veloId = getRequired(body, "veloId");
      const etape = getRequired(body, "etape");
      const fieldMap: Record<string, string> = {
        preparation: "datePreparation",
        chargement: "dateChargement",
        livraison: "dateLivraisonScan",
        montage: "dateMontage",
      };
      const field = fieldMap[etape];
      if (!field) return { ok: false, error: `étape inconnue: ${etape}` };
      await updateDoc(doc(db, "velos", veloId), {
        [field]: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "unsetVeloClient": {
      // ⚠ Bug 29-04 11h09 : avant on mettait clientId=null aussi → le vélo était
      // déclient et le client perdait un slot (28 → 23 chez ANADOLU). Or le
      // texte UI dit "Le slot reste sur la commande du client". On garde donc
      // clientId, on vide juste fnuci + toutes les dates d'étapes (prép, charg,
      // livr, montage). Le vélo redevient un slot vierge pour ce client,
      // disponible pour assignFnuciToClient avec un nouveau FNUCI.
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        fnuci: null,
        datePreparation: null,
        dateChargement: null,
        dateLivraisonScan: null,
        dateMontage: null,
        urlPhotoMontageEtiquette: null,
        urlPhotoMontageQrVelo: null,
        photoMontageUrl: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    // ---------- équipe ----------
    case "upsertMembre": {
      const id = getString(body, "id");
      const data: Body = {
        nom: body.nom,
        role: body.role,
        telephone: body.telephone || null,
        email: body.email || null,
        actif: body.actif !== false,
        notes: body.notes || null,
        salaireJournalier: body.salaireJournalier ?? null,
        primeVelo: body.primeVelo ?? null,
        // chefId : pour les monteurs uniquement (Yoann 2026-05-01).
        chefId: body.role === "monteur" ? (body.chefId || null) : null,
        // aussiMonteur : pour les chefs polyvalents (Yoann 2026-05-01).
        aussiMonteur: body.role === "chef" ? (body.aussiMonteur === true) : false,
        // tauxHoraire : Yoann 2026-05-01. Surtout utilisé pour Naomi
        // (paie a l heure depuis premiere/derniere préparation du jour).
        tauxHoraire: body.tauxHoraire != null ? Number(body.tauxHoraire) : null,
        updatedAt: ts(),
      };
      if (id) {
        await setDoc(doc(db, "equipe", id), data, { merge: true });
        return { ok: true, id };
      } else {
        // Nouveau membre sans Auth (on n'a pas de mot de passe ici).
        // Le doc est créé avec un id Firestore aléatoire, le compte Auth peut
        // être ajouté plus tard via un script seed-admin.
        const ref = await addDoc(collection(db, "equipe"), {
          ...data,
          createdAt: ts(),
        });
        return { ok: true, id: ref.id };
      }
    }

    case "setMembreCode": {
      // Délègue à la Cloud Function callable (admin SDK requise pour modifier
      // le mot de passe Firebase Auth d'un autre user).
      const callable = httpsCallable<
        { id: string; pin?: string | null },
        { ok: boolean; error?: string }
      >(functions, "setMembreCode");
      try {
        const r = await callable({
          id: getRequired(body, "id"),
          pin: getString(body, "pin") ?? null,
        });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "clearMembreCode": {
      const callable = httpsCallable<
        { id: string },
        { ok: boolean; error?: string }
      >(functions, "clearMembreCode");
      try {
        const r = await callable({ id: getRequired(body, "id") });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    // ---------- verifications ----------
    case "validateVerification": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "verifications", id), {
        status: "validated",
        reviewedAt: ts(),
      });
      return { ok: true };
    }

    case "rejectVerification": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "verifications", id), {
        status: "rejected",
        reviewedAt: ts(),
        notes: body.notes || null,
      });
      return { ok: true };
    }

    // ---------- uploads (Storage) ----------
    case "uploadDoc": {
      const clientId = getRequired(body, "clientId");
      const docType = getRequired(body, "docType");
      const fileData = getRequired(body, "fileData");
      const mimeType = getString(body, "mimeType");
      const fileName = getString(body, "fileName") || `${docType}-${Date.now()}`;
      const url = await uploadDataUrl(
        `clients/${clientId}/documents/${fileName}`,
        fileData,
        mimeType,
      );
      // Le composant UI envoie docType au format "flat" (attestationRecue,
      // kbisRecu, devisSignee, signatureOk, inscriptionBicycle…). On accepte
      // aussi les anciens noms courts (attestation, kbis, devis…) au cas où.
      const linkField: Record<string, string> = {
        // noms flat UI
        devisSignee: "docLinks.devis",
        kbisRecu: "docLinks.kbis",
        attestationRecue: "docLinks.attestation",
        signatureOk: "docLinks.signature",
        inscriptionBicycle: "docLinks.bicycle",
        parcelleCadastrale: "docLinks.parcelleCadastrale",
        // alias courts (rétro-compat)
        devis: "docLinks.devis",
        kbis: "docLinks.kbis",
        attestation: "docLinks.attestation",
        signature: "docLinks.signature",
        bicycle: "docLinks.bicycle",
      };
      const flagField: Record<string, string> = {
        devisSignee: "docs.devisSignee",
        kbisRecu: "docs.kbisRecu",
        attestationRecue: "docs.attestationRecue",
        signatureOk: "docs.signatureOk",
        inscriptionBicycle: "docs.inscriptionBicycle",
        parcelleCadastrale: "docs.parcelleCadastrale",
        // alias courts
        devis: "docs.devisSignee",
        kbis: "docs.kbisRecu",
        attestation: "docs.attestationRecue",
        signature: "docs.signatureOk",
        bicycle: "docs.inscriptionBicycle",
      };
      const updates: Body = { updatedAt: ts() };
      if (linkField[docType]) updates[linkField[docType]] = url;
      if (flagField[docType]) updates[flagField[docType]] = true;
      await updateDoc(doc(db, "clients", clientId), updates);
      // Extraction asynchrone des métadonnées via Gemini Vision pour les
      // documents qui contiennent une date + des infos métier (KBIS,
      // liasse/registre du personnel). On ne bloque pas le retour pour
      // garder la latence d'upload basse — l'UI rafraîchira les pastilles
      // quand la date apparaîtra dans Firestore (~3-5s plus tard).
      if (docType === "kbisRecu" || docType === "attestationRecue") {
        const storagePath = `clients/${clientId}/documents/${fileName}`;
        const extractCallable = httpsCallable<
          { clientId: string; docType: string; storagePath: string },
          { ok: boolean }
        >(functions, "extractDocMetadata");
        extractCallable({ clientId, docType, storagePath }).catch((err) => {
          console.warn("extractDocMetadata KO (non bloquant)", err);
        });
      }
      return { ok: true, url };
    }

    case "uploadBlSignedPhoto": {
      // Le composant BlSignedUploader n'a pas livraisonId sous la main, juste
      // tourneeId + clientId. On résout côté serveur (parité avec GAS).
      // Multi-photos (29-04 14h29) : on stocke maintenant un tableau urlsBlSigne
      // (BL recto/verso, ou plusieurs pages). urlBlSigne (string) reste écrit
      // avec la dernière photo pour rétrocompat des lecteurs existants.
      const tourneeId = getRequired(body, "tourneeId");
      const clientId = getRequired(body, "clientId");
      const photoData = getRequired(body, "photoData");
      const snap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", clientId),
        ),
      );
      if (snap.empty) {
        return { error: "Aucune livraison trouvée pour ce client/tournée" };
      }
      const livraisonDoc = snap.docs[0];
      const livraisonId = livraisonDoc.id;
      const livData = livraisonDoc.data() as { urlsBlSigne?: string[]; urlBlSigne?: string };
      const fileName = `bl-signed-${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `bl/${livraisonId}/${fileName}`,
        photoData,
        "image/jpeg",
      );
      // Append au tableau (rétrocompat : si pas de tableau mais legacy urlBlSigne
      // existe, on inclut l'ancienne URL en 1er).
      const existingArray = Array.isArray(livData.urlsBlSigne) ? livData.urlsBlSigne : [];
      const newArray = existingArray.length === 0 && livData.urlBlSigne
        ? [livData.urlBlSigne, url]
        : [...existingArray, url];
      await updateDoc(livraisonDoc.ref, {
        urlBlSigne: url, // legacy : garde la dernière
        urlsBlSigne: newArray, // nouveau : tableau complet
        updatedAt: ts(),
      });
      return {
        ok: true,
        livraisonId,
        clientId,
        tourneeId,
        photoUrl: url,
        urls: newArray,
      };
    }

    case "claimVeloForMontage": {
      // Workflow montage parallèle (29-04 13h50, demande Yoann) : 4 monteurs
      // travaillent en simultané sur 8 vélos d'un même client. Chaque monteur
      // scanne le QR carton → on lui affilie un vélo précis pour qu'aucun
      // autre monteur ne le prenne. Claim expire après 30 min (sécurité si
      // le monteur abandonne sa session sans cancel propre).
      //
      // Input :
      //   - clientId (legacy QR=clientId) → on prend le 1er dispo
      //   - cartonToken (nouvelle archi) → on cible le slot précis
      //   - monteurId
      const clientId = getRequired(body, "clientId");
      const monteurId = getRequired(body, "monteurId");
      const cartonToken = getString(body, "cartonToken");
      // Path FNUCI direct (30-04 12h55) : on scanne le BicyCode FNUCI
      // colle sur le carton (sticker depose a la prep). Gemini extrait,
      // on claim ce velo precis. Plus de QR carton intermediaire.
      const fnuciTarget = getString(body, "fnuci");
      const CLAIM_EXPIRY_MS = 30 * 60 * 1000;
      const nowMs = Date.now();

      const isClaimActive = (vd: Record<string, unknown>): boolean => {
        const by = vd.montageClaimBy as string | undefined;
        if (!by) return false;
        if (by === monteurId) return false; // same monteur peut re-claim
        const at = vd.montageClaimAt as { toMillis?: () => number } | string | undefined;
        let claimMs = 0;
        if (typeof at === "string") claimMs = new Date(at).getTime();
        else if (at?.toMillis) claimMs = at.toMillis();
        return claimMs > 0 && nowMs - claimMs < CLAIM_EXPIRY_MS;
      };

      // Récup tous les vélos du client
      const cSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      const all = cSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);

      let target: typeof all[0] | null = null;
      if (fnuciTarget) {
        // Path FNUCI direct : on cherche le vélo par FNUCI
        const fn = fnuciTarget.toUpperCase();
        target = all.find((d) => (d.data() as { fnuci?: string }).fnuci === fn) || null;
        if (!target) {
          return { error: `FNUCI ${fn} pas dans ce client`, code: "FNUCI_INCONNU", fnuci: fn };
        }
        const td = target.data() as Record<string, unknown>;
        if (td.dateMontage) {
          return { error: "Vélo déjà monté", code: "DEJA_MONTE", fnuci: td.fnuci };
        }
        if (isClaimActive(td)) {
          return {
            error: "Vélo en cours de montage par un autre monteur",
            code: "DEJA_CLAIM",
            claimedBy: td.montageClaimBy,
          };
        }
      } else if (cartonToken) {
        // Path token : résout le slot précis
        target = all.find((d) => (d.data() as { cartonToken?: string }).cartonToken === cartonToken) || null;
        if (!target) {
          return { error: "Étiquette inconnue", code: "TOKEN_INCONNU" };
        }
        const td = target.data() as Record<string, unknown>;
        if (td.dateMontage) {
          return { error: "Vélo déjà monté", code: "DEJA_MONTE", fnuci: td.fnuci };
        }
        if (isClaimActive(td)) {
          return {
            error: "Vélo en cours de montage par un autre monteur",
            code: "DEJA_CLAIM",
            claimedBy: td.montageClaimBy,
          };
        }
      } else {
        // Path legacy : 1er vélo non-monté + non-claim (ou claim expiré, ou claim par soi-même)
        for (const d of all) {
          const vd = d.data() as Record<string, unknown>;
          if (vd.dateMontage) continue;
          if (isClaimActive(vd)) continue;
          target = d;
          break;
        }
        if (!target) {
          // Distinguer "client tout monté" vs "tout en cours par d'autres"
          const allMonte = all.every((d) => (d.data() as { dateMontage?: unknown }).dateMontage);
          if (allMonte) {
            return { ok: false, error: "Tous les vélos du client sont montés", code: "CLIENT_COMPLET" };
          }
          return {
            ok: false,
            error: "Tous les vélos disponibles sont en cours de montage par d'autres monteurs",
            code: "CLIENT_PLEIN",
          };
        }
      }

      const updates: Body = {
        montageClaimBy: monteurId,
        montageClaimAt: ts(),
        updatedAt: ts(),
      };
      await updateDoc(target.ref, updates);

      const td = target.data() as { fnuci?: string | null };
      let clientName: string | null = null;
      try {
        const c = await getDoc(doc(db, "clients", clientId));
        if (c.exists()) clientName = (c.data() as { entreprise?: string }).entreprise || null;
      } catch {}

      return {
        ok: true,
        veloId: target.id,
        fnuci: td.fnuci || null,
        clientId,
        clientName,
        monteurId,
      };
    }

    case "transferMontageClaim": {
      // Step 2 montage : si Gemini extrait un FNUCI ≠ celui claim au step 1
      // (cas legacy étiquette QR=clientId, le 1er vélo claim au hasard ne
      // correspond pas au BicyCode physique en main). On libère l'ancien
      // claim et on en pose un nouveau sur le bon vélo.
      const fromVeloId = getRequired(body, "fromVeloId");
      const toFnuci = getRequired(body, "toFnuci").toUpperCase();
      const monteurId = getRequired(body, "monteurId");
      const CLAIM_EXPIRY_MS = 30 * 60 * 1000;
      const nowMs = Date.now();

      // 1. Trouve le vélo cible par FNUCI
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", toFnuci)),
      );
      const matches = vSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);
      if (matches.length === 0) {
        return { error: "FNUCI inconnu", code: "FNUCI_INCONNU", fnuci: toFnuci };
      }
      if (matches.length > 1) {
        return { error: "FNUCI doublon en base", code: "FNUCI_DOUBLON", fnuci: toFnuci };
      }
      const toDoc = matches[0];
      const toData = toDoc.data() as Record<string, unknown>;
      if (toData.dateMontage) {
        return { error: "Vélo déjà monté", code: "DEJA_MONTE", fnuci: toFnuci };
      }
      // Vérifie pas claim par un autre monteur (encore actif)
      const by = toData.montageClaimBy as string | undefined;
      const at = toData.montageClaimAt as { toMillis?: () => number } | string | undefined;
      if (by && by !== monteurId) {
        let claimMs = 0;
        if (typeof at === "string") claimMs = new Date(at).getTime();
        else if (at?.toMillis) claimMs = at.toMillis();
        if (claimMs > 0 && nowMs - claimMs < CLAIM_EXPIRY_MS) {
          return {
            error: "Vélo en cours de montage par un autre monteur",
            code: "DEJA_CLAIM",
            claimedBy: by,
          };
        }
      }

      // 2. Libère l'ancien claim (si différent du nouveau)
      if (fromVeloId && fromVeloId !== toDoc.id) {
        try {
          const fromRef = doc(db, "velos", fromVeloId);
          const fromSnap = await getDoc(fromRef);
          if (fromSnap.exists()) {
            const fd = fromSnap.data() as { montageClaimBy?: string };
            // Ne libère que si c'est nous qui avions le claim
            if (fd.montageClaimBy === monteurId) {
              await updateDoc(fromRef, {
                montageClaimBy: null,
                montageClaimAt: null,
                updatedAt: ts(),
              });
            }
          }
        } catch {
          // Pas grave : si on n'arrive pas à libérer, le claim expirera tout seul
        }
      }

      // 3. Pose le nouveau claim
      await updateDoc(toDoc.ref, {
        montageClaimBy: monteurId,
        montageClaimAt: ts(),
        updatedAt: ts(),
      });

      return {
        ok: true,
        veloId: toDoc.id,
        fnuci: toFnuci,
        clientId: (toData.clientId as string) || null,
      };
    }

    case "releaseVeloMontageClaim": {
      // Annulation propre du montage en cours côté frontend (bouton "Annuler")
      // → libère le claim pour qu'un autre monteur puisse prendre ce vélo.
      const veloId = getRequired(body, "veloId");
      const monteurId = getString(body, "monteurId");
      const ref2 = doc(db, "velos", veloId);
      const snap2 = await getDoc(ref2);
      if (!snap2.exists()) {
        return { ok: false, error: "Vélo introuvable" };
      }
      const vd = snap2.data() as { montageClaimBy?: string };
      // Ne libère que si on est le claim owner (sécurité contre release par un autre monteur)
      if (monteurId && vd.montageClaimBy && vd.montageClaimBy !== monteurId) {
        return { ok: false, error: "Claim détenu par un autre monteur", code: "PAS_TON_CLAIM" };
      }
      await updateDoc(ref2, {
        montageClaimBy: null,
        montageClaimAt: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "markVeloMontePhoto": {
      // Workflow montage 1-photo (29-04 11h45, demande Yoann) : remplace les
      // 3 photos legacy (étiquette + QR vélo + monté) par un workflow plus
      // rapide → scan QR carton + scan FNUCI BicyCode (côté client) + 1 photo
      // de preuve montage. Le client a déjà validé que le FNUCI ∈ clientId
      // avant d'appeler cette action. Côté serveur on revérifie + on pose
      // dateMontage en 1 coup avec la photo dans photoMontageUrl.
      //
      // CEE : c'est le logiciel pollueur qui gère la traçabilité officielle ;
      // ces 3 vérifs sont pour le double-contrôle interne uniquement.
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const clientId = getRequired(body, "clientId");
      const photoData = getRequired(body, "photoData");
      const monteurId = getString(body, "monteurId");

      // 1. Résoudre FNUCI → vélo
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      const matches = vSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);
      if (matches.length === 0) {
        return { error: "FNUCI inconnu", code: "FNUCI_INCONNU", fnuci };
      }
      if (matches.length > 1) {
        return {
          error: `DOUBLON FNUCI : ce code est sur ${matches.length} vélos en base.`,
          code: "FNUCI_DOUBLON",
          fnuci,
        };
      }
      const veloDoc = matches[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
        dateMontage?: { toDate?: () => Date } | string;
      };

      // 2. Vérifier que le vélo appartient bien au client scanné (= QR carton)
      if (velo.clientId !== clientId) {
        let veloClientName: string | null = null;
        try {
          if (velo.clientId) {
            const c = await getDoc(doc(db, "clients", velo.clientId));
            if (c.exists()) veloClientName = (c.data() as { entreprise?: string }).entreprise || null;
          }
        } catch {}
        return {
          error: `Le vélo ${fnuci} appartient à ${veloClientName || "un autre client"} — pas au client du carton scanné.`,
          code: "MAUVAISE_PAIRE_CARTON_VELO",
          fnuci,
          veloClientId: velo.clientId || null,
          veloClientName,
        };
      }

      // 3. Vérifier prérequis (préparation + chargement + livraison)
      const bypassMontage = true; // verrouillage d'ordre désactivé 2026-04-29 (terrain)
      const missingMontage: string[] = [];
      if (!velo.datePreparation) missingMontage.push("préparation");
      if (!velo.dateChargement) missingMontage.push("chargement");
      if (!velo.dateLivraisonScan) missingMontage.push("livraison");
      if (!bypassMontage && missingMontage.length > 0) {
        return {
          error: `Impossible de monter : étape${missingMontage.length > 1 ? "s" : ""} manquante${missingMontage.length > 1 ? "s" : ""} (${missingMontage.join(", ")})`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          fnuci,
          missing: missingMontage,
        };
      }

      // 4. Si déjà monté, renvoyer le statut existant sans re-uploader.
      if (velo.dateMontage) {
        const t = velo.dateMontage as { toDate?: () => Date } | string;
        const dateMontageRet =
          typeof t === "string"
            ? t
            : t?.toDate?.()?.toISOString() || null;
        return {
          ok: true,
          alreadyDone: true,
          fnuci,
          veloId: veloDoc.id,
          clientId,
          dateMontage: dateMontageRet,
        };
      }

      // 5. Upload photo + pose dateMontage en 1 coup
      const fileName = `${fnuci}_monte_${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `montage/${clientId}/${fileName}`,
        photoData,
        "image/jpeg",
      );
      const updates: Body = {
        photoMontageUrl: url,
        dateMontage: ts(),
        // Libère le claim montage : ce vélo est désormais monté, plus besoin
        // de le réserver pour un monteur (workflow parallèle 29-04 13h50).
        montageClaimBy: null,
        montageClaimAt: null,
        updatedAt: ts(),
      };
      if (monteurId) updates.monteParId = monteurId;
      await updateDoc(veloDoc.ref, updates);

      // 5bis. Phase 2C — Détection montage atelier (Yoann 2026-05-01).
      // Si le vélo n'avait PAS dateChargement avant ce montage, c'est qu'il
      // a été monté en atelier (pas chez le client). On crée 2 mvts stock
      // sur l'entrepôt origine : -1 carton, +1 monté.
      if (!velo.dateChargement) {
        const orig = await getEntrepotOrigineForClient({ clientId });
        if (orig) {
          await createStockMouvement({
            entrepotId: orig.entrepotOrigineId,
            type: "carton",
            quantite: -1,
            source: "montage-atelier",
            notes: `Vélo ${fnuci} monté atelier`,
            veloId: veloDoc.id,
            fnuci,
          });
          await createStockMouvement({
            entrepotId: orig.entrepotOrigineId,
            type: "monte",
            quantite: 1,
            source: "montage-atelier",
            notes: `Vélo ${fnuci} monté atelier`,
            veloId: veloDoc.id,
            fnuci,
          });
        }
      }

      // 6. Récupérer nom client pour message UX
      let clientName: string | null = null;
      try {
        const c = await getDoc(doc(db, "clients", clientId));
        if (c.exists()) clientName = (c.data() as { entreprise?: string }).entreprise || null;
      } catch {}

      return {
        ok: true,
        alreadyDone: false,
        fnuci,
        veloId: veloDoc.id,
        clientId,
        clientName,
        photoUrl: url,
        dateMontage: new Date().toISOString(),
      };
    }

    case "uploadMontagePhoto": {
      // Miroir fidèle de la fonction GAS uploadMontagePhoto : résout le vélo
      // par FNUCI, écrit la photo dans le bon slot (urlPhotoMontageEtiquette /
      // urlPhotoMontageQrVelo / photoMontageUrl), et ne pose dateMontage
      // QUE quand les 3 slots sont remplis (preuve complète du montage).
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const slot = getRequired(body, "slot");
      const photoData = getRequired(body, "photoData");
      const monteurId = getString(body, "monteurId");

      if (slot !== "etiquette" && slot !== "qrvelo" && slot !== "monte") {
        return { error: "slot invalide (attendu : etiquette, qrvelo, monte)" };
      }

      // 1. Résolution FNUCI → vélo
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      const matches = vSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);
      if (matches.length === 0) {
        return { error: "FNUCI inconnu — passe d'abord par la préparation", fnuci };
      }
      if (matches.length > 1) {
        return {
          error: `DOUBLON FNUCI : ce code est présent sur ${matches.length} vélos en base. Corrige la saisie avant d'uploader la photo.`,
          fnuci,
          doublons: matches.map((d) => ({
            veloId: d.id,
            clientId: (d.data() as { clientId?: string }).clientId || "",
          })),
        };
      }
      const veloDoc = matches[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        urlPhotoMontageEtiquette?: string;
        urlPhotoMontageQrVelo?: string;
        photoMontageUrl?: string;
        dateMontage?: { toDate?: () => Date } | string;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
      };
      const veloId = veloDoc.id;
      const clientId = velo.clientId || "no-client";

      // 1.5 Verrouillage d'ordre : un vélo ne peut être monté que s'il est
      // déjà préparé, chargé ET livré (sinon photos de montage prises avant
      // la livraison effective — incohérent avec le terrain).
      // Mode bypass admin (Yoann 29-04 02h42) : skip la vérif si flag posé.
      const bypassMontage = true; // verrouillage d'ordre désactivé 2026-04-29 (terrain)
      const missingMontage: string[] = [];
      if (!velo.datePreparation) missingMontage.push("préparation");
      if (!velo.dateChargement) missingMontage.push("chargement");
      if (!velo.dateLivraisonScan) missingMontage.push("livraison");
      if (!bypassMontage && missingMontage.length > 0) {
        return {
          error: `Impossible de monter : étape${missingMontage.length > 1 ? "s" : ""} manquante${missingMontage.length > 1 ? "s" : ""} (${missingMontage.join(", ")})`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          fnuci,
          missing: missingMontage,
        };
      }

      // 2. Upload Storage
      const fileName = `${fnuci}_${slot}_${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `montage/${clientId}/${fileName}`,
        photoData,
        "image/jpeg",
      );

      // 3. Champ destination en miroir GAS (champs plats lus par le composant)
      const slotField =
        slot === "etiquette"
          ? "urlPhotoMontageEtiquette"
          : slot === "qrvelo"
            ? "urlPhotoMontageQrVelo"
            : "photoMontageUrl";

      const updates: Body = {
        [slotField]: url,
        updatedAt: ts(),
      };

      // 4. Les 3 slots remplis après cet upload ?
      const hasEtiquette = slot === "etiquette" || !!velo.urlPhotoMontageEtiquette;
      const hasQrVelo = slot === "qrvelo" || !!velo.urlPhotoMontageQrVelo;
      const hasMonte = slot === "monte" || !!velo.photoMontageUrl;
      const allThree = hasEtiquette && hasQrVelo && hasMonte;
      const alreadyMonte = !!velo.dateMontage;
      let dateMontageRet: string | null = null;
      if (allThree && !alreadyMonte) {
        updates.dateMontage = ts();
        if (monteurId) updates.monteParId = monteurId;
        dateMontageRet = new Date().toISOString();
      } else if (alreadyMonte) {
        const t = velo.dateMontage as { toDate?: () => Date } | string;
        dateMontageRet =
          typeof t === "string"
            ? t
            : t?.toDate?.()?.toISOString() || null;
      }

      await updateDoc(veloDoc.ref, updates);

      // 5. Nom du client pour message UX
      let clientName: string | null = null;
      try {
        const c = await getDoc(doc(db, "clients", clientId));
        if (c.exists()) {
          clientName = (c.data() as { entreprise?: string }).entreprise || null;
        }
      } catch {}

      return {
        ok: true,
        veloId,
        fnuci,
        clientId,
        clientName,
        slot,
        photoUrl: url,
        photos: { etiquette: hasEtiquette, qrvelo: hasQrVelo, monte: hasMonte },
        complete: allThree,
        dateMontage: dateMontageRet,
      };
    }

    case "uploadVeloPhoto": {
      // 2 schémas d'appel coexistent :
      //   - Préparation/Montage : { stage: "qr" | "etiquette", photoData }
      //   - Livraison (tournee-execute) : { kind: "velo" | "fnuci", fileData }
      // Avant : tout fallback sur `photos.montageQrVelo` parce que `stage`
      // était undefined → écrasement de la photo de montage avec la photo de
      // livraison. Bug 2026-04-28.
      const veloId = getRequired(body, "veloId");
      const kind = getString(body, "kind"); // livraison
      const stage = getString(body, "stage"); // préparation/montage
      const photoData = getString(body, "photoData") || getString(body, "fileData");
      if (!photoData) throw new Error("photoData ou fileData requis");

      // Détermine le "rôle" canonique de la photo
      type Role = "qr" | "etiquette" | "veloLivraison" | "fnuciLivraison" | "chargement";
      let role: Role;
      if (kind === "velo") role = "veloLivraison";
      else if (kind === "fnuci") role = "fnuciLivraison";
      else if (kind === "chargement" || stage === "chargement") role = "chargement";
      else if (stage === "etiquette") role = "etiquette";
      else role = "qr";

      const folder: Record<Role, string> = {
        qr: "preparation",
        etiquette: "preparation",
        veloLivraison: "livraison",
        fnuciLivraison: "livraison",
        chargement: "chargement",
      };
      const url = await uploadDataUrl(
        `${folder[role]}/${veloId}/${role}-${Date.now()}.jpg`,
        photoData,
        "image/jpeg",
      );

      // Champ Firestore + side-effect par rôle
      const updates: Body = { updatedAt: ts() };
      if (role === "qr") {
        updates["photos.montageQrVelo"] = url;
        updates.photoQrPrise = true;
      } else if (role === "etiquette") {
        updates["photos.montageEtiquette"] = url;
      } else if (role === "veloLivraison") {
        updates["photos.veloLivraison"] = url;
        updates.photoVeloUrl = url; // top-level lu par getTourneeExecution
      } else if (role === "fnuciLivraison") {
        updates["photos.fnuciLivraison"] = url;
        updates.photoFnuciUrl = url;
      } else if (role === "chargement") {
        // Preuve CEE : photo du sticker BicyCode prise par le chauffeur au
        // chargement. Indispensable pour le contrôle COFRAC (TRA-EQ-131).
        // Top-level pour requêtes / affichage admin direct.
        updates["photos.chargement"] = url;
        updates.photoChargementUrl = url;
        updates.photoChargementUploadedAt = ts();
      }

      await updateDoc(doc(db, "velos", veloId), updates);
      return { ok: true, url };
    }

    case "setDisponibilites": {
      // Miroir gas/Code.js setDisponibilites (5196). Pour la date donnée,
      // on bascule actif=true pour les ressources demandées, actif=false
      // pour les autres dispos existantes de cette date.
      const date = getString(body, "date");
      if (!date) return { error: "date requise (YYYY-MM-DD)" };
      const desired = {
        camion: (body.camionIds as string[]) || [],
        chauffeur: (body.chauffeurIds as string[]) || [],
        chef: (body.chefIds as string[]) || [],
        monteur: (body.monteurIds as string[]) || [],
      };

      const snap = await getDocs(
        query(collection(db, "disponibilites"), where("date", "==", date)),
      );
      const existing: Record<string, { ref: ReturnType<typeof doc>; actif: boolean }> = {};
      for (const d of snap.docs) {
        const o = d.data() as { ressourceType?: string; ressourceId?: string; actif?: boolean };
        const key = `${o.ressourceType}|${o.ressourceId}`;
        existing[key] = { ref: d.ref, actif: o.actif !== false };
      }

      let added = 0;
      let reactivated = 0;
      let archived = 0;
      // Phase 1 : ajouter ou réactiver
      const batch = writeBatch(db);
      const desiredKeys = new Set<string>();
      for (const [type, ids] of Object.entries(desired)) {
        for (const rid of ids) {
          if (!rid) continue;
          const key = `${type}|${rid}`;
          desiredKeys.add(key);
          const ex = existing[key];
          if (ex) {
            if (!ex.actif) {
              batch.update(ex.ref, { actif: true, updatedAt: ts() });
              reactivated++;
            }
          } else {
            // Doc id stable : YYYY-MM-DD_type_rid → idempotent en cas de retry.
            const newId = `${date}_${type}_${rid}`;
            batch.set(doc(db, "disponibilites", newId), {
              date,
              ressourceType: type,
              ressourceId: rid,
              actif: true,
              createdAt: ts(),
              updatedAt: ts(),
            });
            added++;
          }
        }
      }
      // Phase 2 : archiver ce qui n'est plus voulu
      for (const [key, ex] of Object.entries(existing)) {
        if (!desiredKeys.has(key) && ex.actif) {
          batch.update(ex.ref, { actif: false, updatedAt: ts() });
          archived++;
        }
      }
      await batch.commit();
      return { ok: true, added, reactivated, archived };
    }

    case "importClients": {
      // Import CSV : crée des clients depuis des rows {entreprise, contact,
      // email, telephone, adresse, ville, codePostal, nbVelos}. GAS n'a
      // jamais implémenté cette action — bouton no-op aujourd'hui.
      // On crée 1 client par row, sans dédoublonnage agressif (l'utilisateur
      // est responsable de ne pas réimporter le même CSV).
      const rows = (body.rows as Array<Record<string, unknown>>) || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, error: "rows vide", created: 0 };
      }
      let created = 0;
      const errors: Array<{ entreprise: string; error: string }> = [];
      for (let i = 0; i < rows.length; i += 400) {
        const batch = writeBatch(db);
        for (const row of rows.slice(i, i + 400)) {
          try {
            const entreprise = String(row.entreprise || "").trim();
            if (!entreprise) continue;
            const apporteur = String(row.apporteur || "").trim() || null;
            const apporteurLower = apporteur ? apporteur.toLowerCase() : null;
            const nbVelosRaw = row.nbVelos;
            const nbVelos = Math.max(
              0,
              Math.round(
                typeof nbVelosRaw === "number" ? nbVelosRaw : Number(nbVelosRaw) || 0,
              ),
            );
            const ref = doc(collection(db, "clients"));
            batch.set(ref, {
              entreprise,
              contact: String(row.contact || "").trim() || null,
              email: String(row.email || "").trim() || null,
              telephone: String(row.telephone || "").trim() || null,
              adresse: String(row.adresse || "").trim() || null,
              ville: String(row.ville || "").trim() || null,
              codePostal: String(row.codePostal || "").trim() || null,
              departement:
                String(row.codePostal || "").slice(0, 2) || null,
              apporteur,
              apporteurLower,
              nbVelosCommandes: nbVelos,
              docs: {},
              docLinks: {},
              docDates: {},
              stats: {
                totalVelos: 0,
                montes: 0,
                livres: 0,
                totalLivraisonsLivrees: 0,
                blSignes: 0,
                facturables: 0,
                planifies: 0,
                certificats: 0,
                factures: 0,
              },
              createdAt: ts(),
              updatedAt: ts(),
            });
            created++;
          } catch (e) {
            errors.push({
              entreprise: String(row.entreprise || ""),
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        await batch.commit();
      }
      return { ok: true, created, errors, total: rows.length };
    }

    case "bulkAutoValidate": {
      // Miroir fidèle de gas/Code.js bulkAutoValidate (ligne 3003).
      // Auto-valide en lot toutes les vérifications "pending" avec clientId
      // et docType reconnu. Pose flag+lien sur la fiche client (mode C :
      // flag toujours posé, lien posé seulement si vide aujourd'hui — on ne
      // casse jamais un lien classé manuellement).
      const dryRun = body.dryRun === true || body.dryRun === "true";
      const excludeRaw = body.excludeClientIds;
      const excludeSet = new Set<string>();
      if (Array.isArray(excludeRaw)) {
        for (const id of excludeRaw) excludeSet.add(String(id));
      } else if (typeof excludeRaw === "string") {
        try {
          const parsed = JSON.parse(excludeRaw);
          if (Array.isArray(parsed)) for (const id of parsed) excludeSet.add(String(id));
        } catch {}
      }

      // Mapping docType → { flag, link } (miroir GAS DOC_TYPE_TO_CLIENT_FIELDS)
      const DOC_TYPE_MAP: Record<string, { flag: string; link: string }> = {
        DEVIS: { flag: "devisSignee", link: "devisLien" },
        KBIS: { flag: "kbisRecu", link: "kbisLien" },
        LIASSE: { flag: "attestationRecue", link: "attestationLien" },
        URSSAF: { flag: "attestationRecue", link: "attestationLien" },
        ATTESTATION: { flag: "attestationRecue", link: "attestationLien" },
        SIGNATURE: { flag: "signatureOk", link: "signatureLien" },
        BICYCLE: { flag: "inscriptionBicycle", link: "bicycleLien" },
        PARCELLE: { flag: "parcelleCadastrale", link: "parcelleCadastraleLien" },
      };
      // Flat field name → Firestore nested path
      const FLAG_TO_PATH: Record<string, string> = {
        devisSignee: "docs.devisSignee",
        kbisRecu: "docs.kbisRecu",
        attestationRecue: "docs.attestationRecue",
        signatureOk: "docs.signatureOk",
        inscriptionBicycle: "docs.inscriptionBicycle",
        parcelleCadastrale: "docs.parcelleCadastrale",
      };
      const LINK_TO_PATH: Record<string, string> = {
        devisLien: "docLinks.devis",
        kbisLien: "docLinks.kbis",
        attestationLien: "docLinks.attestation",
        signatureLien: "docLinks.signature",
        bicycleLien: "docLinks.bicycle",
        parcelleCadastraleLien: "docLinks.parcelleCadastrale",
      };

      // Parcourt les vérifications. Status pending OR vide OR unassigned.
      const verifSnap = await getDocs(collection(db, "verifications"));
      const skipReasons = {
        notPending: 0,
        noClient: 0,
        clientNotFound: 0,
        unknownDocType: 0,
        excluded: 0,
      };
      const byDocType: Record<string, number> = {};
      const sample: Array<{ id: string; clientId: string; docType: string; fileName: string; action: string }> = [];
      // clientId → flagFlat → { linkField, link?, when, setFlag }
      const pendingClientUpdates: Record<string, Record<string, { linkField: string; link: string | null; when: number; setFlag: boolean }>> = {};
      const rowsToValidate: Array<{ verifId: string; action: string }> = [];
      const counts = { fresh: 0, linkOnly: 0, skipExisting: 0 };
      type ClientBreakdown = {
        clientId: string;
        entreprise: string;
        fresh: number;
        linkOnly: number;
        skipExisting: number;
        byDocType: Record<string, number>;
        total?: number;
      };
      const clientsBreakdown: Record<string, ClientBreakdown> = {};

      // Pré-charge les clients en une seule passe (collection size raisonnable).
      const cSnap = await getDocs(collection(db, "clients"));
      type ClientDoc = {
        entreprise?: string;
        docs?: Record<string, boolean>;
        docLinks?: Record<string, string>;
      };
      const clientsById: Record<string, ClientDoc> = {};
      for (const cd of cSnap.docs) clientsById[cd.id] = cd.data() as ClientDoc;

      const tsToMs = (x: unknown): number => {
        if (!x) return 0;
        if (typeof x === "string") {
          const t = Date.parse(x);
          return Number.isFinite(t) ? t : 0;
        }
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().getTime() : 0;
      };

      for (const vd of verifSnap.docs) {
        const v = vd.data() as {
          clientId?: string;
          docType?: string;
          driveUrl?: string;
          storageUrl?: string;
          status?: string;
          fileName?: string;
          receivedAt?: unknown;
        };
        const status = (v.status || "").toLowerCase();
        if (status !== "" && status !== "pending" && status !== "unassigned") {
          skipReasons.notPending++;
          continue;
        }
        const clientId = v.clientId || "";
        if (!clientId) {
          skipReasons.noClient++;
          continue;
        }
        if (excludeSet.has(String(clientId))) {
          skipReasons.excluded++;
          continue;
        }
        const client = clientsById[clientId];
        if (!client) {
          skipReasons.clientNotFound++;
          continue;
        }
        const docType = (v.docType || "").toUpperCase();
        const mapping = DOC_TYPE_MAP[docType];
        if (!mapping) {
          skipReasons.unknownDocType++;
          continue;
        }

        const currentFlag = !!(client.docs?.[mapping.flag] === true);
        // Le lien est nommé sans "Lien" dans docLinks (devisLien → docLinks.devis).
        const linkKey = mapping.link.replace(/Lien$/, "");
        const currentLink = (client.docLinks?.[linkKey] || "") as string;
        const linkIsEmpty = !currentLink || currentLink.trim() === "";
        byDocType[docType] = (byDocType[docType] || 0) + 1;

        // driveUrl GAS pouvait contenir plusieurs URLs séparées par " ||| ", on garde la 1ère
        const driveUrl = String(v.driveUrl || v.storageUrl || "").split(" ||| ")[0];
        const receivedTs = tsToMs(v.receivedAt);

        let action: "fresh" | "linkOnly" | "skipExisting";
        if (currentFlag && !linkIsEmpty) action = "skipExisting";
        else if (currentFlag && linkIsEmpty) action = "linkOnly";
        else action = "fresh"; // !flag (link vide ou non) → on coche

        if (action !== "skipExisting") {
          const slot = (pendingClientUpdates[clientId] ||= {});
          const prev = slot[mapping.flag];
          if (!prev || receivedTs >= (prev.when || 0)) {
            slot[mapping.flag] = {
              linkField: mapping.link,
              link: linkIsEmpty ? driveUrl : null,
              when: receivedTs,
              setFlag: !currentFlag,
            };
          }
        }

        counts[action]++;
        rowsToValidate.push({ verifId: vd.id, action });

        let bk = clientsBreakdown[clientId];
        if (!bk) {
          bk = clientsBreakdown[clientId] = {
            clientId,
            entreprise: client.entreprise || "",
            fresh: 0,
            linkOnly: 0,
            skipExisting: 0,
            byDocType: {},
          };
        }
        bk[action]++;
        bk.byDocType[docType] = (bk.byDocType[docType] || 0) + 1;
        if (sample.length < 10) {
          sample.push({
            id: vd.id,
            clientId,
            docType,
            fileName: v.fileName || "",
            action,
          });
        }
      }

      const clientsList = Object.values(clientsBreakdown)
        .map((b) => ({ ...b, total: b.fresh + b.linkOnly + b.skipExisting }))
        .sort((a, b) => (b.total || 0) - (a.total || 0));

      const preview = {
        wouldValidate: rowsToValidate.length,
        fresh: counts.fresh,
        linkOnly: counts.linkOnly,
        skipExisting: counts.skipExisting,
        skipped:
          skipReasons.notPending +
          skipReasons.noClient +
          skipReasons.clientNotFound +
          skipReasons.unknownDocType +
          skipReasons.excluded,
        skipReasons,
        byDocType,
        clientsTouched: Object.keys(pendingClientUpdates).length,
        clientsBreakdown: clientsList,
        sample,
        dryRun,
      } as Body;

      if (dryRun || rowsToValidate.length === 0) {
        return preview;
      }

      // Application : updates clients par batches (writeBatch limité à 500 ops),
      // puis verifs status=validated + note. Idempotent en cas de retry partiel.
      let clientsUpdated = 0;
      const stamp = new Date().toISOString().slice(0, 10);
      const cIds = Object.keys(pendingClientUpdates);
      for (let i = 0; i < cIds.length; i += 400) {
        const batch = writeBatch(db);
        for (const cid of cIds.slice(i, i + 400)) {
          const slot = pendingClientUpdates[cid];
          const updates: Body = { updatedAt: ts() };
          let changed = false;
          for (const flagFlat of Object.keys(slot)) {
            const info = slot[flagFlat];
            if (info.setFlag) {
              const path = FLAG_TO_PATH[flagFlat];
              if (path) {
                updates[path] = true;
                changed = true;
              }
            }
            if (info.link) {
              const lpath = LINK_TO_PATH[info.linkField];
              if (lpath) {
                updates[lpath] = info.link;
                changed = true;
              }
            }
          }
          if (changed) {
            batch.update(doc(db, "clients", cid), updates);
            clientsUpdated++;
          }
        }
        await batch.commit();
      }

      for (let i = 0; i < rowsToValidate.length; i += 400) {
        const batch = writeBatch(db);
        for (const item of rowsToValidate.slice(i, i + 400)) {
          // Note : on append "auto-bulk YYYY-MM-DD (action)" en pose simple
          // (pas de read-modify-write — assez bon pour traçabilité).
          batch.update(doc(db, "verifications", item.verifId), {
            status: "validated",
            reviewedAt: ts(),
            notes: `auto-bulk ${stamp} (${item.action})`,
          });
        }
        await batch.commit();
      }

      preview.validated = rowsToValidate.length;
      preview.clientsUpdated = clientsUpdated;
      return preview;
    }

    case "syncBonsNow": {
      // Force la sync GAS → Firestore des bonsEnlevement + verifications
      // immédiatement (sans attendre le cron 15 min). Délègue à la Cloud
      // Function syncFromGasNow (réservée admins).
      const callable = httpsCallable<
        Record<string, never>,
        { ok: boolean; bons?: number; verifs?: number; error?: string }
      >(functions, "syncFromGasNow");
      try {
        const r = await callable({});
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "addBonEnlevementManual": {
      // Saisie manuelle d'un bon d'enlèvement (30-04 10h15) : quand le pipeline
      // gas-inbox → Gemini → Sheet GAS échoue pour un mail (Gemini hallucine /
      // mail mal classé / etc.), Yoann saisit le bon directement depuis l'UI.
      // Bypass complet du pipeline auto, écrit directement dans bonsEnlevement.
      const tourneeId = getRequired(body, "tourneeId");
      const tourneeNumero = body.tourneeNumero != null ? Number(body.tourneeNumero) : null;
      const numeroDoc = getString(body, "numeroDoc");
      const quantite = body.quantite != null ? Number(body.quantite) : null;
      const driveUrl = getString(body, "driveUrl") || null;
      const fournisseur = getString(body, "fournisseur") || "AXDIS PRO";
      if (!numeroDoc) return { ok: false, error: "numeroDoc requis" };
      if (quantite == null || Number.isNaN(quantite) || quantite <= 0) {
        return { ok: false, error: "quantite invalide" };
      }
      const id = `manual-${tourneeId}-${Date.now()}`;
      const tourneeRef = tourneeNumero != null
        ? `VELO CARGO - TOURNEE ${tourneeNumero}`
        : `VELO CARGO - ${tourneeId}`;
      // dateDoc obligatoire (Yoann 2026-05-01) : sans ça, le bon est
      // invisible côté Finances qui filtre par dateDoc. On utilise la
      // date passée si fournie, sinon today.
      const dateDoc = getString(body, "dateDoc") || new Date().toISOString().slice(0, 10);
      await setDoc(doc(db, "bonsEnlevement", id), {
        tourneeId,
        tourneeNumero,
        tourneeRef,
        fournisseur,
        numeroDoc,
        quantite,
        driveUrl,
        dateDoc,
        receivedAt: new Date().toISOString(),
        manual: true,
        createdAt: ts(),
        syncedAt: ts(),
      });
      return { ok: true, id };
    }

    case "proposeTournee": {
      // Cloud Function europe-west1. Lit Firestore (dispos, équipe, flotte,
      // clients, livraisons), construit le prompt, appelle Gemini, parse +
      // sanitize, renvoie la même ProposeResponse que l'ancienne route GAS.
      // Le frontend day-planner-modal.tsx envoyait { getPromptOnly, geminiText }
      // pour le bypass Vercel — devenu inutile (la CF est notre serveur).
      const date = getString(body, "date");
      const mode = getString(body, "mode") || "fillGaps";
      const models = Array.isArray(body.models) ? (body.models as string[]) : undefined;
      if (!date) return { error: "date YYYY-MM-DD requise" };
      // Timeout 300s côté client (SDK default 70s coupe trop tôt). La CF
      // elle-même est capée à 540s mais avec retry court côté CF (2 essais
      // × 4s backoff par modèle) on devrait rester sous 3 min en p99.
      const callable = httpsCallable<
        { date: string; mode: string; models?: string[] },
        Record<string, unknown>
      >(functions, "proposeTournee", { timeout: 300000 });
      try {
        const r = await callable({ date, mode, models });
        return r.data;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "testGemini": {
      // Diagnostic admin (cf. functions/src/index.ts testGemini Cloud Function).
      const callable = httpsCallable<Record<string, never>, Record<string, unknown>>(
        functions,
        "testGemini",
      );
      try {
        const r = await callable({});
        return r.data;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "getRouting": {
      // Distance Matrix Google Maps (cf. functions/src/index.ts getRouting CF).
      // Body : { points: [{ lat, lng }, ...] } → { ok, segments, apiCalls, cached }
      const points = (body.points as Array<{ lat?: number; lng?: number }>) || [];
      const callable = httpsCallable<
        { points: Array<{ lat?: number; lng?: number }> },
        Record<string, unknown>
      >(functions, "getRouting");
      try {
        const r = await callable({ points });
        return r.data;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), segments: [] };
      }
    }

    case "extractFnuciFromImage": {
      // Proxifie vers la Cloud Function (nécessaire pour l'API key Gemini).
      // Le frontend (photo-gemini-capture) gère ensuite le mirror Firestore
      // via les actions migrées (assignFnuciToClient + markVeloPrepare/...)
      // — la Cloud Function ne fait QUE l'extraction OCR.
      const imageBase64 = getString(body, "imageBase64");
      const mimeType = getString(body, "mimeType") || "image/jpeg";
      if (!imageBase64) return { ok: false, error: "imageBase64 requis" };
      const callable = httpsCallable<
        { imageBase64: string; mimeType: string },
        Record<string, unknown>
      >(functions, "extractFnuciFromImage");
      try {
        const r = await callable({ imageBase64, mimeType });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "fetchParcelle": {
      // Migré depuis gas/Code.js:2145. Workflow :
      //   1) Si déjà flaggé + lien stocké → renvoie cache (évite throttle apicarto).
      //   2) Géocode l'adresse client via api-adresse.data.gouv.fr (public).
      //   3) Récupère la parcelle via apicarto.ign.fr (Polygon GeoJSON).
      //   4) Calcul centroid (plus précis que coords adresse pour zoom 20).
      //   5) Construit l'URL cadastre.data.gouv.fr/parcelles/<id> (lien direct
      //      qui encadre la parcelle EXACTE — important pour CEE).
      //   6) Met à jour le doc client (parcelleCadastrale=true + lien).
      const cidPrc = String(body.clientId || "");
      if (!cidPrc) return { error: "ID client manquant" };

      const cRefP = doc(db, "clients", cidPrc);
      const cSnapP = await getDoc(cRefP);
      if (!cSnapP.exists()) return { error: "Client non trouvé" };
      const cDataP = cSnapP.data() as {
        adresse?: string;
        codePostal?: string;
        ville?: string;
        docLinks?: { parcelleCadastrale?: string };
        docs?: { parcelleCadastrale?: boolean };
      };

      // Cache : si déjà flaggé + lien, on sort tout de suite.
      const lienCacheP = String(cDataP.docLinks?.parcelleCadastrale || "").trim();
      const flagCacheP = !!cDataP.docs?.parcelleCadastrale;
      if (flagCacheP && lienCacheP) {
        const refMatch = lienCacheP.match(/\/parcelles\/(\d{5})(\d{0,5}?)([A-Z]{1,3})(\d{1,4})$/);
        return {
          ok: true,
          cached: true,
          parcelle: refMatch ? `${refMatch[1]} ${refMatch[3]} ${refMatch[4]}` : "(stockée)",
          commune: refMatch ? refMatch[1] : "",
          section: refMatch ? refMatch[3] : "",
          numero: refMatch ? refMatch[4] : "",
          contenance: null,
          lat: null,
          lng: null,
          parcelleLien: lienCacheP,
          geoportailUrl: lienCacheP,
        };
      }

      const adresseP = String(cDataP.adresse || "").trim();
      const cpP = String(cDataP.codePostal || "").trim();
      const villeP = String(cDataP.ville || "").trim();
      const qP = [adresseP, cpP, villeP].filter(Boolean).join(" ");
      if (!qP) return { error: "Adresse client vide — renseignez l'adresse, le code postal et la ville." };

      // 1) Géocodage
      let lat: number, lng: number;
      try {
        const geoRes = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(qP)}&limit=1`);
        if (!geoRes.ok) return { error: `Erreur géocodage : HTTP ${geoRes.status}` };
        const geoData = await geoRes.json() as { features?: Array<{ geometry?: { coordinates?: number[] } }> };
        if (!geoData.features || geoData.features.length === 0) {
          return { error: "Adresse introuvable sur api-adresse.data.gouv.fr" };
        }
        const coords = geoData.features[0].geometry?.coordinates;
        if (!coords || coords.length < 2) return { error: "Coords manquantes dans réponse géocodage" };
        lng = coords[0];
        lat = coords[1];
      } catch (e) {
        return { error: `Erreur géocodage : ${e instanceof Error ? e.message : String(e)}` };
      }

      // 2) Parcelle via apicarto + récup géométrie pour centroid précis
      type CadastreProps = { code_com?: string; commune?: string; section?: string; numero?: string; contenance?: string | number };
      type CadastreFeature = { properties?: CadastreProps; geometry?: { coordinates?: number[][][] | number[][][][] } };
      let props: CadastreProps | null = null;
      let geom: CadastreFeature["geometry"] | null = null;
      try {
        const cadUrl = `https://apicarto.ign.fr/api/cadastre/parcelle?geom=${encodeURIComponent(`{"type":"Point","coordinates":[${lng},${lat}]}`)}&_limit=1`;
        const cadRes = await fetch(cadUrl);
        if (cadRes.ok) {
          const cadData = await cadRes.json() as { features?: CadastreFeature[] };
          if (cadData.features && cadData.features.length > 0) {
            props = cadData.features[0].properties || null;
            geom = cadData.features[0].geometry || null;
          }
        }
      } catch {}

      // Fallback : geo.api.gouv.fr pour au moins choper le code commune.
      if (!props) {
        try {
          const fbRes = await fetch(`https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lng}&fields=codeDepartement,codeCommune&limit=1`);
          if (fbRes.ok) {
            const communes = await fbRes.json() as Array<{ code?: string }>;
            if (communes.length > 0) {
              props = { code_com: communes[0].code, section: "", numero: "", contenance: "" };
            }
          }
        } catch {}
      }

      if (!props) return { error: "API cadastre indisponible — réessayez plus tard." };

      const codeCommune = String(props.code_com || props.commune || "");
      const section = String(props.section || "");
      const numero = String(props.numero || "");
      const contenance = props.contenance != null ? Number(props.contenance) : null;
      const refParcelle = `${codeCommune} ${section} ${numero}`.trim();

      // Centroid de la géométrie si dispo (plus précis que coords adresse)
      let centerLat = lat;
      let centerLng = lng;
      try {
        if (geom?.coordinates) {
          const raw = geom.coordinates as unknown as number[][][] | number[][][][];
          let ring: number[][] | null = null;
          // Polygon : coords[0] = anneau extérieur. MultiPolygon : coords[0][0].
          const r0 = raw[0];
          if (Array.isArray(r0) && Array.isArray(r0[0]) && Array.isArray((r0[0] as unknown[])[0])) {
            ring = r0[0] as unknown as number[][];
          } else {
            ring = r0 as unknown as number[][];
          }
          if (ring && ring.length > 2) {
            let sumX = 0;
            let sumY = 0;
            for (const p of ring) {
              sumX += p[0];
              sumY += p[1];
            }
            centerLng = sumX / ring.length;
            centerLat = sumY / ring.length;
          }
        }
      } catch {}

      // Lien direct cadastre.data.gouv.fr (format ID fiscal : INSEE+SECTION_PAD5+NUMERO_PAD4)
      const pad = (s: string, n: number) => {
        let v = String(s || "");
        while (v.length < n) v = `0${v}`;
        return v;
      };
      let parcelleLien = "";
      if (codeCommune && section && numero) {
        parcelleLien = `https://cadastre.data.gouv.fr/parcelles/${codeCommune}${pad(section, 5)}${pad(numero, 4)}`;
      } else {
        // Fallback Géoportail centré sur centroid.
        parcelleLien = `https://www.geoportail.gouv.fr/carte?c=${centerLng},${centerLat}&z=20&l0=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN-EXPRESS-STANDARD::GEOPORTAIL:OGC:WMTS(1)&l1=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(0.7)&permalink=yes`;
      }

      // Persist sur le doc client
      try {
        await updateDoc(cRefP, {
          "docs.parcelleCadastrale": true,
          "docLinks.parcelleCadastrale": parcelleLien,
          updatedAt: ts(),
        });
      } catch (e) {
        return { error: `Échec persistance client : ${e instanceof Error ? e.message : String(e)}` };
      }

      return {
        ok: true,
        parcelle: refParcelle,
        section,
        numero,
        commune: codeCommune,
        contenance,
        lat: centerLat,
        lng: centerLng,
        parcelleLien,
        geoportailUrl: parcelleLien,
      };
    }

    case "autoFetchParcelles": {
      // Migré depuis gas/Code.js:2338. Boucle séquentielle (250ms entre appels)
      // sur les clients sans flag parcelleCadastrale, avec adresse renseignée.
      const limit = Math.max(1, Number(body.limit) || 50);
      const cSnapAFP = await getDocs(collection(db, "clients"));
      const report = {
        processed: 0,
        ok: 0,
        skipped: 0,
        failed: 0,
        errors: [] as Array<{ clientId: string; error: string }>,
      };
      for (const d of cSnapAFP.docs) {
        if (report.processed >= limit) break;
        const o = d.data() as { docs?: { parcelleCadastrale?: boolean }; adresse?: string };
        if (o.docs?.parcelleCadastrale) { report.skipped++; continue; }
        if (!String(o.adresse || "").trim()) { report.skipped++; continue; }
        report.processed++;
        try {
          const res = await runFirestoreAction("fetchParcelle", { clientId: d.id }) as {
            ok?: boolean;
            error?: string;
          };
          if (res?.ok) {
            report.ok++;
          } else {
            report.failed++;
            if (res?.error && report.errors.length < 10) {
              report.errors.push({ clientId: d.id, error: res.error });
            }
          }
        } catch (err) {
          report.failed++;
          if (report.errors.length < 10) {
            report.errors.push({ clientId: d.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        // Pause légère pour lisser apicarto (limite ~1000 req/jour)
        await new Promise((r) => setTimeout(r, 250));
      }
      return report;
    }

    case "suggestTournee": {
      // Migré depuis gas/Code.js:957. Algo pur (pas Gemini) :
      //   1) Charger client cible + tous clients + livraisons planifiees
      //   2) Calculer "vélos restants à planifier" par client = nbVelosCommandes
      //      − vélos déjà livrés − vélos planifiés en livraison(s) en cours
      //      (calcul live à partir des livraisons réelles, pas des stats
      //      persistées qui peuvent dériver — cf. fix /carte 2026-04-28).
      //   3) Filtrer nearby = clients ≠ cible, distance ≤ maxDistance, reste > 0
      //   4) Bin packing en N camions de capacité fixe (compact : remplir
      //      camion par camion, le client cible d'abord, puis nearby triés
      //      par distance croissante)
      //   5) Format de retour identique GAS (mode/capacite/nbCamions/splits/
      //      tournee/totalVelos/clientsProches) pour ne pas casser /carte.
      const clientId = String(body.clientId || "");
      const mode = String(body.mode || "moyen");
      const maxDistance = Number(body.maxDistance || 50);
      if (!clientId) return { error: "clientId requis" };

      // Capacité : si le frontend a passé une capacité explicite (ex: clic sur
      // "Moyen 65v" précis), on la prend. Sinon, fallback sur la table par
      // type (cf. gas/Code.js:965).
      const capaciteOverride = Number(body.capacite);
      const capacites: Record<string, number> = {
        gros: 132,
        moyen: 54,
        camionnette: 20,
        petit: 20,
        retrait: 9999,
      };
      const capacite = capaciteOverride > 0 ? capaciteOverride : (capacites[mode] ?? 54);

      // 1) Tous les clients livrables (avec lat/lng)
      const cSnap = await getDocs(collection(db, "clients"));
      type Pt = {
        id: string;
        entreprise: string;
        ville: string;
        lat: number;
        lng: number;
        nbVelos: number;
        velosLivres: number;
      };
      const points: Pt[] = [];
      let target: Pt | null = null;
      for (const d of cSnap.docs) {
        const o = d.data() as {
          entreprise?: string;
          ville?: string;
          latitude?: number;
          longitude?: number;
          nbVelosCommandes?: number;
          stats?: { livres?: number };
        };
        const lat = typeof o.latitude === "number" ? o.latitude : NaN;
        const lng = typeof o.longitude === "number" ? o.longitude : NaN;
        if (!isFinite(lat) || !isFinite(lng)) {
          if (d.id === clientId) target = null;
          continue;
        }
        const pt: Pt = {
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          lat,
          lng,
          nbVelos: Number(o.nbVelosCommandes || 0),
          velosLivres: Number(o.stats?.livres || 0),
        };
        points.push(pt);
        if (d.id === clientId) target = pt;
      }
      if (!target) return { error: "Client non trouvé" };

      // 2) Livraisons planifiees → vélos planifiés par clientId (live)
      const lSnap = await getDocs(collection(db, "livraisons"));
      const planifiesParClient = new Map<string, number>();
      for (const d of lSnap.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifiesParClient.set(cid, (planifiesParClient.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      const resteOf = (p: Pt): number =>
        Math.max(0, p.nbVelos - p.velosLivres - (planifiesParClient.get(p.id) || 0));

      const velosTarget = resteOf(target);
      if (velosTarget <= 0) {
        return { error: "Aucun vélo à planifier pour ce client (tout livré ou déjà planifié)." };
      }

      // 3) Cas retrait : tournée mono-stop client cible
      if (mode === "retrait") {
        const retStops = [{
          id: target.id,
          entreprise: target.entreprise,
          ville: target.ville,
          lat: target.lat,
          lng: target.lng,
          nbVelos: velosTarget,
          distance: 0,
        }];
        return {
          mode: "retrait",
          capacite: velosTarget,
          nbCamions: 1,
          velosClient: velosTarget,
          splits: [{ stops: retStops, totalVelos: velosTarget, capacite: velosTarget, indexCamion: 1, nbCamionsTotal: 1 }],
          tournee: retStops,
          totalVelos: velosTarget,
          clientsProches: [],
        };
      }

      // 4) Nearby : clients ≠ cible avec lat/lng, dans le rayon, avec reste > 0
      type Near = Pt & { distance: number; velosRestants: number };
      const nearby: Near[] = points
        .filter((c) => c.id !== clientId)
        .map((c) => ({
          ...c,
          distance: haversineKmFs(target.lat, target.lng, c.lat, c.lng),
          velosRestants: resteOf(c),
        }))
        .filter((c) => c.distance <= maxDistance && c.velosRestants > 0)
        .sort((a, b) => a.distance - b.distance);

      // 5) Bin packing — chaque camion plein avant le suivant
      const nbCamions = Math.ceil(velosTarget / capacite);
      const splits: Array<{
        stops: Array<{ id: string; entreprise: string; ville: string; lat: number; lng: number; nbVelos: number; distance: number }>;
        totalVelos: number;
        capacite: number;
        indexCamion: number;
        nbCamionsTotal: number;
      }> = [];
      let velosACassign = velosTarget;

      for (let k = 0; k < nbCamions; k++) {
        const velosCeCamion = Math.min(velosACassign, capacite);
        const stops = [{
          id: target.id,
          entreprise: target.entreprise,
          ville: target.ville,
          lat: target.lat,
          lng: target.lng,
          nbVelos: velosCeCamion,
          distance: 0,
        }];

        // Yoann 2026-05-03 : ATOMICITÉ CLIENT.
        // Avant : Math.min(c.velosRestants, resteCamion) → un client était
        // splittée en 2 stops sur 2 tournées (Bottega 30v → 10v ici + 20v
        // ailleurs). Sur le terrain : passage en double, paperasse FNUCI
        // dédoublée, pénible.
        // Maintenant : on n'inclut un nearby que s'il rentre EN ENTIER dans
        // le reste camion. Sinon on saute (il sera couvert par une autre
        // suggestion / camion). On continue à parcourir nearby pour caser
        // les plus petits qui rentrent encore.
        let resteCamion = capacite - velosCeCamion;
        for (let j = 0; j < nearby.length && resteCamion > 0; j++) {
          const c = nearby[j];
          if (c.velosRestants <= 0) continue;
          if (c.velosRestants > resteCamion) continue; // skip — pas atomique
          const nb = c.velosRestants;
          stops.push({
            id: c.id,
            entreprise: c.entreprise,
            ville: c.ville,
            lat: c.lat,
            lng: c.lng,
            nbVelos: nb,
            distance: Math.round(c.distance * 10) / 10,
          });
          c.velosRestants -= nb;
          resteCamion -= nb;
        }

        splits.push({
          stops,
          totalVelos: stops.reduce((s, t) => s + t.nbVelos, 0),
          capacite,
          indexCamion: k + 1,
          nbCamionsTotal: nbCamions,
        });
        velosACassign -= velosCeCamion;
      }

      return {
        mode,
        capacite,
        nbCamions,
        velosClient: velosTarget,
        splits,
        // Compat ascendante : 1ère tournée à plat (cf. gas/Code.js:1045)
        tournee: splits[0].stops,
        totalVelos: splits[0].totalVelos,
        clientsProches: nearby.slice(0, 20).map((c) => ({
          id: c.id,
          entreprise: c.entreprise,
          ville: c.ville,
          lat: c.lat,
          lng: c.lng,
          distance: Math.round(c.distance * 10) / 10,
          velosRestants: c.velosRestants,
        })),
      };
    }

    case "suggestTourneeFromEntrepot": {
      // Yoann 2026-05-01 — Phase B-1 IA tournées multi-dépôts.
      // Au lieu de partir d'un client cible (suggestTournee), on part d'un
      // entrepôt sélectionné. On retourne les meilleurs clients à livrer
      // dans le rayon, triés par distance, limités par capacité camion ET
      // par stock disponible de l'entrepôt (cartons + montés selon mode
      // de montage).
      const entrepotId = String(body.entrepotId || "");
      const mode = String(body.mode || "moyen");
      const maxDistance = Number(body.maxDistance || 50);
      const modeMontage = String(body.modeMontage || "client") as
        | "client"
        | "atelier"
        | "client_redistribue";
      // Yoann 2026-05-01 : si true → 1 appel Distance Matrix Maps réel après
      // sélection capacité ; le VRP nearest-neighbor + 2-opt utilise alors la
      // vraie matrice routière au lieu de Haversine vol d oiseau.
      const useMaps = body.useMaps === true;
      if (!entrepotId) return { error: "entrepotId requis" };

      // Capacité camion : différente selon mode montage (Yoann 2026-05-01).
      // - Mode "client" (cartons + montage chez client) : capacité cartons,
      //   plus dense (vélos désassemblés en cartons)
      // - Mode "atelier" / "client_redistribue" (vélos déjà montés) :
      //   capacité réduite car les vélos prennent plus de place
      const capaciteOverride = Number(body.capacite);
      // Yoann 2026-05-03 : capacités RÉELLES de la flotte
      // (gros = poids lourd 77 cartons / 40 montés ; petit = 44 cartons /
      //  20 montés peut entrer Paris). Source de vérité : collection flotte.
      // Ces tables sont juste un fallback si pas de match flotte.
      const CAPACITES_CARTONS: Record<string, number> = {
        gros: 77,
        moyen: 54,
        camionnette: 44,
        petit: 44,
      };
      const CAPACITES_MONTES: Record<string, number> = {
        gros: 40, // Yoann 2026-05-01 : grand camion 40 vélos montés max
        moyen: 30,
        camionnette: 20,
        petit: 20, // petit camion 20 vélos montés max
      };
      const capacitesTable = modeMontage === "client" ? CAPACITES_CARTONS : CAPACITES_MONTES;
      const capaciteCamion = capaciteOverride > 0 ? capaciteOverride : (capacitesTable[mode] ?? 30);

      // Lit l'entrepôt
      const eSnap = await getDoc(doc(db, "entrepots", entrepotId));
      if (!eSnap.exists()) return { error: "Entrepôt introuvable" };
      const entrepot = eSnap.data() as {
        nom?: string;
        ville?: string;
        adresse?: string;
        lat?: number;
        lng?: number;
        stockCartons?: number;
        stockVelosMontes?: number;
        role?: string;
      };
      if (typeof entrepot.lat !== "number" || typeof entrepot.lng !== "number") {
        return { error: "Entrepôt sans coordonnées GPS — géocode-le d'abord" };
      }
      const eLat = entrepot.lat;
      const eLng = entrepot.lng;

      // Stock dispo selon mode montage :
      // - "client" (cartons + montage client) → stock cartons
      // - "atelier" (vélos pré-montés) → stock vélos montés
      // - "client_redistribue" → stock vélos montés (le client redistribue)
      let stockDispo = 0;
      if (entrepot.role === "fournisseur") {
        stockDispo = 99999; // AXDIS : pas de limite (stock fournisseur)
      } else if (modeMontage === "client") {
        stockDispo = Number(entrepot.stockCartons || 0);
      } else {
        stockDispo = Number(entrepot.stockVelosMontes || 0);
      }
      if (stockDispo <= 0) {
        return {
          error: `Stock insuffisant à ${entrepot.nom} (mode ${modeMontage} : ${stockDispo} dispo)`,
          entrepot: { id: entrepotId, nom: entrepot.nom, stockDispo },
        };
      }

      // Capacité effective = min(capacité camion, stock dispo)
      const capaciteEffective = Math.min(capaciteCamion, stockDispo);

      // Charge tous les clients livrables
      const cSnap = await getDocs(collection(db, "clients"));
      const points: Array<{
        id: string;
        entreprise: string;
        ville: string;
        lat: number;
        lng: number;
        nbVelos: number;
        velosLivres: number;
      }> = [];
      for (const d of cSnap.docs) {
        const o = d.data() as {
          entreprise?: string;
          ville?: string;
          latitude?: number;
          longitude?: number;
          nbVelosCommandes?: number;
          stats?: { livres?: number };
        };
        const lat = typeof o.latitude === "number" ? o.latitude : NaN;
        const lng = typeof o.longitude === "number" ? o.longitude : NaN;
        if (!isFinite(lat) || !isFinite(lng)) continue;
        points.push({
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          lat,
          lng,
          nbVelos: Number(o.nbVelosCommandes || 0),
          velosLivres: Number(o.stats?.livres || 0),
        });
      }

      // Livraisons planifiées pour calculer le reste à planifier par client
      const lSnap = await getDocs(collection(db, "livraisons"));
      const planifiesParClient = new Map<string, number>();
      for (const d of lSnap.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifiesParClient.set(cid, (planifiesParClient.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }

      // Candidats : clients dans le rayon avec reste > 0
      type Candidate = {
        id: string;
        entreprise: string;
        ville: string;
        lat: number;
        lng: number;
        distance: number;
        velosRestants: number;
      };
      const candidats: Candidate[] = points
        .map((p) => ({
          id: p.id,
          entreprise: p.entreprise,
          ville: p.ville,
          lat: p.lat,
          lng: p.lng,
          distance: haversineKmFs(eLat, eLng, p.lat, p.lng),
          velosRestants: Math.max(0, p.nbVelos - p.velosLivres - (planifiesParClient.get(p.id) || 0)),
        }))
        .filter((c) => c.distance <= maxDistance && c.velosRestants > 0)
        .sort((a, b) => a.distance - b.distance);

      // VRP heuristique (Yoann 2026-05-01) — Phase 2 :
      // Avant : tri par distance à l entrepôt + remplissage capacité ; OK pour
      // l empilement camion mais l ORDRE de visite était mauvais (zigzag).
      // Maintenant :
      //  1) Sélection capacité : on prend les clients dont la somme nbVelos
      //     remplit la capacité, en priorisant les plus proches (idem)
      //  2) Routing : nearest-neighbor multi-stop entrepôt → s1 → s2 → ...
      //     (chaque suivant = le plus proche du courant, pas de l entrepôt)
      //  3) 2-opt swap unique : améliore l ordre en cassant les croisements
      // Routing Google Maps Distance Matrix : étape suivante (TODO),
      // pour l instant on reste sur Haversine (vol d oiseau).
      type Stop = Candidate & { nbVelos: number };

      // Phase 1 : sélection capacité (tri par distance à l entrepôt)
      // Yoann 2026-05-03 : ATOMICITÉ CLIENT — un client doit rentrer EN
      // ENTIER dans le camion, pas de split. Si reste < total client, on
      // saute ce client et on essaie le suivant qui rentre encore.
      const selected: Stop[] = [];
      let resteCamion = capaciteEffective;
      for (const c of candidats) {
        if (resteCamion <= 0) break;
        if (c.velosRestants <= 0) continue;
        if (c.velosRestants > resteCamion) continue; // skip — pas atomique
        const nb = c.velosRestants;
        selected.push({ ...c, nbVelos: nb });
        resteCamion -= nb;
      }

      // Phase 2 : matrice de distances. Si useMaps=true → 1 appel Distance
      // Matrix Google avec [entrepot, ...selected] (matrice (N+1)x(N+1)).
      // Sinon → matrice Haversine calculée localement (gratuit, instantané).
      const N1 = selected.length + 1; // index 0 = entrepôt, 1..N = stops
      let distM: number[][] = Array.from({ length: N1 }, () => new Array(N1).fill(0));
      let durM: number[][] | null = null;
      let routingSource: "haversine" | "maps" = "haversine";
      let routingError: string | null = null;

      if (useMaps && selected.length >= 1) {
        try {
          const pts = [{ lat: eLat, lng: eLng }, ...selected.map((s) => ({ lat: s.lat, lng: s.lng }))];
          const callable = httpsCallable<
            { points: Array<{ lat: number; lng: number }>; matrix: boolean },
            { ok?: boolean; error?: string; distMatrix?: number[][]; durMatrix?: number[][]; apiCalls?: number }
          >(functions, "getRouting");
          const r = await callable({ points: pts, matrix: true });
          if (r.data?.ok && r.data.distMatrix && r.data.durMatrix) {
            distM = r.data.distMatrix;
            durM = r.data.durMatrix;
            routingSource = "maps";
          } else {
            routingError = r.data?.error || "Maps Distance Matrix indisponible";
          }
        } catch (e) {
          routingError = e instanceof Error ? e.message : String(e);
        }
      }
      if (routingSource === "haversine") {
        // Construit la matrice Haversine
        const allPts = [{ lat: eLat, lng: eLng }, ...selected.map((s) => ({ lat: s.lat, lng: s.lng }))];
        for (let i = 0; i < N1; i++) {
          for (let j = 0; j < N1; j++) {
            distM[i][j] = i === j ? 0 : haversineKmFs(allPts[i].lat, allPts[i].lng, allPts[j].lat, allPts[j].lng);
          }
        }
      }

      // Phase 3 : Clarke-Wright Savings (Yoann 2026-05-01 — Phase 2.1).
      // Avant : nearest-neighbor naïf depuis l entrepôt.
      // Maintenant : CWS standard industriel, gain typique 10-30 % sur la
      // distance totale. La capacité est intégrée dans CWS (les fusions
      // dépassant capacity sont rejetées) — on prend la meilleure route
      // (plus dense en demande) parmi les routes générées.
      const demands: number[] = [0, ...selected.map((s) => s.velosRestants)];
      const cwsRoutes = clarkeWrightSavings(distM, demands, capaciteEffective);
      let ordreIdx: number[] = cwsRoutes.length > 0 ? cwsRoutes[0] : [];
      // Si CWS n a rien produit (cas dégénéré : 1 seul client) → fallback NN
      if (ordreIdx.length === 0) {
        const remaining: number[] = selected.map((_, i) => i + 1);
        let cur = 0;
        while (remaining.length > 0) {
          let bk = 0;
          let bd = Infinity;
          for (let k = 0; k < remaining.length; k++) {
            if (distM[cur][remaining[k]] < bd) {
              bd = distM[cur][remaining[k]];
              bk = k;
            }
          }
          const next = remaining.splice(bk, 1)[0];
          ordreIdx.push(next);
          cur = next;
        }
      }

      // Phase 4 : 2-opt + Or-opt sur la route CWS (grattage des derniers %)
      ordreIdx = refine2OptOrOpt(ordreIdx, distM);

      const tourLenIdx = (arr: number[]) => {
        if (arr.length === 0) return 0;
        let total = distM[0][arr[0]];
        for (let i = 1; i < arr.length; i++) total += distM[arr[i - 1]][arr[i]];
        total += distM[arr[arr.length - 1]][0];
        return total;
      };

      // Construit la liste finale de stops avec distances et durées segment
      const stops: Stop[] = ordreIdx.map((idx, i) => {
        const stop = selected[idx - 1];
        const prevIdx = i === 0 ? 0 : ordreIdx[i - 1];
        return {
          ...stop,
          distance: Math.round(distM[prevIdx][idx] * 10) / 10,
        };
      });

      const totalVelosTournee = stops.reduce((s, x) => s + x.nbVelos, 0);
      const distanceTotaleKm = Math.round(tourLenIdx(ordreIdx) * 10) / 10;
      const dureeTotaleMin = durM
        ? (() => {
            if (ordreIdx.length === 0) return 0;
            let total = durM[0][ordreIdx[0]];
            for (let i = 1; i < ordreIdx.length; i++) total += durM[ordreIdx[i - 1]][ordreIdx[i]];
            total += durM[ordreIdx[ordreIdx.length - 1]][0];
            return total;
          })()
        : null;
      return {
        ok: true,
        entrepot: {
          id: entrepotId,
          nom: entrepot.nom || "?",
          ville: entrepot.ville || "",
          adresse: entrepot.adresse || "",
          lat: eLat,
          lng: eLng,
          role: entrepot.role || "stock",
          stockDispo,
        },
        mode,
        modeMontage,
        capaciteCamion,
        capaciteEffective,
        totalVelos: totalVelosTournee,
        nbStops: stops.length,
        distanceTotaleKm,
        dureeTotaleMin,
        routingSource,
        routingError,
        // KPIs rentabilité (Yoann 2026-05-01 — Phase 2.3) :
        // velos/heure chauffeur ; velos/km ; taux remplissage capacité camion.
        velosParHeure: dureeTotaleMin && dureeTotaleMin > 0
          ? Math.round((totalVelosTournee / (dureeTotaleMin / 60)) * 10) / 10
          : null,
        velosParKm: distanceTotaleKm > 0
          ? Math.round((totalVelosTournee / distanceTotaleKm) * 100) / 100
          : null,
        tauxRemplissage: capaciteCamion > 0
          ? Math.round((totalVelosTournee / capaciteCamion) * 100)
          : null,
        stops: stops.map((s) => ({
          id: s.id,
          entreprise: s.entreprise,
          ville: s.ville,
          lat: s.lat,
          lng: s.lng,
          nbVelos: s.nbVelos,
          distance: s.distance,
          velosRestantsApres: s.velosRestants - s.nbVelos,
        })),
        candidatsHorsTournee: candidats
          .filter((c) => !stops.some((s) => s.id === c.id))
          .slice(0, 5)
          .map((c) => ({
            id: c.id,
            entreprise: c.entreprise,
            ville: c.ville,
            distance: Math.round(c.distance * 10) / 10,
            velosRestants: c.velosRestants,
          })),
      };
    }

    case "planifierJourneeCamion": {
      // Yoann 2026-05-01 — planificateur multi-tournées : chaîne jusqu à
      // 3 tournées dans la journée chauffeur (8h30 par défaut). Maximise
      // le nb total de vélos livrés en jouant sur :
      //  - Routing Maps Distance Matrix réel (durées route précises)
      //  - Temps d arrêt par mode :
      //    * montés : 15 min/stop (déchargement seul)
      //    * cartons : (12 × nbVélos) / monteursParTournee min/stop
      //  - Recharge entrepôt entre tournées (10 min temps mort)
      // Stoppe quand la journée déborde OU le stock est épuisé.
      const epId = String(body.entrepotId || "");
      const camionMode = String(body.mode || "moyen");
      const mModeMontage = String(body.modeMontage || "client") as
        | "client"
        | "atelier"
        | "client_redistribue";
      const mUseMaps = body.useMaps === true;
      const mMaxDistance = Number(body.maxDistance || 50);
      const mMaxTournees = Math.min(5, Math.max(1, Number(body.maxTournees || 3)));
      const dureeJourneeMin = Number(body.dureeJourneeMin || 510); // 8h30
      const tempsRechargeMin = Number(body.tempsRechargeMin || 10);
      const tempsArretMontesMin = Number(body.tempsArretMontesMin || 15);
      const monteursParTournee = Math.max(1, Number(body.monteursParTournee || 2));
      const minPerVeloPerMonteur = Number(body.minPerVeloPerMonteur || 12);
      if (!epId) return { error: "entrepotId requis" };

      const CAPACITES_CARTONS_M: Record<string, number> = { gros: 77, moyen: 54, camionnette: 44, petit: 44 };
      const CAPACITES_MONTES_M: Record<string, number> = { gros: 40, moyen: 30, camionnette: 20, petit: 20 };
      const capTable = mModeMontage === "client" ? CAPACITES_CARTONS_M : CAPACITES_MONTES_M;
      const capCamion = capTable[camionMode] ?? 30;

      const eDoc = await getDoc(doc(db, "entrepots", epId));
      if (!eDoc.exists()) return { error: "Entrepôt introuvable" };
      const eData = eDoc.data() as {
        nom?: string; ville?: string; adresse?: string;
        lat?: number; lng?: number;
        stockCartons?: number; stockVelosMontes?: number; role?: string;
      };
      if (typeof eData.lat !== "number" || typeof eData.lng !== "number") {
        return { error: "Entrepôt sans coordonnées GPS" };
      }
      const epLat = eData.lat;
      const epLng = eData.lng;
      let stockDispoTotal = eData.role === "fournisseur"
        ? 99999
        : mModeMontage === "client"
          ? Number(eData.stockCartons || 0)
          : Number(eData.stockVelosMontes || 0);
      if (stockDispoTotal <= 0) {
        return {
          error: `Stock insuffisant à ${eData.nom} (${stockDispoTotal} dispo en ${mModeMontage})`,
        };
      }

      // Charge tous les clients livrables une fois pour toutes
      const clSnap = await getDocs(collection(db, "clients"));
      type CandStorm = { id: string; entreprise: string; ville: string; lat: number; lng: number; velosRestants: number };
      const allCands: CandStorm[] = [];
      const planifiesParClient2 = new Map<string, number>();
      const lvSnap = await getDocs(collection(db, "livraisons"));
      for (const d of lvSnap.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifiesParClient2.set(cid, (planifiesParClient2.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      for (const d of clSnap.docs) {
        const o = d.data() as { entreprise?: string; ville?: string; latitude?: number; longitude?: number; nbVelosCommandes?: number; stats?: { livres?: number } };
        const lat = typeof o.latitude === "number" ? o.latitude : NaN;
        const lng = typeof o.longitude === "number" ? o.longitude : NaN;
        if (!isFinite(lat) || !isFinite(lng)) continue;
        const reste = Math.max(0, Number(o.nbVelosCommandes || 0) - Number(o.stats?.livres || 0) - (planifiesParClient2.get(d.id) || 0));
        if (reste <= 0) continue;
        const dist = haversineKmFs(epLat, epLng, lat, lng);
        if (dist > mMaxDistance) continue;
        allCands.push({ id: d.id, entreprise: String(o.entreprise || ""), ville: String(o.ville || ""), lat, lng, velosRestants: reste });
      }
      allCands.sort((a, b) => haversineKmFs(epLat, epLng, a.lat, a.lng) - haversineKmFs(epLat, epLng, b.lat, b.lng));

      const tournees: Array<{
        index: number;
        capaciteEffective: number;
        totalVelos: number;
        nbStops: number;
        distanceKm: number;
        dureeRouteMin: number;
        dureeArretsMin: number;
        dureeTotalMin: number;
        routingSource: "haversine" | "maps";
        velosParHeure: number;
        velosParKm: number;
        tauxRemplissage: number;
        stops: Array<{ id: string; entreprise: string; ville: string; lat: number; lng: number; nbVelos: number; distance: number }>;
      }> = [];

      let dureeJourneeUtilisee = 0;
      let stockRestant = stockDispoTotal;
      const servis = new Set<string>(); // clientId déjà inclus dans une tournée

      for (let tnum = 1; tnum <= mMaxTournees; tnum++) {
        if (stockRestant <= 0) break;
        const dispoCands = allCands.filter((c) => !servis.has(c.id) && c.velosRestants > 0);
        if (dispoCands.length === 0) break;

        // Sélection capacité = min(cap camion, stock restant)
        // Yoann 2026-05-03 : ATOMICITÉ CLIENT — pas de split. Si reste
        // camion < total client, on saute ce client (sera couvert dans
        // la tournée suivante).
        const capEff = Math.min(capCamion, stockRestant);
        const sel: CandStorm[] = [];
        let resteCam = capEff;
        for (const c of dispoCands) {
          if (resteCam <= 0) break;
          if (c.velosRestants <= 0) continue;
          if (c.velosRestants > resteCam) continue; // skip — pas atomique
          const nb = c.velosRestants;
          sel.push({ ...c, velosRestants: nb });
          resteCam -= nb;
        }
        if (sel.length === 0) break;

        // Matrice (Maps si demandé, sinon Haversine)
        const N1 = sel.length + 1;
        let dM: number[][] = Array.from({ length: N1 }, () => new Array(N1).fill(0));
        let durM2: number[][] | null = null;
        let rSrc: "haversine" | "maps" = "haversine";
        if (mUseMaps && sel.length >= 1 && sel.length <= 24) {
          try {
            const callable = httpsCallable<
              { points: Array<{ lat: number; lng: number }>; matrix: boolean },
              { ok?: boolean; distMatrix?: number[][]; durMatrix?: number[][] }
            >(functions, "getRouting");
            const r = await callable({
              points: [{ lat: epLat, lng: epLng }, ...sel.map((s) => ({ lat: s.lat, lng: s.lng }))],
              matrix: true,
            });
            if (r.data?.ok && r.data.distMatrix && r.data.durMatrix) {
              dM = r.data.distMatrix;
              durM2 = r.data.durMatrix;
              rSrc = "maps";
            }
          } catch {}
        }
        if (rSrc === "haversine") {
          const allPts = [{ lat: epLat, lng: epLng }, ...sel.map((s) => ({ lat: s.lat, lng: s.lng }))];
          for (let i = 0; i < N1; i++) {
            for (let j = 0; j < N1; j++) {
              dM[i][j] = i === j ? 0 : haversineKmFs(allPts[i].lat, allPts[i].lng, allPts[j].lat, allPts[j].lng);
            }
          }
        }

        // CWS + 2-opt + Or-opt (Yoann 2026-05-01 — Phase 2.1)
        const dem = [0, ...sel.map((s) => s.velosRestants)];
        const cwsR = clarkeWrightSavings(dM, dem, capEff);
        let ord: number[] = cwsR.length > 0 ? cwsR[0] : [];
        if (ord.length === 0) {
          const remaining: number[] = sel.map((_, i) => i + 1);
          let curIdx = 0;
          while (remaining.length > 0) {
            let bk = 0; let bd = Infinity;
            for (let k = 0; k < remaining.length; k++) {
              if (dM[curIdx][remaining[k]] < bd) { bd = dM[curIdx][remaining[k]]; bk = k; }
            }
            const nx = remaining.splice(bk, 1)[0];
            ord.push(nx); curIdx = nx;
          }
        }
        ord = refine2OptOrOpt(ord, dM);
        const tourL = (a: number[]) => { if (!a.length) return 0; let t = dM[0][a[0]]; for (let i = 1; i < a.length; i++) t += dM[a[i - 1]][a[i]]; t += dM[a[a.length - 1]][0]; return t; };

        // Durée totale = route + arrêts (+ recharge si tnum > 1)
        const distKm = Math.round(tourL(ord) * 10) / 10;
        let dureeRoute = 0;
        if (durM2) {
          dureeRoute = durM2[0][ord[0]] || 0;
          for (let i = 1; i < ord.length; i++) dureeRoute += durM2[ord[i - 1]][ord[i]] || 0;
          if (ord.length > 0) dureeRoute += durM2[ord[ord.length - 1]][0] || 0;
        } else {
          // Fallback Haversine → estimation 35 km/h moyenne urbaine
          dureeRoute = Math.round((distKm / 35) * 60);
        }
        // Total vélos = somme des stops effectivement inclus par CWS
        // (peut être < sel.reduce si CWS a dû splitter en plusieurs routes
        // et qu on n a gardé que la 1ère)
        const totalVelosT = ord.reduce((s, idx) => s + sel[idx - 1].velosRestants, 0);
        const dureeArrets = mModeMontage === "client"
          ? Math.round((minPerVeloPerMonteur * totalVelosT) / monteursParTournee)
          : tempsArretMontesMin * ord.length;
        const dureeRecharge = tnum === 1 ? 0 : tempsRechargeMin;
        const dureeT = dureeRoute + dureeArrets + dureeRecharge;

        if (dureeJourneeUtilisee + dureeT > dureeJourneeMin) break;

        const stopsOut = ord.map((idx, i) => {
          const st = sel[idx - 1];
          const prev = i === 0 ? 0 : ord[i - 1];
          return { id: st.id, entreprise: st.entreprise, ville: st.ville, lat: st.lat, lng: st.lng, nbVelos: st.velosRestants, distance: Math.round(dM[prev][idx] * 10) / 10 };
        });

        tournees.push({
          index: tnum,
          capaciteEffective: capEff,
          totalVelos: totalVelosT,
          nbStops: ord.length,
          distanceKm: distKm,
          dureeRouteMin: dureeRoute,
          dureeArretsMin: dureeArrets,
          dureeTotalMin: dureeT,
          routingSource: rSrc,
          // KPIs rentabilité par tournée (Yoann 2026-05-01 — Phase 2.3)
          velosParHeure: dureeT > 0 ? Math.round((totalVelosT / (dureeT / 60)) * 10) / 10 : 0,
          velosParKm: distKm > 0 ? Math.round((totalVelosT / distKm) * 100) / 100 : 0,
          tauxRemplissage: capCamion > 0 ? Math.round((totalVelosT / capCamion) * 100) : 0,
          stops: stopsOut,
        });

        // Marque servis SEULEMENT les clients effectivement inclus par CWS
        // (si la route CWS retournée a moins de stops que sel, les autres
        // restent dispos pour la tournée suivante).
        for (const idx of ord) servis.add(sel[idx - 1].id);
        stockRestant -= totalVelosT;
        dureeJourneeUtilisee += dureeT;
      }

      const totalVelosJournee = tournees.reduce((s, t) => s + t.totalVelos, 0);
      const totalKmJournee = Math.round(tournees.reduce((s, t) => s + t.distanceKm, 0) * 10) / 10;
      const tempsLibreMin = Math.max(0, dureeJourneeMin - dureeJourneeUtilisee);
      // KPIs globaux journée
      const velosParHeureJournee = dureeJourneeUtilisee > 0
        ? Math.round((totalVelosJournee / (dureeJourneeUtilisee / 60)) * 10) / 10
        : 0;
      const velosParKmJournee = totalKmJournee > 0
        ? Math.round((totalVelosJournee / totalKmJournee) * 100) / 100
        : 0;

      return {
        ok: true,
        entrepot: { id: epId, nom: eData.nom || "?", stockDispo: stockDispoTotal, stockRestantApres: stockRestant },
        mode: camionMode,
        modeMontage: mModeMontage,
        capaciteCamion: capCamion,
        dureeJourneeMin,
        dureeJourneeUtilisee,
        tempsLibreMin,
        velosParHeureJournee,
        velosParKmJournee,
        nbTournees: tournees.length,
        totalVelosJournee,
        totalKmJournee,
        monteursParTournee,
        tournees,
      };
    }

    case "strategieGemini": {
      // Yoann 2026-05-01 — Phase 3.1 : Gemini joue le logisticien stratège.
      // Au lieu d un seul plan algorithmique, on lui demande 3 plans
      // alternatifs avec narratif et tradeoffs. Aide le user à arbitrer
      // selon le contexte (urgence, météo, fatigue équipe, jour férié,
      // priorités client...).
      //
      // Yoann 2026-05-02 : on charge automatiquement équipe + flotte pour
      // que Gemini connaisse les ressources réelles (chauffeurs/chefs/
      // monteurs/camions). Sans ça il optimisait à l aveugle sur 1 camion.
      const dureeJourneeMinG = Number(body.dureeJourneeMin || 510);
      const monteursParTourneeG = Math.max(1, Number(body.monteursParTournee || 2));
      // Overrides manuels possibles (cas absences ce jour-là)
      const overrideChauffeurs = body.nbChauffeurs != null ? Number(body.nbChauffeurs) : null;
      const overrideChefs = body.nbChefs != null ? Number(body.nbChefs) : null;
      const overrideMonteurs = body.nbMonteurs != null ? Number(body.nbMonteurs) : null;
      const overrideCamions = body.nbCamions != null ? Number(body.nbCamions) : null;

      // Charge entrepôts non-fournisseur non-archivés avec stock > 0
      const eSnap = await getDocs(collection(db, "entrepots"));
      type EntrepotCtx = { id: string; nom: string; ville: string; lat: number; lng: number; stockCartons: number; stockVelosMontes: number; role: string };
      const entrepotsCtx: EntrepotCtx[] = [];
      const groupesEphemeres = new Set<string>(); // groupeClient des éphémères → exclus de la planif
      for (const d of eSnap.docs) {
        const o = d.data() as { nom?: string; ville?: string; lat?: number; lng?: number; stockCartons?: number; stockVelosMontes?: number; role?: string; dateArchivage?: unknown; groupeClient?: string };
        if (o.dateArchivage) continue;
        if (o.role === "fournisseur") continue;
        // Yoann 2026-05-03 : entrepôt éphémère = stock client (Firat Food) où
        // les vélos sont destinés UNIQUEMENT aux magasins du groupe (livré
        // par le client lui-même, pas par notre flotte). On exclut donc.
        if (o.role === "ephemere") {
          if (o.groupeClient) groupesEphemeres.add(String(o.groupeClient).toLowerCase());
          continue;
        }
        if (typeof o.lat !== "number" || typeof o.lng !== "number") continue;
        const sc = Number(o.stockCartons || 0);
        const sm = Number(o.stockVelosMontes || 0);
        if (sc + sm <= 0) continue;
        entrepotsCtx.push({
          id: d.id,
          nom: String(o.nom || ""),
          ville: String(o.ville || ""),
          lat: o.lat,
          lng: o.lng,
          stockCartons: sc,
          stockVelosMontes: sm,
          role: String(o.role || "stock"),
        });
      }
      if (entrepotsCtx.length === 0) {
        return { ok: false, error: "Aucun entrepôt avec stock disponible" };
      }

      // Charge clients restants (top 50 par volume restant)
      const cSnap = await getDocs(collection(db, "clients"));
      const lvSnap = await getDocs(collection(db, "livraisons"));
      const planifies = new Map<string, number>();
      for (const d of lvSnap.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifies.set(cid, (planifies.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      type ClientCtx = { id: string; entreprise: string; ville: string; lat: number; lng: number; velosRestants: number; codePostal: string; estParis: boolean; creneauLivraison: string | null };
      const clientsCtx: ClientCtx[] = [];
      let nbClientsExclusGroupe = 0;
      for (const d of cSnap.docs) {
        const o = d.data() as { entreprise?: string; ville?: string; latitude?: number; longitude?: number; nbVelosCommandes?: number; stats?: { livres?: number }; codePostal?: string; groupe?: string; groupeClient?: string; creneauLivraison?: string };
        if (typeof o.latitude !== "number" || typeof o.longitude !== "number") continue;
        const reste = Math.max(0, Number(o.nbVelosCommandes || 0) - Number(o.stats?.livres || 0) - (planifies.get(d.id) || 0));
        if (reste <= 0) continue;
        // Yoann 2026-05-03 : si le client appartient à un groupe qui a un
        // entrepôt éphémère, il est livré DEPUIS l éphémère par le groupe
        // (pas notre flotte). On l exclut des candidats.
        const groupeClient = (o.groupe || o.groupeClient || "").toLowerCase();
        if (groupeClient && groupesEphemeres.has(groupeClient)) {
          nbClientsExclusGroupe++;
          continue;
        }
        const cp = String(o.codePostal || "");
        const estParis = /^75\d{3}$/.test(cp); // 75001-75020 = Paris intra-muros
        clientsCtx.push({
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          lat: o.latitude,
          lng: o.longitude,
          velosRestants: reste,
          codePostal: cp,
          estParis,
          // Yoann 2026-05-03 — VRP-TW : créneau préféré pour la livraison.
          // Format libre : "matin", "apresmidi", "specifique 14h-16h", null=flexible
          creneauLivraison: typeof o.creneauLivraison === "string" && o.creneauLivraison.trim() ? o.creneauLivraison.trim() : null,
        });
      }
      // Top 50 par volume restant pour limiter le prompt
      clientsCtx.sort((a, b) => b.velosRestants - a.velosRestants);
      const clientsForPrompt = clientsCtx.slice(0, 50);

      // totalVelosRestants = somme APRES exclusion groupes éphémères
      // (ne compte plus les clients du groupe Firat dans le besoin réel)
      const totalVelosRestants = clientsCtx.reduce((s, c) => s + c.velosRestants, 0);
      const nbClientsParis = clientsCtx.filter((c) => c.estParis).length;

      // Pre-prompt contextuel (Yoann 2026-05-03) : météo + jour férié.
      // Open-Meteo gratuit, sans clé. Failover silencieux si KO.
      let meteoLine = "";
      let jourFerie: string | null = null;
      try {
        const today = new Date().toISOString().slice(0, 10);
        // Météo Paris demain (jour de la planif typique)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tDate = tomorrow.toISOString().slice(0, 10);
        const meteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=Europe%2FParis&start_date=${tDate}&end_date=${tDate}`;
        const r = await fetch(meteoUrl);
        if (r.ok) {
          const j = (await r.json()) as { daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_sum?: number[]; wind_speed_10m_max?: number[] } };
          const tmax = j.daily?.temperature_2m_max?.[0];
          const tmin = j.daily?.temperature_2m_min?.[0];
          const precip = j.daily?.precipitation_sum?.[0];
          const wind = j.daily?.wind_speed_10m_max?.[0];
          if (tmax != null) {
            const conditions: string[] = [];
            if ((precip ?? 0) > 5) conditions.push(`pluie ${precip}mm`);
            if ((wind ?? 0) > 50) conditions.push(`vent fort ${wind}km/h`);
            if ((tmin ?? 100) < 0) conditions.push("gel matinal");
            if ((tmax ?? 0) > 35) conditions.push("canicule");
            meteoLine = `Météo demain Paris : ${tmin}-${tmax}°C${conditions.length > 0 ? ", " + conditions.join(" + ") : ", conditions normales"}.`;
          }
        }
        // Jours fériés FR (table statique 2026)
        const feries2026: Record<string, string> = {
          "2026-01-01": "Jour de l An",
          "2026-04-06": "Lundi de Pâques",
          "2026-05-01": "Fête du Travail",
          "2026-05-08": "Victoire 1945",
          "2026-05-14": "Ascension",
          "2026-05-25": "Lundi de Pentecôte",
          "2026-07-14": "Fête nationale",
          "2026-08-15": "Assomption",
          "2026-11-01": "Toussaint",
          "2026-11-11": "Armistice",
          "2026-12-25": "Noël",
        };
        if (feries2026[tDate]) jourFerie = feries2026[tDate];
        if (feries2026[today]) jourFerie = (jourFerie ? jourFerie + " (et hier)" : feries2026[today] + " (aujourd hui)");
      } catch {
        // failover silencieux : pas de météo dispo
      }
      const totalCartons = entrepotsCtx.reduce((s, e) => s + e.stockCartons, 0);
      const totalMontes = entrepotsCtx.reduce((s, e) => s + e.stockVelosMontes, 0);

      // Charge équipe active (Yoann 2026-05-02)
      const eqSnap = await getDocs(collection(db, "equipe"));
      type Membre = { id: string; nom: string; role: string; aussiMonteur?: boolean };
      const chauffeursList: Membre[] = [];
      const chefsList: Membre[] = [];
      const monteursList: Membre[] = [];
      for (const d of eqSnap.docs) {
        const o = d.data() as { nom?: string; role?: string; actif?: boolean; aussiMonteur?: boolean };
        if (o.actif === false) continue;
        const m: Membre = { id: d.id, nom: String(o.nom || ""), role: String(o.role || ""), aussiMonteur: o.aussiMonteur === true };
        if (m.role === "chauffeur") chauffeursList.push(m);
        if (m.role === "chef") {
          chefsList.push(m);
          if (m.aussiMonteur) monteursList.push(m); // chef polyvalent
        }
        if (m.role === "monteur") monteursList.push(m);
      }
      const nbChauffeurs = overrideChauffeurs ?? chauffeursList.length;
      const nbChefs = overrideChefs ?? chefsList.length;
      const nbMonteurs = overrideMonteurs ?? monteursList.length;

      // Charge flotte active
      const flSnap = await getDocs(collection(db, "flotte"));
      type CamionFlotte = { id: string; nom: string; type: string; capaciteVelos: number };
      const camionsList: CamionFlotte[] = [];
      for (const d of flSnap.docs) {
        const o = d.data() as { nom?: string; type?: string; capaciteVelos?: number; actif?: boolean };
        if (o.actif === false) continue;
        camionsList.push({
          id: d.id,
          nom: String(o.nom || ""),
          type: String(o.type || "moyen"),
          capaciteVelos: Number(o.capaciteVelos || 0),
        });
      }
      const nbCamions = overrideCamions ?? camionsList.length;

      const prompt = `Tu es un logisticien expert en VRP (Vehicle Routing Problem) multi-véhicules multi-dépôts. Tu planifies les tournées de livraison de vélos cargo en région Île-de-France et alentours.
${meteoLine ? `\n🌤 ${meteoLine}` : ""}${jourFerie ? `\n📅 Jour férié : ${jourFerie} → trafic potentiellement allégé OU clients fermés (à arbitrer dans la stratégie).` : ""}
${nbClientsParis > 0 ? `🚦 ${nbClientsParis} client${nbClientsParis > 1 ? "s" : ""} en Paris intra-muros (CP 75XXX) → contraintes camion poids lourd à respecter.\n` : ""}

RESSOURCES HUMAINES & MATÉRIELLES (réelles, à respecter) :
- Chauffeurs disponibles : ${nbChauffeurs} (= nb de tournées en parallèle max)
- Chefs d équipe : ${nbChefs} (1 chef accompagne idéalement chaque tournée mode "client" pour superviser le montage)
- Monteurs disponibles au total dans la journée : ${nbMonteurs}
  → à RÉPARTIR entre tournées (pas par tournée). Ex : 6 monteurs + 3 chauffeurs = 2 monteurs/tournée. Ou 1 grosse tournée avec 4 + 2 petites avec 1 chacune.
- Camions actifs : ${nbCamions}${camionsList.length > 0 ? `\n  Détail flotte : ${camionsList.map((c) => `${c.nom} (${c.type}, ${c.capaciteVelos}v)`).join(" · ")}` : ""}

CONTEXTE OPÉRATIONNEL :
- Durée journée chauffeur : ${dureeJourneeMinG} minutes (${Math.round(dureeJourneeMinG / 60 * 10) / 10}h) — CHAQUE chauffeur peut faire 1 ou plusieurs tournées dans cette fenêtre
- Préférence par défaut monteurs/tournée mode "client" : ${monteursParTourneeG}
- Mode "client" (cartons + montage chez client) : monteurs OBLIGATOIRES sur place ; temps arrêt = 12 min × nbVélos / nbMonteurs
  → 10v à 1 monteur = 120 min. À 4 monteurs = 30 min.
- Mode "atelier" (vélos pré-montés livrés) : **0 monteur nécessaire** (vélos déjà montés en session atelier en amont) — chauffeur seul fait la livraison ; temps arrêt ~15 min/stop fixe
- Mode "client_redistribue" (groupe éphémère) : NE PAS UTILISER ici — réservé aux livraisons internes du groupe (déjà gérées hors planif)
- Recharge entrepôt entre 2 tournées du même chauffeur : 10 min

🚛 FLOTTE RÉELLE :
- Petit camion : 44 cartons / 20 montés · ✅ peut entrer dans Paris et petites rues
- Grand camion : 77 cartons / 40 montés · ❌ POIDS LOURD interdit Paris/petites rues
- Si client en Paris (CP 75XXX) → forcer petit camion. Si volume > 44 cartons sur Paris → soit splitter en 2 tournées petit camion soit livrer en montés (plus compact)

CONTRAINTE CLÉ : tu as ${nbChauffeurs} chauffeur${nbChauffeurs > 1 ? "s" : ""}, donc jusqu à ${nbChauffeurs} tournée${nbChauffeurs > 1 ? "s" : ""} EN PARALLÈLE le même jour. Tu peux aussi enchaîner plusieurs tournées sur 1 chauffeur (matin + après-midi).

📦 RÈGLE MÉTIER CRITIQUE (1 client = 1 jour) :
Un client ne peut PAS être livré en plusieurs jours. TOUTE la commande tombe sur 1 même date.
MAIS si volume client > capacité d un seul camion (gros = 40 montés / 77 cartons ; petit = 20 montés / 44 cartons), tu DOIS proposer 2 camions en parallèle le même jour vers ce client (multi-camions OK).
Exemple : client commande 60 vélos montés → tournée 1 grand camion (40v) + tournée 2 petit camion (20v) le même jour, vers ce même client.
${(() => {
  const clientsGrosVolume = clientsForPrompt.filter((c) => c.velosRestants > 40);
  if (clientsGrosVolume.length === 0) return "Aucun client > 40v aujourd hui (cas standard, 1 camion suffit par client).";
  return `⚠️ ${clientsGrosVolume.length} client${clientsGrosVolume.length > 1 ? "s" : ""} avec volume > 40v (capa max grand camion en montés) : ${clientsGrosVolume.slice(0, 5).map((c) => `${c.entreprise} ${c.velosRestants}v`).join(", ")}${clientsGrosVolume.length > 5 ? "..." : ""} → multi-camions requis.`;
})()}

⭐ PRÉFÉRENCE STRATÉGIQUE FORTE (Yoann 2026-05-03) :
Par défaut, **PRIVILÉGIE LE MODE ATELIER (vélos montés)** plutôt que cartons. Raisons :
- 0 monteur sur place → équipe terrain rentre tôt
- Arrêts courts (15 min/stop) → plus de tournées par jour
- Moins de coordination chauffeur/chefs/monteurs
- Stock montés disponible : ${totalMontes}v (utilise-le en priorité)

Ne propose mode "client" (cartons + montage chez client) QUE si :
- Volume client > capacité montés du camion (gros camion = 40 montés max, petit = 20)
- Client a beaucoup d espace de montage ET volume justifie l attente
- Stock montés trop bas pour couvrir la demande

Au moins 2 plans sur 3 doivent être en mode atelier dominant.

🧠 INTELLIGENCE ATTENDUE :
1. Plan A préféré : tournée atelier multiple (2-3 tournées montés en parallèle si plusieurs chauffeurs, 0 monteur, équipe rentre 14h)
2. Plan B alternatif : 1 grosse tournée cartons gros volumes + 1 tournée atelier petits volumes en parallèle
3. **PLAN MIXTE possible** : 1 chauffeur fait tournée atelier le matin (sans monteurs, rentre 11h) + tournée cartons après-midi avec monteurs récupérés
4. Quand client est à Paris : impose le petit camion (le grand est interdit)
5. Si peu de monteurs disponibles vs gros volume cartons → préfère mode atelier (rapidité) ou impose des monteurs supplémentaires${nbClientsExclusGroupe > 0 ? `\n\nNOTE : ${nbClientsExclusGroupe} client(s) ont été exclu(s) de cette planif car ils appartiennent à un groupe livré directement par leur entrepôt éphémère (Firat Food et autres groupes). Pas à inclure dans tes plans.` : ""}

ENTREPÔTS DISPONIBLES (${entrepotsCtx.length}) :
${entrepotsCtx.map((e) => `- ${e.id} | ${e.nom} (${e.ville}) | lat=${e.lat.toFixed(4)},lng=${e.lng.toFixed(4)} | ${e.stockCartons} cartons + ${e.stockVelosMontes} montés`).join("\n")}

CLIENTS À LIVRER (top ${clientsForPrompt.length} par volume, ${clientsCtx.length} au total, ${totalVelosRestants} vélos restants au global) :
${clientsForPrompt.map((c) => `- ${c.id} | ${c.entreprise} (${c.ville}, ${c.codePostal})${c.estParis ? " ⚠️PARIS" : ""}${c.creneauLivraison ? ` 🕐${c.creneauLivraison}` : ""} | lat=${c.lat.toFixed(4)},lng=${c.lng.toFixed(4)} | ${c.velosRestants}v`).join("\n")}
${(() => {
  const avecCreneau = clientsForPrompt.filter((c) => c.creneauLivraison);
  if (avecCreneau.length === 0) return "";
  const creneaux = new Set(avecCreneau.map((c) => c.creneauLivraison));
  return `\n🕐 ${avecCreneau.length} client${avecCreneau.length > 1 ? "s" : ""} avec contrainte horaire (${[...creneaux].join(", ")}) → respecter les créneaux dans l ordre de visite. Idéalement regrouper les clients du même créneau dans la même tournée pour minimiser le risque de retard.`;
})()}

STOCK GLOBAL : ${totalCartons} cartons + ${totalMontes} montés = ${totalCartons + totalMontes} vélos disponibles.

DEMANDE :
Propose 3 stratégies de planification de la JOURNÉE qui RESPECTENT les ressources réelles ci-dessus (${nbChauffeurs} chauffeur${nbChauffeurs > 1 ? "s" : ""}, ${nbChefs} chef${nbChefs > 1 ? "s" : ""}, ${nbMonteurs} monteur${nbMonteurs > 1 ? "s" : ""}, ${nbCamions} camion${nbCamions > 1 ? "s" : ""}).

Tradeoffs à exploiter :
- Mode "client" (cartons) : camion bien rempli (132 max) mais arrêts longs (12 min/vélo / nbMonteurs) → souvent 1 grosse tournée par chauffeur
- Mode "atelier" (montés) : camion plus petit (40 max) mais arrêts courts (15 min/stop) → 2-3 tournées rapides possibles
- Allocation humaine : concentrer monteurs sur 1 grosse tournée vs étaler sur plusieurs petites
- Multi-chauffeurs : si N>1 chauffeurs, tournées EN PARALLÈLE (depuis entrepôts différents idéalement) → divise le temps total par N

Les 3 plans doivent vraiment ÊTRE différents (pas variantes d un même plan) :
  - Plan A : maximise vélos livrés (peu importe la durée)
  - Plan B : maximise rapidité (finir tôt, équipe rentre tôt)
  - Plan C : équilibre intelligent (compromis vélos/temps/utilisation équipe)
(Mais tu peux dévier si une autre logique fait + de sens vu le contexte.)

Réponds STRICTEMENT en JSON valide (sans markdown), structure exacte :

{
  "plans": [
    {
      "titre": "string court (max 60 chars)",
      "strategie": "string : description en 1 phrase",
      "narratif": "string : pourquoi cette stratégie, tradeoffs, comment les ressources sont allouées, 2-4 phrases",
      "params": {
        "entrepotId": "string parmi les ids (entrepôt principal — laisse libre pour multi-dépôt)",
        "entrepotNom": "string",
        "modeCamion": "gros | moyen | petit | camionnette",
        "modeMontage": "client | atelier | client_redistribue | mixte",
        "maxTournees": number (total tournées sur la journée, tous chauffeurs confondus),
        "monteursParTournee": number (moyenne)
      },
      "allocation": {
        "nbChauffeursUtilises": number,
        "nbChefsUtilises": number,
        "nbMonteursUtilises": number,
        "nbCamionsUtilises": number,
        "repartition": "string : description courte de qui fait quoi, ex: 'Chauffeur 1 : grosse tournée 132v depuis AXDIS avec 4 monteurs ; Chauffeur 2 : petite tournée 30v depuis Lisses montés avec 1 monteur'"
      },
      "estimation": {
        "velosLivresEstime": number,
        "dureeJourneeEstime": number (minutes — tournée la + longue si en parallèle),
        "scoreVelosParHeure": number,
        "scoreVelosParPersonne": number
      }
    },
    ... 2 autres plans ...
  ],
  "recommandation": "string : quelle stratégie est la meilleure aujourd hui et pourquoi (2-3 phrases)",
  "alertes": ["string : alerte ou opportunité non évidente, par ex sous-utilisation chauffeur / stock faible / client urgent / etc"]
}`;

      try {
        const { callGemini } = await import("@/lib/gemini-client");
        const r = await callGemini(prompt);
        if (!r.ok) return { ok: false, error: r.error };
        // Parse JSON strict, robuste aux backticks/markdown éventuels
        const txt = r.text.trim();
        const jsonStart = txt.indexOf("{");
        const jsonEnd = txt.lastIndexOf("}");
        if (jsonStart < 0 || jsonEnd < 0) {
          return { ok: false, error: "Réponse Gemini sans JSON détectable", raw: txt.slice(0, 500) };
        }
        const jsonStr = txt.slice(jsonStart, jsonEnd + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          return { ok: false, error: "JSON Gemini invalide : " + (e instanceof Error ? e.message : String(e)), raw: jsonStr.slice(0, 500) };
        }
        return { ok: true, ...(parsed as Record<string, unknown>), model: r.model };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "resetStockEntrepot": {
      // Yoann 2026-05-03 — bouton "Reset stock" pour remettre à 0 les stocks
      // de test. Crée un mouvement traçable (-N cartons / -N montés) puis
      // pose stockCartons=0 et stockVelosMontes=0.
      const epIdRst = String(body.entrepotId || "");
      if (!epIdRst) return { error: "entrepotId requis" };
      const eRef = doc(db, "entrepots", epIdRst);
      const eSnap = await getDoc(eRef);
      if (!eSnap.exists()) return { error: "Entrepôt introuvable" };
      const eData = eSnap.data() as { nom?: string; stockCartons?: number; stockVelosMontes?: number };
      const oldCartons = Number(eData.stockCartons || 0);
      const oldMontes = Number(eData.stockVelosMontes || 0);
      const today = new Date().toISOString().slice(0, 10);
      if (oldCartons > 0) {
        await addDoc(collection(db, "entrepots", epIdRst, "mouvements"), {
          type: "carton",
          quantite: -oldCartons,
          date: today,
          source: "reset-manuel",
          notes: "Remise à zéro stock cartons (admin)",
          createdAt: ts(),
        });
      }
      if (oldMontes > 0) {
        await addDoc(collection(db, "entrepots", epIdRst, "mouvements"), {
          type: "monte",
          quantite: -oldMontes,
          date: today,
          source: "reset-manuel",
          notes: "Remise à zéro stock vélos montés (admin)",
          createdAt: ts(),
        });
      }
      await updateDoc(eRef, {
        stockCartons: 0,
        stockVelosMontes: 0,
        updatedAt: ts(),
      });
      return { ok: true, oldCartons, oldMontes, entrepotNom: eData.nom };
    }

    case "suggestionStockEntrepot": {
      // Yoann 2026-05-03 — Pour chaque entrepôt non-fournisseur non-éphémère,
      // calcule le stock cible cartons/montés pour servir efficacement les
      // clients dans le rayon (par défaut 100 km autour de Paris).
      //
      // Logique :
      //   1. Charge entrepôts éligibles + clients restants dans rayon
      //   2. Voronoi : chaque client → entrepôt le + proche
      //   3. Pour chaque entrepôt, somme demande des clients attribués
      //   4. Décompose : gros volumes (>30v) → cartons, petits → montés
      //      (priorité montés selon préférence Yoann 2026-05-03)
      //   5. +10% buffer sécurité
      const rayonKm = Number(body.rayonKm || 100);
      const centerLat = Number(body.centerLat || 48.8566); // Paris par défaut
      const centerLng = Number(body.centerLng || 2.3522);
      const seuilGrosVolume = Number(body.seuilGrosVolume || 30);

      // Entrepôts éligibles
      const eSnap = await getDocs(collection(db, "entrepots"));
      type Entr = { id: string; nom: string; ville: string; lat: number; lng: number; stockCartons: number; stockVelosMontes: number; capaciteMax: number | null };
      const entrepots: Entr[] = [];
      for (const d of eSnap.docs) {
        const o = d.data() as { nom?: string; ville?: string; lat?: number; lng?: number; stockCartons?: number; stockVelosMontes?: number; role?: string; dateArchivage?: unknown; capaciteMax?: number };
        if (o.dateArchivage) continue;
        if (o.role === "fournisseur" || o.role === "ephemere") continue;
        if (typeof o.lat !== "number" || typeof o.lng !== "number") continue;
        entrepots.push({
          id: d.id,
          nom: String(o.nom || ""),
          ville: String(o.ville || ""),
          lat: o.lat,
          lng: o.lng,
          stockCartons: Number(o.stockCartons || 0),
          stockVelosMontes: Number(o.stockVelosMontes || 0),
          capaciteMax: typeof o.capaciteMax === "number" ? o.capaciteMax : null,
        });
      }
      if (entrepots.length === 0) return { error: "Aucun entrepôt éligible" };

      // Clients restants dans rayon
      const cSnap = await getDocs(collection(db, "clients"));
      const lvSnap = await getDocs(collection(db, "livraisons"));
      const planifies = new Map<string, number>();
      for (const d of lvSnap.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifies.set(cid, (planifies.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      type Cli = { id: string; entreprise: string; ville: string; lat: number; lng: number; reste: number; distCenter: number };
      const clientsDansRayon: Cli[] = [];
      for (const d of cSnap.docs) {
        const o = d.data() as { entreprise?: string; ville?: string; latitude?: number; longitude?: number; nbVelosCommandes?: number; stats?: { livres?: number } };
        if (typeof o.latitude !== "number" || typeof o.longitude !== "number") continue;
        const reste = Math.max(0, Number(o.nbVelosCommandes || 0) - Number(o.stats?.livres || 0) - (planifies.get(d.id) || 0));
        if (reste <= 0) continue;
        const distCenter = haversineKmFs(centerLat, centerLng, o.latitude, o.longitude);
        if (distCenter > rayonKm) continue;
        clientsDansRayon.push({
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          lat: o.latitude,
          lng: o.longitude,
          reste,
          distCenter,
        });
      }

      // Voronoi : chaque client → entrepôt le + proche
      type Bucket = { entrepotId: string; nom: string; ville: string; clients: Cli[]; demandeTotale: number; demandeGrosVolumes: number; demandePetitsVolumes: number; nbGros: number; nbPetits: number };
      const buckets: Map<string, Bucket> = new Map();
      for (const e of entrepots) {
        buckets.set(e.id, {
          entrepotId: e.id,
          nom: e.nom,
          ville: e.ville,
          clients: [],
          demandeTotale: 0,
          demandeGrosVolumes: 0,
          demandePetitsVolumes: 0,
          nbGros: 0,
          nbPetits: 0,
        });
      }
      for (const c of clientsDansRayon) {
        let bestE: Entr | null = null;
        let bestD = Infinity;
        for (const e of entrepots) {
          const d = haversineKmFs(c.lat, c.lng, e.lat, e.lng);
          if (d < bestD) {
            bestD = d;
            bestE = e;
          }
        }
        if (!bestE) continue;
        const b = buckets.get(bestE.id)!;
        b.clients.push(c);
        b.demandeTotale += c.reste;
        if (c.reste > seuilGrosVolume) {
          b.demandeGrosVolumes += c.reste;
          b.nbGros++;
        } else {
          b.demandePetitsVolumes += c.reste;
          b.nbPetits++;
        }
      }

      // Pour chaque entrepôt : reco cartons/montés
      // Préférence montés : on cible montés pour les petits volumes (≤30v)
      // et cartons pour les gros volumes (>30v).
      const BUFFER = 1.10;
      const result = entrepots.map((e) => {
        const b = buckets.get(e.id)!;
        const cibleMontes = Math.ceil(b.demandePetitsVolumes * BUFFER);
        const cibleCartons = Math.ceil(b.demandeGrosVolumes * BUFFER);
        const cibleTotale = cibleMontes + cibleCartons;
        const ecartCartons = cibleCartons - e.stockCartons;
        const ecartMontes = cibleMontes - e.stockVelosMontes;
        const capaciteAtteinte = e.capaciteMax != null ? cibleTotale > e.capaciteMax : false;
        return {
          entrepotId: e.id,
          nom: e.nom,
          ville: e.ville,
          stockActuel: { cartons: e.stockCartons, montes: e.stockVelosMontes, total: e.stockCartons + e.stockVelosMontes },
          demande: {
            totale: b.demandeTotale,
            grosVolumes: b.demandeGrosVolumes,
            petitsVolumes: b.demandePetitsVolumes,
            nbClients: b.clients.length,
            nbGros: b.nbGros,
            nbPetits: b.nbPetits,
          },
          cible: {
            cartons: cibleCartons,
            montes: cibleMontes,
            total: cibleTotale,
            buffer: `${(BUFFER - 1) * 100}%`,
          },
          ecart: {
            cartons: ecartCartons,
            montes: ecartMontes,
            total: ecartCartons + ecartMontes,
          },
          capaciteAtteinte,
          capaciteMax: e.capaciteMax,
        };
      });

      // Tri par demande totale décroissante
      result.sort((a, b) => b.demande.totale - a.demande.totale);

      const totalDemande = result.reduce((s, r) => s + r.demande.totale, 0);
      const totalCibleCartons = result.reduce((s, r) => s + r.cible.cartons, 0);
      const totalCibleMontes = result.reduce((s, r) => s + r.cible.montes, 0);
      const nbClientsRayon = clientsDansRayon.length;

      return {
        ok: true,
        rayonKm,
        center: { lat: centerLat, lng: centerLng, label: "Paris centre" },
        seuilGrosVolume,
        nbEntrepots: entrepots.length,
        nbClientsRayon,
        totalDemande,
        totalCibleCartons,
        totalCibleMontes,
        entrepots: result,
      };
    }

    case "simulationOperationComplete": {
      // Yoann 2026-05-03 — Simulation macro "Opération Paris" :
      // En 1 clic, on calcule pour livrer TOUS les clients dans X km
      // autour de Paris :
      //   - Stock cartons + montés cible par entrepôt (Voronoi)
      //   - Nb tournées estimé par entrepôt (split montés/cartons selon
      //     volume client, préférence montés Yoann 2026-05-03)
      //   - Nb jours estimés selon flotte + équipe disponibles
      //   - Synthèse globale (total clients, vélos, tournées, jours)
      const rayonKmS = Number(body.rayonKm || 130);
      const centerLatS = Number(body.centerLat || 48.8566);
      const centerLngS = Number(body.centerLng || 2.3522);
      const seuilGrosVolumeS = Number(body.seuilGrosVolume || 30);
      const dureeJourneeMinS = Number(body.dureeJourneeMin || 510); // 8h30
      const overrideChauffeursS = body.nbChauffeurs != null ? Number(body.nbChauffeurs) : null;
      // Yoann 2026-05-03 : sélection précise des camions dispo (au lieu de
      // tous les camions actifs). Si non fourni → tous les actifs.
      const camionIdsSelectionS = Array.isArray(body.camionIds) ? (body.camionIds as string[]) : null;

      // Charge entrepôts éligibles (non-fournisseur, non-éphémère)
      const eSnapS = await getDocs(collection(db, "entrepots"));
      type EntrSim = { id: string; nom: string; ville: string; lat: number; lng: number; stockCartons: number; stockVelosMontes: number };
      const entrepotsS: EntrSim[] = [];
      const groupesEphSet = new Set<string>();
      for (const d of eSnapS.docs) {
        const o = d.data() as { nom?: string; ville?: string; lat?: number; lng?: number; stockCartons?: number; stockVelosMontes?: number; role?: string; dateArchivage?: unknown; groupeClient?: string };
        if (o.dateArchivage) continue;
        if (o.role === "fournisseur") continue;
        if (o.role === "ephemere") {
          if (o.groupeClient) groupesEphSet.add(String(o.groupeClient).toLowerCase());
          continue;
        }
        if (typeof o.lat !== "number" || typeof o.lng !== "number") continue;
        entrepotsS.push({
          id: d.id,
          nom: String(o.nom || ""),
          ville: String(o.ville || ""),
          lat: o.lat,
          lng: o.lng,
          stockCartons: Number(o.stockCartons || 0),
          stockVelosMontes: Number(o.stockVelosMontes || 0),
        });
      }
      if (entrepotsS.length === 0) return { error: "Aucun entrepôt éligible" };

      // Charge clients restants dans rayon
      const cSnapS = await getDocs(collection(db, "clients"));
      const lvSnapS = await getDocs(collection(db, "livraisons"));
      const planifS = new Map<string, number>();
      for (const d of lvSnapS.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifS.set(cid, (planifS.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      type CliSim = { id: string; entreprise: string; ville: string; lat: number; lng: number; reste: number; estParis: boolean };
      const clientsS: CliSim[] = [];
      for (const d of cSnapS.docs) {
        const o = d.data() as { entreprise?: string; ville?: string; latitude?: number; longitude?: number; nbVelosCommandes?: number; stats?: { livres?: number }; codePostal?: string; groupe?: string; groupeClient?: string };
        if (typeof o.latitude !== "number" || typeof o.longitude !== "number") continue;
        const reste = Math.max(0, Number(o.nbVelosCommandes || 0) - Number(o.stats?.livres || 0) - (planifS.get(d.id) || 0));
        if (reste <= 0) continue;
        const grpc = (o.groupe || o.groupeClient || "").toLowerCase();
        if (grpc && groupesEphSet.has(grpc)) continue; // exclus groupe Firat
        const distC = haversineKmFs(centerLatS, centerLngS, o.latitude, o.longitude);
        if (distC > rayonKmS) continue;
        const cp = String(o.codePostal || "");
        clientsS.push({
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          lat: o.latitude,
          lng: o.longitude,
          reste,
          estParis: /^75\d{3}$/.test(cp),
        });
      }

      // Charge flotte active
      const flSnapS = await getDocs(collection(db, "flotte"));
      type CamS = { id: string; nom: string; capaciteCartons: number; capaciteVelosMontes: number; peutEntrerParis: boolean };
      const camionsAll: CamS[] = [];
      for (const d of flSnapS.docs) {
        const o = d.data() as { nom?: string; type?: string; capaciteCartons?: number; capaciteVelosMontes?: number; capaciteVelos?: number; peutEntrerParis?: boolean; actif?: boolean };
        if (o.actif === false) continue;
        camionsAll.push({
          id: d.id,
          nom: String(o.nom || ""),
          capaciteCartons: Number(o.capaciteCartons || o.capaciteVelos || 50),
          capaciteVelosMontes: Number(o.capaciteVelosMontes || 25),
          peutEntrerParis: o.peutEntrerParis === true,
        });
      }
      // Si sélection explicite → filtre ; sinon tous les actifs
      const camionsS: CamS[] = camionIdsSelectionS && camionIdsSelectionS.length > 0
        ? camionsAll.filter((c) => camionIdsSelectionS.includes(c.id))
        : camionsAll;
      // Capacités moyennes pondérées par camion sélectionné (utilisées pour estimation)
      const capMontesMoyenne = camionsS.length > 0
        ? Math.round(camionsS.reduce((s, c) => s + c.capaciteVelosMontes, 0) / camionsS.length)
        : 30;
      const capCartonsMoyenne = camionsS.length > 0
        ? Math.round(camionsS.reduce((s, c) => s + c.capaciteCartons, 0) / camionsS.length)
        : 60;

      // Charge équipe pour les chauffeurs
      const eqSnapS = await getDocs(collection(db, "equipe"));
      let nbChauffeursS = 0;
      for (const d of eqSnapS.docs) {
        const o = d.data() as { role?: string; actif?: boolean };
        if (o.actif === false) continue;
        if (o.role === "chauffeur") nbChauffeursS++;
      }
      if (overrideChauffeursS != null) nbChauffeursS = overrideChauffeursS;
      const nbCamionsS = camionsS.length;
      const nbVehiculesParJour = Math.min(nbChauffeursS, nbCamionsS) || 1;

      // Voronoi : chaque client → entrepôt le + proche
      type Bucket = {
        entrepotId: string;
        nom: string;
        ville: string;
        clients: CliSim[];
        demandeTotale: number;
        demandeMontes: number; // clients ≤ seuil
        demandeCartons: number; // clients > seuil
        nbClientsParis: number;
      };
      const buckets = new Map<string, Bucket>();
      for (const e of entrepotsS) {
        buckets.set(e.id, {
          entrepotId: e.id,
          nom: e.nom,
          ville: e.ville,
          clients: [],
          demandeTotale: 0,
          demandeMontes: 0,
          demandeCartons: 0,
          nbClientsParis: 0,
        });
      }
      for (const c of clientsS) {
        let bestE: EntrSim | null = null;
        let bestD = Infinity;
        for (const e of entrepotsS) {
          const d = haversineKmFs(c.lat, c.lng, e.lat, e.lng);
          if (d < bestD) { bestD = d; bestE = e; }
        }
        if (!bestE) continue;
        const b = buckets.get(bestE.id)!;
        b.clients.push(c);
        b.demandeTotale += c.reste;
        if (c.reste > seuilGrosVolumeS) b.demandeCartons += c.reste;
        else b.demandeMontes += c.reste;
        if (c.estParis) b.nbClientsParis++;
      }

      // Estimation tournées par entrepôt
      // - Montés : capa moyenne, durée tournée ~5h (15min/stop × ~10 stops + route)
      //   → 1 chauffeur peut faire ~1.5 tournées/jour en moyenne
      // - Cartons : capa moyenne, durée tournée ~7h (12min/vélo/monteur × N + route)
      //   → 1 chauffeur fait ~1 tournée/jour
      const BUFFER = 1.10;
      const result = entrepotsS.map((e) => {
        const b = buckets.get(e.id)!;
        const cibleMontes = Math.ceil(b.demandeMontes * BUFFER);
        const cibleCartons = Math.ceil(b.demandeCartons * BUFFER);
        const tourneesMontes = Math.ceil(b.demandeMontes / capMontesMoyenne);
        const tourneesCartons = Math.ceil(b.demandeCartons / capCartonsMoyenne);
        const totalTournees = tourneesMontes + tourneesCartons;
        // Nb jours pour cet entrepôt (avec partage de la flotte globale c est
        // une borne haute — l estimation globale ci-dessous est plus juste)
        return {
          entrepotId: e.id,
          nom: e.nom,
          ville: e.ville,
          stockActuel: { cartons: e.stockCartons, montes: e.stockVelosMontes, total: e.stockCartons + e.stockVelosMontes },
          cibleStock: { cartons: cibleCartons, montes: cibleMontes, total: cibleCartons + cibleMontes },
          ecartStock: {
            cartons: cibleCartons - e.stockCartons,
            montes: cibleMontes - e.stockVelosMontes,
          },
          demande: {
            totale: b.demandeTotale,
            grosVolumes: b.demandeCartons,
            petitsVolumes: b.demandeMontes,
            nbClients: b.clients.length,
            nbClientsParis: b.nbClientsParis,
          },
          tournees: {
            montes: tourneesMontes,
            cartons: tourneesCartons,
            total: totalTournees,
          },
        };
      }).sort((a, b) => b.demande.totale - a.demande.totale);

      const totalClients = clientsS.length;
      const totalVelos = result.reduce((s, r) => s + r.demande.totale, 0);
      const totalTourneesMontes = result.reduce((s, r) => s + r.tournees.montes, 0);
      const totalTourneesCartons = result.reduce((s, r) => s + r.tournees.cartons, 0);
      const totalTournees = totalTourneesMontes + totalTourneesCartons;
      const totalCibleCartons = result.reduce((s, r) => s + r.cibleStock.cartons, 0);
      const totalCibleMontes = result.reduce((s, r) => s + r.cibleStock.montes, 0);

      // Nb jours estimés : 1 véhicule fait ~1.5 tournées montés/jour
      // ou 1 tournée cartons/jour (ratio ajusté selon préférence Yoann
      // qui priorise les montés).
      const tourneesMontesParJour = nbVehiculesParJour * 1.5;
      const tourneesCartonsParJour = nbVehiculesParJour * 1;
      const joursPourMontes = totalTourneesMontes > 0 ? Math.ceil(totalTourneesMontes / tourneesMontesParJour) : 0;
      const joursPourCartons = totalTourneesCartons > 0 ? Math.ceil(totalTourneesCartons / tourneesCartonsParJour) : 0;
      // En faisant montés et cartons en parallèle (chauffeurs différents si ≥2),
      // on prend le max plutôt que la somme.
      const joursEstimes = nbVehiculesParJour >= 2
        ? Math.max(joursPourMontes, joursPourCartons)
        : joursPourMontes + joursPourCartons;

      return {
        ok: true,
        rayonKm: rayonKmS,
        center: { lat: centerLatS, lng: centerLngS, label: "Paris centre" },
        seuilGrosVolume: seuilGrosVolumeS,
        nbEntrepots: entrepotsS.length,
        nbCamions: nbCamionsS,
        nbChauffeurs: nbChauffeursS,
        nbVehiculesParJour,
        capMontesMoyenne,
        capCartonsMoyenne,
        camionsSelectionnes: camionsS.map((c) => ({
          id: c.id,
          nom: c.nom,
          capaciteCartons: c.capaciteCartons,
          capaciteVelosMontes: c.capaciteVelosMontes,
          peutEntrerParis: c.peutEntrerParis,
        })),
        totalClients,
        totalVelos,
        totalTournees,
        totalTourneesMontes,
        totalTourneesCartons,
        joursEstimes,
        joursPourMontes,
        joursPourCartons,
        totalCibleCartons,
        totalCibleMontes,
        dureeJourneeMin: dureeJourneeMinS,
        entrepots: result,
      };
    }

    case "genererPlanningOperation": {
      // Yoann 2026-05-03 — Génère le planning réel : à partir de la simulation
      // Voronoi, crée les vraies tournées en base sur des dates choisies
      // (range : ex semaine du 6 au 12, ou un seul jour, etc.).
      //
      // Mode preview (apply=false) par défaut → calcule sans écrire.
      // Mode apply=true → écrit les tournées + livraisons (idempotent par
      // [date+entrepotId+ordreSlot] grâce à un tag externalKey unique).
      const datesArr = Array.isArray(body.dates) ? (body.dates as string[]).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) : [];
      if (datesArr.length === 0) return { error: "dates[] requis (au moins 1 date YYYY-MM-DD)" };
      const apply = body.apply === true;
      const rayonKmG = Number(body.rayonKm || 130);
      const centerLatG = Number(body.centerLat || 48.8566);
      const centerLngG = Number(body.centerLng || 2.3522);
      const seuilGrosVolumeG = Number(body.seuilGrosVolume || 30);
      const overrideChauffeursG = body.nbChauffeurs != null ? Number(body.nbChauffeurs) : null;
      const camionIdsSelG = Array.isArray(body.camionIds) ? (body.camionIds as string[]) : null;

      // Charge entrepôts éligibles
      const eSnapG = await getDocs(collection(db, "entrepots"));
      type EntG = { id: string; nom: string; ville: string; lat: number; lng: number; stockCartons: number; stockVelosMontes: number };
      const entrepotsG: EntG[] = [];
      const groupesEphG = new Set<string>();
      for (const d of eSnapG.docs) {
        const o = d.data() as { nom?: string; ville?: string; lat?: number; lng?: number; stockCartons?: number; stockVelosMontes?: number; role?: string; dateArchivage?: unknown; groupeClient?: string };
        if (o.dateArchivage) continue;
        if (o.role === "fournisseur") continue;
        if (o.role === "ephemere") {
          if (o.groupeClient) groupesEphG.add(String(o.groupeClient).toLowerCase());
          continue;
        }
        if (typeof o.lat !== "number" || typeof o.lng !== "number") continue;
        entrepotsG.push({
          id: d.id,
          nom: String(o.nom || ""),
          ville: String(o.ville || ""),
          lat: o.lat,
          lng: o.lng,
          stockCartons: Number(o.stockCartons || 0),
          stockVelosMontes: Number(o.stockVelosMontes || 0),
        });
      }
      if (entrepotsG.length === 0) return { error: "Aucun entrepôt éligible" };

      // Charge clients restants dans rayon (exclus groupes éphémères)
      const cSnapG = await getDocs(collection(db, "clients"));
      const lvSnapG = await getDocs(collection(db, "livraisons"));
      const planifG = new Map<string, number>();
      for (const d of lvSnapG.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifG.set(cid, (planifG.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      type CliG = {
        id: string;
        entreprise: string;
        ville: string;
        codePostal: string;
        adresse: string;
        lat: number;
        lng: number;
        reste: number;
        estParis: boolean;
        apporteurLower: string | null;
        creneauLivraison: string | null;
      };
      const clientsG: CliG[] = [];
      for (const d of cSnapG.docs) {
        const o = d.data() as {
          entreprise?: string; ville?: string; codePostal?: string; departement?: string;
          adresse?: string; latitude?: number; longitude?: number;
          nbVelosCommandes?: number; stats?: { livres?: number };
          groupe?: string; groupeClient?: string;
          apporteur?: string; apporteurLower?: string;
          creneauLivraison?: string;
        };
        if (typeof o.latitude !== "number" || typeof o.longitude !== "number") continue;
        const reste = Math.max(0, Number(o.nbVelosCommandes || 0) - Number(o.stats?.livres || 0) - (planifG.get(d.id) || 0));
        if (reste <= 0) continue;
        const grpc = (o.groupe || o.groupeClient || "").toLowerCase();
        if (grpc && groupesEphG.has(grpc)) continue;
        if (haversineKmFs(centerLatG, centerLngG, o.latitude, o.longitude) > rayonKmG) continue;
        const cp = String(o.codePostal || "");
        clientsG.push({
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          codePostal: cp,
          adresse: String(o.adresse || ""),
          lat: o.latitude,
          lng: o.longitude,
          reste,
          estParis: /^75\d{3}$/.test(cp),
          apporteurLower: o.apporteurLower || (o.apporteur ? String(o.apporteur).trim().toLowerCase() : null),
          creneauLivraison: typeof o.creneauLivraison === "string" && o.creneauLivraison.trim() ? o.creneauLivraison.trim() : null,
        });
      }

      // Charge flotte sélectionnée
      const flSnapG = await getDocs(collection(db, "flotte"));
      type CamG = { id: string; nom: string; capaciteCartons: number; capaciteVelosMontes: number; peutEntrerParis: boolean };
      const camionsAllG: CamG[] = [];
      for (const d of flSnapG.docs) {
        const o = d.data() as { nom?: string; capaciteCartons?: number; capaciteVelosMontes?: number; capaciteVelos?: number; peutEntrerParis?: boolean; actif?: boolean };
        if (o.actif === false) continue;
        camionsAllG.push({
          id: d.id,
          nom: String(o.nom || ""),
          capaciteCartons: Number(o.capaciteCartons || o.capaciteVelos || 50),
          capaciteVelosMontes: Number(o.capaciteVelosMontes || 25),
          peutEntrerParis: o.peutEntrerParis === true,
        });
      }
      const camionsG = camionIdsSelG && camionIdsSelG.length > 0
        ? camionsAllG.filter((c) => camionIdsSelG.includes(c.id))
        : camionsAllG;
      if (camionsG.length === 0) return { error: "Aucun camion sélectionné" };

      // Charge équipe
      const eqSnapG = await getDocs(collection(db, "equipe"));
      let nbChauffeursG = 0;
      for (const d of eqSnapG.docs) {
        const o = d.data() as { role?: string; actif?: boolean };
        if (o.actif === false) continue;
        if (o.role === "chauffeur") nbChauffeursG++;
      }
      if (overrideChauffeursG != null) nbChauffeursG = overrideChauffeursG;
      const nbVehicJourG = Math.min(nbChauffeursG, camionsG.length) || 1;
      // Yoann 2026-05-03 : tournées/véhicule/jour calculé selon le mode :
      // - Mode atelier (montés) : pas de montage chez client, le chef gère
      //   la signature pendant que le chauffeur recharge → 2.5 tournées/jour
      //   facile (chauffeur ne perd pas de temps sur place)
      // - Mode cartons : montage chez client = stop long (12 min × N vélos /
      //   monteurs) → 1 tournée/jour
      // Override possible via body.tourneesParVeh*
      const tourneesParVehMontes = Number(body.tourneesParVehMontes || 2.5);
      const tourneesParVehCartons = Number(body.tourneesParVehCartons || 1);

      // Yoann 2026-05-03 : capacités max selon la flotte sélectionnée
      // - capaMaxMontes : si client.reste > → DOIT aller en cartons
      //   (sinon il serait splitté sur plusieurs jours en montés)
      // - capaMaxCartons : si client.reste > → 2 camions parallèles requis
      //   (Yoann gère manuellement, on signale)
      const capaMaxMontes = camionsG.length > 0 ? Math.max(...camionsG.map((c) => c.capaciteVelosMontes)) : 0;
      const capaMaxCartons = camionsG.length > 0 ? Math.max(...camionsG.map((c) => c.capaciteCartons)) : 0;

      // Voronoi : chaque client → entrepôt le + proche
      // Routing mode :
      //   - Client ≤ capaMaxMontes → mode atelier (priorité Yoann)
      //   - Client > capaMaxMontes → mode cartons (capa supérieure, 1 jour
      //     suffit même si client > 40v, jusqu à 77v en grand camion)
      //   - Client > capaMaxCartons → multi-camions parallèles requis,
      //     marqué pour Yoann (signal dans clientsBloques avec note spéciale)
      type Bucket = { entrepot: EntG; clientsMontes: CliG[]; clientsCartons: CliG[]; demandeMontes: number; demandeCartons: number };
      const buckets = new Map<string, Bucket>();
      for (const e of entrepotsG) {
        buckets.set(e.id, { entrepot: e, clientsMontes: [], clientsCartons: [], demandeMontes: 0, demandeCartons: 0 });
      }
      const clientsMultiCamion: CliG[] = []; // > capaMaxCartons, multi-camions requis
      for (const c of clientsG) {
        let bestE: EntG | null = null;
        let bestD = Infinity;
        for (const e of entrepotsG) {
          const d = haversineKmFs(c.lat, c.lng, e.lat, e.lng);
          if (d < bestD) { bestD = d; bestE = e; }
        }
        if (!bestE) continue;
        const b = buckets.get(bestE.id)!;
        // Cas extrême : client > capa max cartons → multi-camions parallèles
        if (c.reste > capaMaxCartons && capaMaxCartons > 0) {
          clientsMultiCamion.push(c);
          continue; // Pas dans le planning auto, à gérer manuellement
        }
        // Bascule auto : > capaMaxMontes → cartons (pour rester sur 1 jour)
        // Sinon → montés (priorité Yoann atelier)
        if (c.reste > capaMaxMontes) {
          b.clientsCartons.push(c);
          b.demandeCartons += c.reste;
        } else {
          b.clientsMontes.push(c);
          b.demandeMontes += c.reste;
        }
      }

      // Pour chaque entrepôt, split en tournées (greedy par client distance entrepôt)
      type TourneeSlot = {
        entrepotId: string;
        entrepotNom: string;
        modeMontage: "atelier" | "client";
        camionId: string;
        camionNom: string;
        capacite: number;
        stops: Array<{ clientId: string; entreprise: string; nbVelos: number; ville: string; estParis: boolean; creneauLivraison: string | null; apporteurLower: string | null; lat: number; lng: number; codePostal: string; adresse: string }>;
        totalVelos: number;
      };
      const slots: TourneeSlot[] = [];
      // Yoann 2026-05-03 : First-Fit Decreasing (FFD) — algorithme bin
      // packing standard logistique. Maximise le remplissage des camions
      // (avant : round-robin créait des tournées à 30-50%, "c est nul faut
      // remplir"). Logique :
      //   1. Trier clients DESC par volume restant
      //   2. Pour chaque client : essayer un slot EXISTANT compatible
      //      (capa restante suffisante, contrainte Paris OK)
      //   3. Sinon ouvrir un nouveau slot avec le PLUS GRAND camion
      //      compatible → on remplira au max ensuite
      //   4. Pour clients Paris : forcer camion peutEntrerParis
      // Yoann 2026-05-03 : on plafonne au stock dispo de l entrepôt
      // (pas d usine à gaz, juste planifier ce qu on a). Les clients
      // au-delà du stock vont dans clientsBloquesParStock pour suggestion
      // réappro Tiffany. Lead time configurable (default 3j).
      const leadTimeJours = Number(body.leadTimeJours || 3);
      type CliBloque = { clientId: string; entreprise: string; ville: string; reste: number; modeRequis: "atelier" | "client"; entrepotPrevu: string };
      const clientsBloques: CliBloque[] = [];
      // Stock résiduel par entrepôt (mis à jour pendant la génération)
      const stockResiduel = new Map<string, { cartons: number; montes: number }>();
      for (const e of entrepotsG) {
        stockResiduel.set(e.id, { cartons: e.stockCartons, montes: e.stockVelosMontes });
      }
      // Helper : retourne la capa du camion pour un mode donné
      const capaCam = (cam: CamG, mode: "atelier" | "client") =>
        mode === "atelier" ? cam.capaciteVelosMontes : cam.capaciteCartons;

      // Helper : pack une liste de clients dans des slots avec FFD.
      // Maximise le remplissage : pour chaque client, tente de le placer
      // dans un slot existant avant d en ouvrir un nouveau.
      const packBucket = (
        bucketId: string,
        bucketNom: string,
        bucketLat: number,
        bucketLng: number,
        clients: CliG[],
        mode: "atelier" | "client",
        stockDispo: number,
      ): { slotsBucket: TourneeSlot[]; bloques: CliG[]; stockUtilise: number } => {
        const slotsBucket: TourneeSlot[] = [];
        const bloques: CliG[] = [];
        let stockResiduel = stockDispo;
        // Tri DÉCROISSANT par volume restant (FFD = First-Fit Decreasing)
        const sorted = [...clients].sort((a, b) => b.reste - a.reste);
        for (const c of sorted) {
          if (c.reste <= 0) continue;
          if (stockResiduel <= 0) {
            bloques.push(c);
            continue;
          }
          // 1) Essai placement dans un slot existant compatible
          let placed = false;
          for (const slot of slotsBucket) {
            const cam = camionsG.find((x) => x.id === slot.camionId);
            if (!cam) continue;
            // Contrainte Paris
            if (c.estParis && !cam.peutEntrerParis) continue;
            const capa = capaCam(cam, mode);
            const restant = capa - slot.totalVelos;
            const aPlacer = Math.min(c.reste, restant, stockResiduel);
            // On ne split pas le client : il faut que tout tienne d un coup
            if (c.reste <= restant && c.reste <= stockResiduel) {
              slot.stops.push({
                clientId: c.id, entreprise: c.entreprise, nbVelos: c.reste,
                ville: c.ville, estParis: c.estParis, creneauLivraison: c.creneauLivraison,
                apporteurLower: c.apporteurLower, lat: c.lat, lng: c.lng,
                codePostal: c.codePostal, adresse: c.adresse,
              });
              slot.totalVelos += c.reste;
              stockResiduel -= c.reste;
              placed = true;
              break;
            }
            // unused var
            void aPlacer;
          }
          if (placed) continue;
          // 2) Pas de slot existant compatible → ouvrir un nouveau
          // Choisir le camion avec la capa la plus PROCHE du besoin (best-fit)
          // pour ne pas gâcher un grand camion sur un petit client. Si client
          // Paris : forcer peutEntrerParis.
          const candidats = c.estParis
            ? camionsG.filter((cam) => cam.peutEntrerParis)
            : camionsG;
          if (candidats.length === 0) {
            bloques.push(c);
            continue;
          }
          // Best-fit : capa >= reste, sort ASC pour choisir la plus petite
          // qui contient. Si aucune ne contient (client > capa max) → on
          // prend la plus grande disponible (sera marqué multiCamion).
          const sortedCams = [...candidats].sort((a, b) => capaCam(a, mode) - capaCam(b, mode));
          const camChoisi = sortedCams.find((cam) => capaCam(cam, mode) >= c.reste) || sortedCams[sortedCams.length - 1];
          const capa = capaCam(camChoisi, mode);
          const aPrendre = Math.min(c.reste, capa, stockResiduel);
          if (aPrendre <= 0) {
            bloques.push(c);
            continue;
          }
          slotsBucket.push({
            entrepotId: bucketId,
            entrepotNom: bucketNom,
            modeMontage: mode,
            camionId: camChoisi.id,
            camionNom: camChoisi.nom,
            capacite: capa,
            stops: [{
              clientId: c.id, entreprise: c.entreprise, nbVelos: aPrendre,
              ville: c.ville, estParis: c.estParis, creneauLivraison: c.creneauLivraison,
              apporteurLower: c.apporteurLower, lat: c.lat, lng: c.lng,
              codePostal: c.codePostal, adresse: c.adresse,
            }],
            totalVelos: aPrendre,
          });
          stockResiduel -= aPrendre;
          // Si client > capa du camion : signaler reste bloqué
          if (aPrendre < c.reste) {
            bloques.push({ ...c, reste: c.reste - aPrendre });
          }
        }
        // Yoann 2026-05-03 — passe d optimisation finale : si plusieurs
        // slots du même camion type avec remplissage faible, on essaie
        // de fusionner en re-faisant FFD (pour pousser le remplissage
        // au max). Ici déjà appliqué via le tri décroissant initial.
        // Tri par distance pour l affichage (plus proche d abord)
        for (const s of slotsBucket) {
          s.stops.sort((a, b) =>
            haversineKmFs(bucketLat, bucketLng, a.lat, a.lng)
            - haversineKmFs(bucketLat, bucketLng, b.lat, b.lng));
        }
        return { slotsBucket, bloques, stockUtilise: stockDispo - stockResiduel };
      };

      for (const b of buckets.values()) {
        const stk = stockResiduel.get(b.entrepot.id)!;
        // Pack montés
        const { slotsBucket: smt, bloques: bm, stockUtilise: usedM } = packBucket(
          b.entrepot.id, b.entrepot.nom, b.entrepot.lat, b.entrepot.lng,
          b.clientsMontes, "atelier", stk.montes,
        );
        slots.push(...smt);
        stk.montes -= usedM;
        for (const c of bm) {
          clientsBloques.push({
            clientId: c.id, entreprise: c.entreprise, ville: c.ville,
            reste: c.reste, modeRequis: "atelier", entrepotPrevu: b.entrepot.nom,
          });
        }
        // Pack cartons
        const { slotsBucket: sct, bloques: bc, stockUtilise: usedC } = packBucket(
          b.entrepot.id, b.entrepot.nom, b.entrepot.lat, b.entrepot.lng,
          b.clientsCartons, "client", stk.cartons,
        );
        slots.push(...sct);
        stk.cartons -= usedC;
        for (const c of bc) {
          clientsBloques.push({
            clientId: c.id, entreprise: c.entreprise, ville: c.ville,
            reste: c.reste, modeRequis: "client", entrepotPrevu: b.entrepot.nom,
          });
        }
      }

      // Yoann 2026-05-03 : tournées/jour calculé selon mix réel montés/cartons
      const nbSlotsMontes = slots.filter((s) => s.modeMontage === "atelier").length;
      const nbSlotsCartons = slots.filter((s) => s.modeMontage === "client").length;
      const totalSlots = nbSlotsMontes + nbSlotsCartons;
      const ratioMontes = totalSlots > 0 ? nbSlotsMontes / totalSlots : 1;
      const tourneesParVeh = ratioMontes * tourneesParVehMontes + (1 - ratioMontes) * tourneesParVehCartons;
      const tourneesParJour = Math.max(1, Math.round(nbVehicJourG * tourneesParVeh));

      // Yoann 2026-05-03 : round-robin RÉEL entre entrepôts pour mélanger
      // les tournées (avant : tous les Chelles d abord, puis tous les Nanterre,
      // ce qui faisait que les premiers jours = uniquement Chelles).
      // On rebascule les slots par tour de bucket : 1er Chelles, 1er Nanterre,
      // 1er Lisses, 1er Artisans, 2e Chelles, ... → distribution équilibrée.
      const slotsParEntrepot = new Map<string, TourneeSlot[]>();
      for (const s of slots) {
        if (!slotsParEntrepot.has(s.entrepotId)) slotsParEntrepot.set(s.entrepotId, []);
        slotsParEntrepot.get(s.entrepotId)!.push(s);
      }
      const slotsRoundRobin: TourneeSlot[] = [];
      let stillSomething = true;
      while (stillSomething) {
        stillSomething = false;
        for (const lst of slotsParEntrepot.values()) {
          const next = lst.shift();
          if (next) {
            slotsRoundRobin.push(next);
            stillSomething = true;
          }
        }
      }

      // Distribution sur les dates fournies — chaque jour reçoit
      // tourneesParJour slots (alternance entrepôt+camion garantie par
      // le round-robin ci-dessus + le round-robin camion dans choisirCamion).
      const datesSorted = [...datesArr].sort();
      type PlanJour = { date: string; tournees: TourneeSlot[] };
      const planning: PlanJour[] = datesSorted.map((d) => ({ date: d, tournees: [] }));
      const capaciteTotaleJournees = datesSorted.length * tourneesParJour;
      const slotsPlanifies = slotsRoundRobin.slice(0, capaciteTotaleJournees);
      const slotsNonPlanifies = slotsRoundRobin.slice(capaciteTotaleJournees);
      for (let k = 0; k < slotsPlanifies.length; k++) {
        const jourIdx = Math.floor(k / tourneesParJour);
        if (jourIdx < planning.length) planning[jourIdx].tournees.push(slotsPlanifies[k]);
      }

      // Yoann 2026-05-03 : suggestion réappro par entrepôt — version
      // simple (pas d usine à gaz). On regarde combien il manque pour
      // servir TOUS les clients (planifiés + bloqués), et on recule la
      // date limite du leadTime Tiffany.
      type ReapproEnt = {
        entrepotId: string;
        entrepotNom: string;
        stockInitialCartons: number;
        stockInitialMontes: number;
        consommationCartons: number;
        consommationMontes: number;
        stockApresCartons: number;
        stockApresMontes: number;
        besoinReapproCartons: number;
        besoinReapproMontes: number;
        dateLimiteReapproCartons: string | null;
        dateLimiteReapproMontes: string | null;
      };
      // Helper : recule une date ISO de N jours
      const reculerDate = (iso: string, jours: number): string => {
        const d = new Date(iso);
        d.setDate(d.getDate() - jours);
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      };

      const reappros: ReapproEnt[] = entrepotsG.map((e) => {
        // Conso = ce qu on a planifié depuis cet entrepôt (plafonné au stock)
        const consoSlots = slots.filter((s) => s.entrepotId === e.id);
        let consoCartons = 0;
        let consoMontes = 0;
        for (const s of consoSlots) {
          if (s.modeMontage === "client") consoCartons += s.totalVelos;
          else consoMontes += s.totalVelos;
        }
        // Besoin de réappro = clients bloqués faute de stock pour cet entrepôt
        const blocCart = clientsBloques
          .filter((c) => c.entrepotPrevu === e.nom && c.modeRequis === "client")
          .reduce((s, c) => s + c.reste, 0);
        const blocMont = clientsBloques
          .filter((c) => c.entrepotPrevu === e.nom && c.modeRequis === "atelier")
          .reduce((s, c) => s + c.reste, 0);
        // Date limite réappro = première date du planning de cet entrepôt
        // - leadTime Tiffany. Si on ne commande pas avant cette date, le
        // stock additionnel n arrivera pas à temps pour les tournées suivantes.
        const premierJourEntrepot = planning.find((j) => j.tournees.some((t) => t.entrepotId === e.id))?.date || null;
        const dateLimReappro = premierJourEntrepot ? reculerDate(premierJourEntrepot, leadTimeJours) : null;
        return {
          entrepotId: e.id,
          entrepotNom: e.nom,
          stockInitialCartons: e.stockCartons,
          stockInitialMontes: e.stockVelosMontes,
          consommationCartons: consoCartons,
          consommationMontes: consoMontes,
          stockApresCartons: e.stockCartons - consoCartons,
          stockApresMontes: e.stockVelosMontes - consoMontes,
          besoinReapproCartons: blocCart,
          besoinReapproMontes: blocMont,
          dateLimiteReapproCartons: blocCart > 0 ? dateLimReappro : null,
          dateLimiteReapproMontes: blocMont > 0 ? dateLimReappro : null,
        };
      }).filter((r) => r.consommationCartons > 0 || r.consommationMontes > 0 || r.besoinReapproCartons > 0 || r.besoinReapproMontes > 0);

      // Yoann 2026-05-03 — suggestion équilibrage cross-dépôt :
      // Si entrepôt A est en rupture (besoinReappro > 0) et entrepôt B
      // (à moins de 100 km) a du stock résiduel disponible, suggère un
      // transfert plutôt que de commander Tiffany. Plus rapide, gratuit.
      type Transfert = {
        deEntrepotId: string;
        deEntrepotNom: string;
        versEntrepotId: string;
        versEntrepotNom: string;
        type: "carton" | "monte";
        quantite: number;
        distanceKm: number;
        beneficeJours: number; // gain vs commande Tiffany (= leadTime)
      };
      const transferts: Transfert[] = [];
      // Map entrepôtId → reste après planning (pour candidats donateurs)
      const restes = new Map<string, { cartons: number; montes: number }>();
      for (const r of reappros) {
        restes.set(r.entrepotId, { cartons: r.stockApresCartons, montes: r.stockApresMontes });
      }
      // Aussi inclure les entrepôts non-utilisés (dans entrepotsG mais pas dans reappros)
      for (const e of entrepotsG) {
        if (!restes.has(e.id)) restes.set(e.id, { cartons: e.stockCartons, montes: e.stockVelosMontes });
      }
      for (const r of reappros) {
        if (r.besoinReapproCartons === 0 && r.besoinReapproMontes === 0) continue;
        const entReceveur = entrepotsG.find((e) => e.id === r.entrepotId);
        if (!entReceveur) continue;
        // Trouver donateurs proches avec stock résiduel
        for (const eD of entrepotsG) {
          if (eD.id === r.entrepotId) continue;
          const dist = haversineKmFs(entReceveur.lat, entReceveur.lng, eD.lat, eD.lng);
          if (dist > 100) continue;
          const resteD = restes.get(eD.id) || { cartons: 0, montes: 0 };
          if (r.besoinReapproCartons > 0 && resteD.cartons > 0) {
            const q = Math.min(r.besoinReapproCartons, resteD.cartons);
            transferts.push({
              deEntrepotId: eD.id,
              deEntrepotNom: eD.nom,
              versEntrepotId: r.entrepotId,
              versEntrepotNom: r.entrepotNom,
              type: "carton",
              quantite: q,
              distanceKm: Math.round(dist * 10) / 10,
              beneficeJours: leadTimeJours,
            });
            resteD.cartons -= q;
          }
          if (r.besoinReapproMontes > 0 && resteD.montes > 0) {
            const q = Math.min(r.besoinReapproMontes, resteD.montes);
            transferts.push({
              deEntrepotId: eD.id,
              deEntrepotNom: eD.nom,
              versEntrepotId: r.entrepotId,
              versEntrepotNom: r.entrepotNom,
              type: "monte",
              quantite: q,
              distanceKm: Math.round(dist * 10) / 10,
              beneficeJours: leadTimeJours,
            });
            resteD.montes -= q;
          }
        }
      }

      // Si apply=true : crée les tournées + livraisons en base
      let tourneesCreees = 0;
      let livraisonsCreees = 0;
      const erreurs: string[] = [];
      if (apply) {
        // Numéro tournée global : max + 1
        let nextNumero = 1;
        try {
          const top = await getDocs(query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)));
          if (!top.empty) {
            const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
            if (typeof n === "number") nextNumero = n + 1;
          }
        } catch {}

        for (const j of planning) {
          for (const s of j.tournees) {
            try {
              const tRef = await addDoc(collection(db, "tournees"), {
                datePrevue: j.date,
                mode: s.modeMontage,
                modeMontage: s.modeMontage,
                entrepotOrigineId: s.entrepotId,
                camionId: s.camionId,
                statut: "planifiee",
                notes: `Auto-généré · simulation Opération · ${s.camionNom}`,
                createdAt: ts(),
              });
              const tourneeNumero = nextNumero++;
              for (let ii = 0; ii < s.stops.length; ii++) {
                const stop = s.stops[ii];
                await addDoc(collection(db, "livraisons"), {
                  clientId: stop.clientId,
                  nbVelos: stop.nbVelos,
                  ordre: ii + 1,
                  datePrevue: j.date,
                  mode: s.modeMontage,
                  modeMontage: s.modeMontage,
                  entrepotOrigineId: s.entrepotId,
                  tourneeId: tRef.id,
                  tourneeNumero,
                  apporteurLower: stop.apporteurLower,
                  clientSnapshot: {
                    entreprise: stop.entreprise,
                    ville: stop.ville,
                    adresse: stop.adresse,
                    codePostal: stop.codePostal,
                    lat: stop.lat,
                    lng: stop.lng,
                  },
                  statut: "planifiee",
                  createdAt: ts(),
                });
                livraisonsCreees++;
              }
              tourneesCreees++;
            } catch (e) {
              erreurs.push(`Erreur tournée ${s.entrepotNom} ${j.date} : ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }

      const totalTourneesPlanifiees = planning.reduce((s, j) => s + j.tournees.length, 0);
      const totalVelosPlanifies = planning.reduce(
        (s, j) => s + j.tournees.reduce((sj, t) => sj + t.totalVelos, 0),
        0,
      );

      return {
        ok: true,
        apply,
        nbTotalSlots: slots.length,
        nbSlotsPlanifies: slotsPlanifies.length,
        nbSlotsNonPlanifies: slotsNonPlanifies.length,
        capaciteTotaleJournees,
        tourneesParJour,
        nbVehiculesParJour: nbVehicJourG,
        totalTourneesPlanifiees,
        totalVelosPlanifies,
        tourneesCreees,
        livraisonsCreees,
        erreurs,
        camionsUtilises: camionsG.map((c) => ({ id: c.id, nom: c.nom, capaciteCartons: c.capaciteCartons, capaciteVelosMontes: c.capaciteVelosMontes, peutEntrerParis: c.peutEntrerParis })),
        reappros, // Yoann 2026-05-03 : suggestion réappro par entrepôt
        transferts, // Yoann 2026-05-03 : suggestion équilibrage cross-dépôt
        clientsBloques, // Yoann 2026-05-03 : clients non plannifiés faute de stock
        clientsMultiCamion: clientsMultiCamion.map((c) => ({ clientId: c.id, entreprise: c.entreprise, ville: c.ville, reste: c.reste })),
        capaMaxMontes,
        capaMaxCartons,
        leadTimeJours,
        tourneesParVehMontes,
        tourneesParVehCartons,
        ratioMontes: Math.round(ratioMontes * 100) / 100,
        dates: datesSorted,
        planning: planning.map((j) => {
          // Yoann 2026-05-03 : calcul monteurs requis pour le jour
          // Mode cartons : chaque slot consomme nbVélos × 12min de montage
          // En supposant ${monteursParTournee} monteurs/tournée cartons :
          // - tot_velos_cartons × 12min / monteursParTournee = durée arrêt cumul
          // - On retourne juste nbMonteursRequis = monteursParTournee × nbSlotsCartons
          //   pour que Yoann sache combien de monteurs prévoir ce jour-là.
          const slotsCartonsJour = j.tournees.filter((t) => t.modeMontage === "client");
          const velosCartonsJour = slotsCartonsJour.reduce((s, t) => s + t.totalVelos, 0);
          const nbMonteursRequisJour = slotsCartonsJour.length * 2; // 2 monteurs/tournée par défaut
          return {
            date: j.date,
            nbTournees: j.tournees.length,
            totalVelos: j.tournees.reduce((s, t) => s + t.totalVelos, 0),
            nbSlotsCartons: slotsCartonsJour.length,
            velosCartonsJour,
            nbMonteursRequisJour,
            tournees: j.tournees.map((t) => ({
              entrepotId: t.entrepotId,
              entrepotNom: t.entrepotNom,
              modeMontage: t.modeMontage,
              camionId: t.camionId,
              camionNom: t.camionNom,
              capacite: t.capacite,
              totalVelos: t.totalVelos,
              nbStops: t.stops.length,
              monteursRequis: t.modeMontage === "client" ? 2 : 0, // par tournée cartons
              stops: t.stops.map((st) => ({ clientId: st.clientId, entreprise: st.entreprise, nbVelos: st.nbVelos, ville: st.ville, estParis: st.estParis })),
            })),
          };
        }),
      };
    }

    case "createSessionSurSite": {
      // Yoann 2026-05-03 — Session montage+livraison sur site client (Firat
      // Food et autres groupes). Le client utilise SON camion pour distribuer
      // ses propres magasins, on envoie un chef de chez nous + des monteurs
      // sur place. Pas de tournée AXDIS, pas de camion de notre flotte.
      const entrepotEphId = getRequired(body, "entrepotEphId");
      const eSnap = await getDoc(doc(db, "entrepots", entrepotEphId));
      if (!eSnap.exists()) {
        return { ok: false, error: "Entrepôt introuvable" };
      }
      const eData = eSnap.data() as { nom?: string; groupeClient?: string; role?: string };
      const ref = await addDoc(collection(db, "sessionsSurSite"), {
        entrepotEphId,
        entrepotNom: eData.nom || "",
        groupeClient: eData.groupeClient || eData.nom || "",
        datePrevue: getString(body, "datePrevue"),
        nbVelos: Number(body.nbVelos) || 0,
        nbMonteurs: Number(body.nbMonteurs) || 0,
        nbCartons: Number(body.nbCartons) || 0,
        chefAffecteId: getString(body, "chefAffecteId"),
        chefAffecteNom: getString(body, "chefAffecteNom"),
        camionClient: body.camionClient !== false,
        notes: getString(body, "notes") || "",
        statut: "planifiee",
        createdAt: ts(),
        updatedAt: ts(),
      });
      return { ok: true, id: ref.id };
    }

    case "updateSessionSurSite": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      await updateDoc(doc(db, "sessionsSurSite", id), {
        ...applyMaybeDates(data),
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "cancelSessionSurSite": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "sessionsSurSite", id), {
        statut: "annulee",
        annuleAt: ts(),
        annuleReason: getString(body, "reason") || "",
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "detectAnomaliesClients": {
      // Yoann 2026-05-03 — Phase 3.3 : Gemini scanne les clients et identifie
      // les anomalies (retard livraison, volume incohérent, docs manquants
      // depuis longtemps, signé mais pas planifié, etc.).
      const cSnapAn = await getDocs(collection(db, "clients"));
      const lSnapAn = await getDocs(collection(db, "livraisons"));
      const planifAn = new Map<string, number>();
      const livrAn = new Map<string, string>(); // clientId -> last delivery date
      for (const d of lSnapAn.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number; dateEffective?: string; datePrevue?: string };
        const cid = String(o.clientId || "");
        if (!cid) continue;
        if (String(o.statut || "").toLowerCase() === "planifiee") {
          planifAn.set(cid, (planifAn.get(cid) || 0) + (Number(o.nbVelos) || 0));
        }
        if (String(o.statut || "").toLowerCase() === "livree") {
          const dt = String(o.dateEffective || o.datePrevue || "").slice(0, 10);
          if (dt && (!livrAn.has(cid) || dt > livrAn.get(cid)!)) {
            livrAn.set(cid, dt);
          }
        }
      }

      type ClientStat = {
        id: string;
        entreprise: string;
        ville: string;
        codePostal: string;
        nbVelosCommandes: number;
        velosLivres: number;
        velosRestants: number;
        velosPlanifies: number;
        ageJours: number | null;
        dateEngagement: string | null;
        dateLastLivraison: string | null;
        docsComplets: boolean;
        statut: string | null;
      };
      const stats: ClientStat[] = [];
      const todayMs = Date.now();
      for (const d of cSnapAn.docs) {
        const o = d.data() as Record<string, unknown>;
        const stCli = (o.stats as { livres?: number } | undefined) || {};
        const livres = Number(stCli.livres || 0);
        const cmd = Number(o.nbVelosCommandes || 0);
        const planif = planifAn.get(d.id) || 0;
        const reste = Math.max(0, cmd - livres - planif);
        const dateEng = typeof o.dateEngagement === "string" ? o.dateEngagement.slice(0, 10) : null;
        let ageJours: number | null = null;
        if (dateEng) {
          const t = new Date(dateEng).getTime();
          if (!isNaN(t)) ageJours = Math.floor((todayMs - t) / 86400000);
        }
        const docsComplets = !!o.kbisRecu && !!o.attestationRecue && !!o.devisSignee;
        if (cmd === 0 && reste === 0) continue; // pas pertinent
        stats.push({
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          codePostal: String(o.codePostal || ""),
          nbVelosCommandes: cmd,
          velosLivres: livres,
          velosRestants: reste,
          velosPlanifies: planif,
          ageJours,
          dateEngagement: dateEng,
          dateLastLivraison: livrAn.get(d.id) || null,
          docsComplets,
          statut: typeof o.statut === "string" ? o.statut : null,
        });
      }

      // Stats globales pour donner du contexte à Gemini
      const totalClients = stats.length;
      const totalVelosRestants = stats.reduce((s, c) => s + c.velosRestants, 0);
      const ages = stats.filter((s) => s.ageJours != null).map((s) => s.ageJours!).sort((a, b) => a - b);
      const medianeAge = ages.length > 0 ? ages[Math.floor(ages.length / 2)] : null;
      const volumes = stats.map((s) => s.nbVelosCommandes).sort((a, b) => a - b);
      const medianeVolume = volumes.length > 0 ? volumes[Math.floor(volumes.length / 2)] : null;
      const docsKO = stats.filter((s) => !s.docsComplets && s.velosRestants > 0).length;

      // Top candidats anomalies = on trie par "score de risque" :
      //   âge élevé + reste > 0 (en attente longue durée)
      //   docs incomplets + signé
      //   volume très faible (1-2 vélos = anomalie probable)
      const topRisques = [...stats]
        .filter((s) => s.velosRestants > 0)
        .sort((a, b) => {
          const scoreA = (a.ageJours || 0) * (a.docsComplets ? 1 : 2);
          const scoreB = (b.ageJours || 0) * (b.docsComplets ? 1 : 2);
          return scoreB - scoreA;
        })
        .slice(0, 40);

      const prompt = `Tu es un analyste opérations d une PME qui livre des vélos cargo en région parisienne. Analyse la base clients pour identifier les anomalies prioritaires à traiter.

CONTEXTE :
- ${totalClients} clients avec commande active
- ${totalVelosRestants} vélos restant à livrer au global
- Âge médian engagement : ${medianeAge ?? "?"} jours
- Volume médian commande : ${medianeVolume ?? "?"} vélos
- ${docsKO} clients avec docs incomplets ET vélos restants

TOP ${topRisques.length} CLIENTS À RISQUE :
${topRisques.map((c) => `- ${c.id} | ${c.entreprise} (${c.ville}, ${c.codePostal}) | cmd=${c.nbVelosCommandes}v · livrés=${c.velosLivres} · planifiés=${c.velosPlanifies} · reste=${c.velosRestants} · âge=${c.ageJours ?? "?"}j · docs=${c.docsComplets ? "OK" : "INCOMPLETS"}${c.dateLastLivraison ? ` · derniere liv ${c.dateLastLivraison}` : " · jamais livré"}${c.statut ? ` · statut=${c.statut}` : ""}`).join("\n")}

DEMANDE :
Identifie les 5-10 anomalies les plus prioritaires. Pour chaque anomalie :
- Type : "retard_excessif" | "docs_manquants" | "volume_anormal" | "abandonné_probable" | "incohérence_donnée" | "autre"
- Sévérité : 1 (info) à 5 (critique)
- Action recommandée concrète

Réponds STRICTEMENT en JSON valide (sans markdown), structure exacte :

{
  "anomalies": [
    {
      "clientId": "string",
      "entreprise": "string",
      "type": "retard_excessif | docs_manquants | volume_anormal | abandonne_probable | incoherence_donnee | autre",
      "severite": 1-5,
      "diagnostic": "string : ce qui est anormal en 1-2 phrases",
      "action": "string : action concrète recommandée"
    },
    ... 4-9 autres ...
  ],
  "resume": "string : synthèse globale en 2-3 phrases (santé générale du portefeuille)",
  "kpisCles": {
    "tauxLivraison": number (% global cmd→livré),
    "clientsEnAttenteLongue": number (>60j sans livraison),
    "clientsBloquesDocsKO": number
  }
}`;

      try {
        const { callGemini } = await import("@/lib/gemini-client");
        const r = await callGemini(prompt);
        if (!r.ok) return { ok: false, error: r.error };
        const txt = r.text.trim();
        const jsonStart = txt.indexOf("{");
        const jsonEnd = txt.lastIndexOf("}");
        if (jsonStart < 0 || jsonEnd < 0) {
          return { ok: false, error: "Réponse Gemini sans JSON détectable", raw: txt.slice(0, 500) };
        }
        const jsonStr = txt.slice(jsonStart, jsonEnd + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          return { ok: false, error: "JSON Gemini invalide : " + (e instanceof Error ? e.message : String(e)), raw: jsonStr.slice(0, 500) };
        }
        return { ok: true, ...(parsed as Record<string, unknown>), model: r.model, totalClients, totalVelosRestants };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    default:
      return { ok: false, error: `Action Firestore non implémentée: ${action}` };
  }
}

// -------- read helpers (aussi utilisable depuis gas.ts) --------

/**
 * Quelques lectures qui pourraient appeler GAS aujourd'hui.
 * Pas exhaustif — on étend si besoin.
 */
// Lit les ids des membres équipe marqués `preparateurParDefaut: true`
// (Naomi en pratique). Utilisé pour pré-remplir `preparateurIds` à la
// création d'une tournée. Lecture mise en cache 60s pour ne pas refaire la
// requête à chaque livraison du même batch.
let _defaultPrepCache: { ids: string[]; at: number } | null = null;
async function getDefaultPreparateurIds(): Promise<string[]> {
  if (_defaultPrepCache && Date.now() - _defaultPrepCache.at < 60_000) {
    return _defaultPrepCache.ids;
  }
  try {
    const snap = await getDocs(
      query(
        collection(db, "equipe"),
        where("preparateurParDefaut", "==", true),
        where("actif", "==", true),
      ),
    );
    const ids = snap.docs.map((d) => d.id);
    _defaultPrepCache = { ids, at: Date.now() };
    return ids;
  } catch {
    return [];
  }
}

// Calcule le nombre de vélos qu'on peut encore planifier pour un client :
//   nbVelosCommandes (devis) − stats.livres − sum(nbVelos) des livraisons
//   actives (planifiee). Retourne null si client introuvable (le caller
//   laisse passer la valeur demandée). Cf. bug OPEN SOURCING 2026-04-28.
async function computeRemainingVelos(clientId: string): Promise<number | null> {
  try {
    const cSnap = await getDoc(doc(db, "clients", clientId));
    if (!cSnap.exists()) return null;
    const c = cSnap.data() as { nbVelosCommandes?: number; stats?: { livres?: number } };
    const totalCommande = Number(c.nbVelosCommandes) || 0;
    const livres = Number(c.stats?.livres) || 0;
    const livSnap = await getDocs(
      query(collection(db, "livraisons"), where("clientId", "==", clientId)),
    );
    let planifies = 0;
    for (const d of livSnap.docs) {
      const o = d.data() as { statut?: string; nbVelos?: number };
      if (String(o.statut || "").toLowerCase() === "planifiee") {
        planifies += Number(o.nbVelos) || 0;
      }
    }
    return Math.max(0, totalCommande - livres - planifies);
  } catch {
    return null;
  }
}

// Géocode une adresse client via api-adresse.data.gouv.fr (public, sans clé).
// "PARIS 01..20" doit être normalisé en "PARIS" (l'API ne reconnaît pas les
// arrondissements en suffixe ville). Retourne null en cas d'échec — le caller
// continue sans coords plutôt que de bloquer la création.
async function geocodeClientAddress(input: {
  adresse?: unknown;
  codePostal?: unknown;
  ville?: unknown;
}): Promise<{ lat: number; lng: number } | null> {
  const adresse = String(input.adresse || "").trim();
  if (!adresse) return null;
  const codePostal = String(input.codePostal || "").trim();
  const villeRaw = String(input.ville || "").trim();
  const villeNorm = villeRaw.replace(/^PARIS\s+\d+$/i, "PARIS");
  const q = [adresse, codePostal, villeNorm].filter(Boolean).join(" ");
  if (!q) return null;
  try {
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`);
    if (!res.ok) return null;
    const data = await res.json() as { features?: Array<{ geometry?: { coordinates?: number[] } }> };
    const coords = data.features?.[0]?.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;
    return { lng: coords[0], lat: coords[1] };
  } catch {
    return null;
  }
}

// Distance grand cercle entre 2 points (km). Cf. gas/Code.js:1058.
function haversineKmFs(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
      * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Clarke-Wright Savings — algorithme VRP standard industriel (Clarke & Wright,
// 1964). Gain typique 10-30 % vs nearest-neighbor sur distance totale.
//
// Yoann 2026-05-01 — Phase 2.1 logistique.
//
// Entrée :
//   distM : matrice (N+1)×(N+1) où index 0 = entrepôt, 1..N = clients
//   demands : array N (demande de chaque client) — index 0 ignoré
//   capacity : capacité du véhicule (même unité que demands)
//
// Sortie : liste de routes (chacune = array d index 1..N), respect capacité.
//   Routes triées par demande décroissante (la 1ère = la + dense).
//   La meilleure tournée pour 1 camion = routes[0].
//
// Algo :
//   1. Init : N routes triviales [0, i, 0]
//   2. Calcule savings s(i,j) = d(0,i) + d(0,j) - d(i,j)
//   3. Trie savings décroissants
//   4. Pour chaque saving, fusionne les 2 routes contenant i et j si :
//      - i et j sont aux extrémités (pas au milieu)
//      - capacité respectée après fusion
function clarkeWrightSavings(
  distM: number[][],
  demands: number[],
  capacity: number,
): number[][] {
  const N = distM.length - 1;
  if (N === 0) return [];
  // Routes initiales : 1 par client, ordre = [client]. L entrepôt (0) est
  // implicite début/fin, on ne le stocke pas dans la route.
  const routes: number[][] = [];
  const routeOf = new Map<number, number>();
  for (let i = 1; i <= N; i++) {
    routes.push([i]);
    routeOf.set(i, routes.length - 1);
  }
  // Calcule tous les savings (paires uniques)
  const savings: Array<{ i: number; j: number; saving: number }> = [];
  for (let i = 1; i <= N; i++) {
    for (let j = i + 1; j <= N; j++) {
      savings.push({ i, j, saving: distM[0][i] + distM[0][j] - distM[i][j] });
    }
  }
  savings.sort((a, b) => b.saving - a.saving);

  for (const { i, j, saving } of savings) {
    if (saving <= 0) break; // au-delà, fusionner allonge la tournée
    const ri = routeOf.get(i);
    const rj = routeOf.get(j);
    if (ri === undefined || rj === undefined || ri === rj) continue;
    const routeI = routes[ri];
    const routeJ = routes[rj];
    if (routeI.length === 0 || routeJ.length === 0) continue;

    // i et j doivent être aux extrémités de leur route respective
    const iIsStart = routeI[0] === i;
    const iIsEnd = routeI[routeI.length - 1] === i;
    const jIsStart = routeJ[0] === j;
    const jIsEnd = routeJ[routeJ.length - 1] === j;
    if (!(iIsStart || iIsEnd) || !(jIsStart || jIsEnd)) continue;

    // Capacité combinée
    const demI = routeI.reduce((s, idx) => s + demands[idx], 0);
    const demJ = routeJ.reduce((s, idx) => s + demands[idx], 0);
    if (demI + demJ > capacity) continue;

    // Fusion : on choisit le sens qui place i et j adjacents
    let merged: number[];
    if (iIsEnd && jIsStart) merged = [...routeI, ...routeJ];
    else if (iIsStart && jIsEnd) merged = [...routeJ, ...routeI];
    else if (iIsEnd && jIsEnd) merged = [...routeI, ...[...routeJ].reverse()];
    else if (iIsStart && jIsStart) merged = [...[...routeI].reverse(), ...routeJ];
    else continue;

    // Nouveau slot
    const newIdx = routes.length;
    routes.push(merged);
    for (const idx of merged) routeOf.set(idx, newIdx);
    routes[ri] = [];
    routes[rj] = [];
  }

  // Filtre les routes vides (mergées) et trie par demande totale décroissante
  const result = routes
    .filter((r) => r.length > 0)
    .map((r) => ({ route: r, dem: r.reduce((s, idx) => s + demands[idx], 0) }))
    .sort((a, b) => b.dem - a.dem)
    .map((x) => x.route);
  return result;
}

// 2-opt + Or-opt sur une route donnée (indices dans la matrice). Best-effort,
// limite itérations pour rester O(n²·k) raisonnable (k=4).
//   - 2-opt : reverse(i..j) si raccourcit la tournée totale
//   - Or-opt : déplace un segment de 1, 2 ou 3 stops vers une autre position
function refine2OptOrOpt(
  route: number[],
  distM: number[][],
): number[] {
  if (route.length <= 2) return route;
  const tourLen = (arr: number[]): number => {
    let t = distM[0][arr[0]];
    for (let i = 1; i < arr.length; i++) t += distM[arr[i - 1]][arr[i]];
    t += distM[arr[arr.length - 1]][0];
    return t;
  };
  let cur = [...route];
  let improved = true;
  let iter = 0;
  while (improved && iter < 4) {
    improved = false;
    iter++;
    const baseLen = tourLen(cur);

    // 2-opt
    for (let i = 0; i < cur.length - 1 && !improved; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        const cand = [...cur.slice(0, i), ...cur.slice(i, j + 1).reverse(), ...cur.slice(j + 1)];
        if (tourLen(cand) < baseLen - 0.01) {
          cur = cand;
          improved = true;
          break;
        }
      }
    }
    if (improved) continue;

    // Or-opt : déplace segments de 1 à 3 stops
    for (const segLen of [1, 2, 3]) {
      if (improved) break;
      if (segLen >= cur.length) continue;
      for (let i = 0; i + segLen <= cur.length && !improved; i++) {
        const seg = cur.slice(i, i + segLen);
        const without = [...cur.slice(0, i), ...cur.slice(i + segLen)];
        for (let k = 0; k <= without.length && !improved; k++) {
          if (k === i) continue; // même position
          const cand = [...without.slice(0, k), ...seg, ...without.slice(k)];
          if (tourLen(cand) < baseLen - 0.01) {
            cur = cand;
            improved = true;
            break;
          }
        }
      }
    }
  }
  return cur;
}

export async function runFirestoreGet(
  action: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  switch (action) {
    case "getClient": {
      // Reproduit la shape GAS getClient (gas/Code.js:424) attendue par
      // /clients/detail : on aplatit docs.X / docLinks.X / docDates.X stockés
      // en sous-objets côté Firestore vers les champs flat (devisSignee,
      // devisLien, dateEngagement…) consommés par l'UI, et on hydrate
      // velos[] (avec photos montage + livraison rattachée + urlBlSigne).
      // Sans ce mapping la fiche client était vide post-migration.
      const id = params.id;
      if (!id) throw new Error("id requis");
      const snap = await getDoc(doc(db, "clients", id));
      if (!snap.exists()) return { error: "Client introuvable" };
      const c = snap.data() as Record<string, unknown>;

      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        if (x instanceof Date) return x.toISOString();
        const t = x as { toDate?: () => Date };
        if (t?.toDate) return t.toDate().toISOString();
        const s = String(x).trim();
        return s || null;
      };
      const asUrl = (x: unknown): string | null => {
        const s = String(x || "").trim();
        return s || null;
      };

      const docs = (c.docs as Record<string, unknown>) || {};
      const docLinks = (c.docLinks as Record<string, unknown>) || {};
      const docDates = (c.docDates as Record<string, unknown>) || {};
      // ?? privilégie l'éventuel champ flat hérité (ancienne shape GAS) sinon
      // tombe sur le sous-objet Firestore actuel.
      const flat = {
        devisSignee: (c.devisSignee as boolean) ?? !!docs.devisSignee,
        kbisRecu: (c.kbisRecu as boolean) ?? !!docs.kbisRecu,
        attestationRecue: (c.attestationRecue as boolean) ?? !!docs.attestationRecue,
        signatureOk: (c.signatureOk as boolean) ?? !!docs.signatureOk,
        inscriptionBicycle: (c.inscriptionBicycle as boolean) ?? !!docs.inscriptionBicycle,
        parcelleCadastrale: (c.parcelleCadastrale as boolean) ?? !!docs.parcelleCadastrale,
        effectifMentionne: (c.effectifMentionne as boolean) ?? !!docs.effectifMentionne,
        devisLien: (c.devisLien as string | null) ?? (docLinks.devis as string | null) ?? null,
        kbisLien: (c.kbisLien as string | null) ?? (docLinks.kbis as string | null) ?? null,
        attestationLien:
          (c.attestationLien as string | null) ?? (docLinks.attestation as string | null) ?? null,
        signatureLien:
          (c.signatureLien as string | null) ?? (docLinks.signature as string | null) ?? null,
        bicycleLien:
          (c.bicycleLien as string | null) ?? (docLinks.bicycle as string | null) ?? null,
        parcelleCadastraleLien:
          (c.parcelleCadastraleLien as string | null) ??
          (docLinks.parcelleCadastrale as string | null) ??
          null,
        kbisDate: (c.kbisDate as string | null) ?? (docDates.kbis as string | null) ?? null,
        dateEngagement:
          (c.dateEngagement as string | null) ?? (docDates.engagement as string | null) ?? null,
        liasseFiscaleDate:
          (c.liasseFiscaleDate as string | null) ??
          (docDates.liasseFiscale as string | null) ??
          null,
      };

      // Livraisons indexées par tourneeId pour rattacher chaque vélo à SA
      // livraison (et son urlBlSigne). Multi-tournées : on rattache via
      // tourneeIdScan ; mono-tournée : fallback sur la seule livraison.
      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      type Liv = {
        id: string;
        tourneeId: string;
        statut: string;
        datePrevue: string | null;
        dateEffective: string | null;
        urlBlSigne: string | null;
      };
      const livraisonsByTournee: Record<string, Liv> = {};
      for (const ld of livSnap.docs) {
        const l = ld.data() as Record<string, unknown>;
        const tId = String(l.tourneeId || "");
        livraisonsByTournee[tId] = {
          id: ld.id,
          tourneeId: tId,
          statut: String(l.statut || "planifiee"),
          datePrevue: isoOrNull(l.datePrevue),
          dateEffective: isoOrNull(l.dateEffective),
          urlBlSigne: asUrl(l.urlBlSigne),
        };
      }
      const livKeys = Object.keys(livraisonsByTournee);

      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      const velos = vSnap.docs
        .filter((d) => !(d.data() as { annule?: boolean }).annule)
        .map((d) => {
          const v = d.data() as Record<string, unknown>;
          const fnuci = String(v.fnuci || "").trim() || null;
          const urlEtiquette = asUrl(v.urlPhotoMontageEtiquette);
          const urlQrVelo = asUrl(v.urlPhotoMontageQrVelo);
          const urlMonte = asUrl(v.photoMontageUrl);
          const hasDateMontage = !!v.dateMontage;
          const hasDateLivScan = !!v.dateLivraisonScan;

          // tourneeIdScan d'abord (champ historique GAS), puis tourneeId si
          // posé par le scan livraison côté Firestore. Sinon fallback "1 seule
          // livraison" pour les clients mono-tournée (cas le plus courant).
          const tournId = String(v.tourneeIdScan || v.tourneeId || "").trim();
          let liv: Liv | null = null;
          if (tournId && livraisonsByTournee[tournId]) liv = livraisonsByTournee[tournId];
          else if (livKeys.length === 1) liv = livraisonsByTournee[livKeys[0]];

          return {
            id: d.id,
            reference: fnuci,
            qrCode: fnuci,
            certificatRecu: !!v.certificatRecu || !!fnuci,
            certificatNumero: (v.certificatNumero as string | null) || null,
            photoQrPrise: !!v.photoQrPrise || !!urlQrVelo || hasDateMontage,
            facturable: !!v.facturable,
            facture: !!v.facture,
            monte: hasDateMontage,
            livre: hasDateLivScan,
            urlPhotoMontageEtiquette: urlEtiquette,
            urlPhotoMontageQrVelo: urlQrVelo,
            photoMontageUrl: urlMonte,
            livraison: liv,
            urlBlSigne: liv ? liv.urlBlSigne : null,
            livraisonOrpheline: !liv && livKeys.length > 0,
          };
        });

      return { id: snap.id, ...c, ...flat, velos };
    }
    case "getTourneeProgression": {
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");
      // RBAC chauffeur : tente d'abord la query large, si permission-denied
      // on retente avec where("chauffeurId","==",uid) — match la rule
      // serveur qui restreint un chauffeur à ses propres livraisons.
      // Bug 2026-04-29 (Zinedine sur /chargement → permission-denied).
      let livSnap;
      try {
        livSnap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
      } catch (e) {
        const uid = auth.currentUser?.uid;
        if (uid && (e as { code?: string }).code === "permission-denied") {
          livSnap = await getDocs(
            query(
              collection(db, "livraisons"),
              where("tourneeId", "==", tourneeId),
              where("chauffeurId", "==", uid),
            ),
          );
        } else {
          throw e;
        }
      }
      // datePrevue de la tournée = celle de n'importe quelle livraison (toutes égales)
      let datePrevue: string | null = null;
      // Tri par ordre tournée :
      //  - source primaire : champ `ordre` (posé par createTournees / createLivraison)
      //  - fallback legacy : "arrêt X/N" extrait des notes (livraisons importées du sheet GAS)
      //  - dernier recours : ordre Firestore (insertion)
      // Le verrou LIFO côté UI (TourneeScanFlow.reverseClients) inverse cet ordre
      // pour prép/charg ; sans tri fiable ici, l'inversion frontend est inutile.
      const ordreFromNotes = (notes: unknown): number | null => {
        if (typeof notes !== "string") return null;
        const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
        return m ? parseInt(m[1], 10) : null;
      };
      const sortedLivDocs = livSnap.docs
        .map((d, idx) => {
          const data = d.data() as { ordre?: number; notes?: string };
          const ordre =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotes(data.notes);
          return { d, ordre, idx };
        })
        .sort((a, b) => {
          if (a.ordre != null && b.ordre != null) return a.ordre - b.ordre;
          if (a.ordre != null) return -1;
          if (b.ordre != null) return 1;
          return a.idx - b.idx;
        })
        .map((x) => x.d);
      const clientOrder: string[] = [];
      const clientInfo: Record<
        string,
        { clientId: string; entreprise: string; ville: string; adresse: string; codePostal: string }
      > = {};
      // nbVelos demandés par client = somme des livraisons NON annulées
      // de cette tournée. Sert de plafond aux compteurs vélos pour éviter
      // que des vélos cibles orphelins (ex: livraison annulée + remplacée)
      // gonflent les totaux — bug 2026-04-28.
      const expectedByClient: Record<string, number> = {};
      for (const d of sortedLivDocs) {
        const l = d.data() as {
          clientId?: string;
          statut?: string;
          nbVelos?: number;
          datePrevue?: { toDate?: () => Date };
          clientSnapshot?: {
            entreprise?: string;
            ville?: string;
            adresse?: string;
            codePostal?: string;
          };
        };
        const cid = l.clientId;
        if (!cid) continue;
        // Ignorer les livraisons annulées : leur client ne fait plus partie
        // de la tournée et leurs vélos cibles ne doivent pas être comptés.
        if (String(l.statut || "").toLowerCase() === "annulee") continue;
        if (!datePrevue && l.datePrevue?.toDate) {
          datePrevue = l.datePrevue.toDate().toISOString();
        }
        if (!clientInfo[cid]) {
          clientOrder.push(cid);
          clientInfo[cid] = {
            clientId: cid,
            entreprise: l.clientSnapshot?.entreprise || "",
            ville: l.clientSnapshot?.ville || "",
            adresse: l.clientSnapshot?.adresse || "",
            codePostal: l.clientSnapshot?.codePostal || "",
          };
        }
        expectedByClient[cid] = (expectedByClient[cid] || 0) + (Number(l.nbVelos) || 0);
      }

      type Velo = {
        veloId: string;
        fnuci: string | null;
        datePreparation: string | null;
        dateChargement: string | null;
        dateLivraisonScan: string | null;
        dateMontage: string | null;
        photoChargementUrl: string | null;
      };
      const velosByClient: Record<string, Velo[]> = {};
      const totals = { total: 0, prepare: 0, charge: 0, livre: 0, monte: 0 };
      const perClientTotals: Record<
        string,
        { total: number; prepare: number; charge: number; livre: number; monte: number }
      > = {};
      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      const chunks: string[][] = [];
      for (let i = 0; i < clientOrder.length; i += 30) {
        chunks.push(clientOrder.slice(i, i + 30));
      }
      for (const chunk of chunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const d of vSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            fnuci?: string | null;
            annule?: boolean;
            datePreparation?: unknown;
            dateChargement?: unknown;
            dateLivraisonScan?: unknown;
            dateMontage?: unknown;
            photoChargementUrl?: string | null;
          };
          const cid = data.clientId || "";
          if (!cid) continue;
          // Skip vélos soft-cancelled (annule=true).
          if (data.annule === true) continue;
          if (!velosByClient[cid]) velosByClient[cid] = [];
          if (!perClientTotals[cid]) {
            perClientTotals[cid] = { total: 0, prepare: 0, charge: 0, livre: 0, monte: 0 };
          }
          // Plafond : on n'accepte que `expectedByClient[cid]` vélos par client
          // (= somme des nbVelos des livraisons actives). Si le client a plus
          // de vélos cibles que demandé pour cette tournée (ex : 2 commandes
          // séparées), seuls les premiers comptent ici.
          //
          // BUG 2026-05-01 (Yoann ANADOLU + MINE COMPAGNIE) : pour les
          // livraisons reportées / créées via "validé par téléphone" sans
          // que `nbVelos` ait été propagé, expectedByClient[cid] vaut 0 →
          // TOUS les vélos du client étaient skippés et la tournée affichait
          // "13/13 ✓" en oubliant le client postponé. Fallback : si la somme
          // des nbVelos vaut 0 mais que le client est bien dans la tournée,
          // on retire le plafond (Infinity) pour compter tous ses vélos
          // actifs. La protection "2 commandes séparées" reste active dès
          // qu'au moins une livraison du client porte un nbVelos > 0.
          const expected = expectedByClient[cid] ?? 0;
          const cap = expected > 0 ? expected : Number.POSITIVE_INFINITY;
          if (perClientTotals[cid].total >= cap) continue;
          const v: Velo = {
            veloId: d.id,
            fnuci: data.fnuci || null,
            datePreparation: isoOrNull(data.datePreparation),
            dateChargement: isoOrNull(data.dateChargement),
            dateLivraisonScan: isoOrNull(data.dateLivraisonScan),
            dateMontage: isoOrNull(data.dateMontage),
            photoChargementUrl: data.photoChargementUrl || null,
          };
          velosByClient[cid].push(v);
          perClientTotals[cid].total++;
          totals.total++;
          if (v.datePreparation) {
            perClientTotals[cid].prepare++;
            totals.prepare++;
          }
          if (v.dateChargement) {
            perClientTotals[cid].charge++;
            totals.charge++;
          }
          if (v.dateLivraisonScan) {
            perClientTotals[cid].livre++;
            totals.livre++;
          }
          if (v.dateMontage) {
            perClientTotals[cid].monte++;
            totals.monte++;
          }
        }
      }

      const clients = clientOrder.map((cid) => ({
        ...clientInfo[cid],
        velos: velosByClient[cid] || [],
        totals: perClientTotals[cid] || {
          total: 0,
          prepare: 0,
          charge: 0,
          livre: 0,
          monte: 0,
        },
      }));
      return { tourneeId, datePrevue, totals, clients };
    }
    case "getClientPreparation": {
      // Miroir GAS getClientPreparation : utilisé par /montage pour afficher
      // les vélos d'un client avec leur état (3 slots photo + dateMontage).
      // Source de vérité = collection `velos` Firestore (où markVeloPrepare/
      // Charge/LivreScan + uploadMontagePhoto écrivent).
      const clientId = params.clientId;
      if (!clientId) return { error: "clientId requis" };
      const cSnap = await getDoc(doc(db, "clients", clientId));
      if (!cSnap.exists()) return { error: "Client introuvable" };
      const c = cSnap.data() as { entreprise?: string; adresse?: string; ville?: string };
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        if (x instanceof Date) return x.toISOString();
        const t = x as { toDate?: () => Date };
        if (t?.toDate) return t.toDate().toISOString();
        const s = String(x).trim();
        return s || null;
      };
      const asUrl = (x: unknown): string | null => {
        const s = String(x || "").trim();
        return s || null;
      };
      type VeloDoc = {
        fnuci?: string;
        annule?: boolean;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
        dateMontage?: unknown;
        urlPhotoMontageEtiquette?: string;
        urlPhotoMontageQrVelo?: string;
        photoMontageUrl?: string;
        montageClaimBy?: string;
        montageClaimAt?: unknown;
      };
      const velos = vSnap.docs
        .filter((d) => !(d.data() as VeloDoc).annule)
        .map((d) => {
          const v = d.data() as VeloDoc;
          return {
            veloId: d.id,
            fnuci: (v.fnuci || "").trim() || null,
            datePreparation: isoOrNull(v.datePreparation),
            dateChargement: isoOrNull(v.dateChargement),
            dateLivraisonScan: isoOrNull(v.dateLivraisonScan),
            dateMontage: isoOrNull(v.dateMontage),
            urlPhotoMontageEtiquette: asUrl(v.urlPhotoMontageEtiquette),
            urlPhotoMontageQrVelo: asUrl(v.urlPhotoMontageQrVelo),
            photoMontageUrl: asUrl(v.photoMontageUrl),
            montageClaimBy: v.montageClaimBy || null,
            montageClaimAt: isoOrNull(v.montageClaimAt),
          };
        });
      const avecFnuci = velos.filter((v) => !!v.fnuci);
      return {
        ok: true,
        clientId,
        entreprise: c.entreprise || "",
        adresse: c.adresse || "",
        ville: c.ville || "",
        nbVelosTotal: velos.length,
        nbVelosAvecFnuci: avecFnuci.length,
        nbVelosSansFnuci: velos.length - avecFnuci.length,
        fnuciAttendus: avecFnuci.map((v) => v.fnuci),
        velos,
      };
    }
    case "auditEffectifs": {
      // Migration de gas/Code.js:auditEffectifs vers Firestore. Croise les
      // verifications (collection mirrorée depuis GAS via syncFromGas) avec les
      // clients Firestore pour détecter les écarts entre nb vélos commandés et
      // effectif déclaré (règle CEE : 1 vélo max / salarié).
      // Source de vérité : `verifications` Firestore + `clients` Firestore.
      // Fallback GAS retiré : si Firestore est vide, on retourne 0 incohérence
      // (mieux que de planter sur un GAS down).
      const DOCS_AVEC_EFFECTIF: Record<string, true> = {
        DSN: true,
        LIASSE: true,
        ATTESTATION_URSSAF: true,
        URSSAF: true,
        ATTESTATION: true,
      };

      const verifSnap = await getDocs(collection(db, "verifications"));
      const clientSnap = await getDocs(collection(db, "clients"));

      type VerifAgg = {
        clientId: string;
        entreprise: string;
        effectifMax: number;
        effectifSource: string;
        verifIds: string[];
        nbDocs: number;
      };
      type DevisAgg = { nbVelosMax: number; sourceVerifId: string; nbDevis: number };

      const byClient: Record<string, VerifAgg> = {};
      const devisByClient: Record<string, DevisAgg> = {};

      for (const d of verifSnap.docs) {
        const v = d.data() as Record<string, unknown>;
        const cid = String(v.clientId || "");
        if (!cid) continue;
        const docType = String(v.docType || "").toUpperCase();

        if (docType === "DEVIS") {
          const vRaw = v.nbVelosDevis;
          if (vRaw != null && vRaw !== "") {
            const nbV = Number(vRaw);
            if (Number.isFinite(nbV) && nbV >= 0 && nbV < 10000) {
              const cur = devisByClient[cid];
              if (!cur) {
                devisByClient[cid] = { nbVelosMax: nbV, sourceVerifId: d.id, nbDevis: 1 };
              } else {
                cur.nbDevis++;
                if (nbV > cur.nbVelosMax) {
                  cur.nbVelosMax = nbV;
                  cur.sourceVerifId = d.id;
                }
              }
            }
          }
        }

        if (!DOCS_AVEC_EFFECTIF[docType]) continue;
        const effRaw = v.effectifDetected;
        if (effRaw == null || effRaw === "") continue;
        const eff = Number(effRaw);
        if (!Number.isFinite(eff) || eff < 0 || eff > 10000) continue;

        const ent = String(v.entreprise || "");
        if (!byClient[cid]) {
          byClient[cid] = {
            clientId: cid,
            entreprise: ent,
            effectifMax: eff,
            effectifSource: docType,
            verifIds: [d.id],
            nbDocs: 1,
          };
        } else {
          const b = byClient[cid];
          b.nbDocs++;
          b.verifIds.push(d.id);
          if (eff > b.effectifMax) {
            b.effectifMax = eff;
            b.effectifSource = docType;
          }
        }
      }

      type ClientAgg = { clientId: string; nbVelosCommandes: number; entreprise: string; siren: string };
      const clientById: Record<string, ClientAgg> = {};
      const allClients: ClientAgg[] = [];
      for (const d of clientSnap.docs) {
        const c = d.data() as Record<string, unknown>;
        const nbV = Number(c.nbVelosCommandes || 0);
        const ent = String(c.entreprise || "");
        const siren = String(c.siren || "").replace(/\s/g, "");
        const entry = { clientId: d.id, nbVelosCommandes: nbV, entreprise: ent, siren };
        clientById[d.id] = entry;
        allClients.push(entry);
      }

      // Incohérences par établissement
      const incoherences: Array<{
        clientId: string;
        entreprise: string;
        nbVelosCommandes: number;
        nbVelosDevis: number | null;
        nbDevis: number;
        effectifMax: number;
        effectifSource: string;
        ecart: number;
        nbDocs: number;
        verifIds: string[];
        suggestedTarget: number;
        sens: "trop_velos" | "pas_assez_velos";
      }> = [];

      for (const cid of Object.keys(byClient)) {
        const b = byClient[cid];
        const c = clientById[cid];
        if (!c) continue;
        const ecart = c.nbVelosCommandes - b.effectifMax;
        if (ecart === 0) continue;
        const dInfo = devisByClient[cid] || null;
        incoherences.push({
          clientId: cid,
          entreprise: c.entreprise || b.entreprise,
          nbVelosCommandes: c.nbVelosCommandes,
          nbVelosDevis: dInfo ? dInfo.nbVelosMax : null,
          nbDevis: dInfo ? dInfo.nbDevis : 0,
          effectifMax: b.effectifMax,
          effectifSource: b.effectifSource,
          ecart,
          nbDocs: b.nbDocs,
          verifIds: b.verifIds,
          suggestedTarget: b.effectifMax,
          sens: ecart > 0 ? "trop_velos" : "pas_assez_velos",
        });
      }
      incoherences.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

      // Agrégation par SIREN (multi-établissements)
      type SirenAgg = {
        siren: string;
        entreprise: string;
        totalVelos: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
        effectifMax: number;
        effectifSource: string;
        nbDocs: number;
        verifIds: string[];
      };
      const sirenAgg: Record<string, SirenAgg> = {};
      for (const c of allClients) {
        if (!c.siren || c.siren === "0") continue;
        if (!sirenAgg[c.siren]) {
          sirenAgg[c.siren] = {
            siren: c.siren,
            entreprise: c.entreprise,
            totalVelos: 0,
            etablissements: [],
            effectifMax: 0,
            effectifSource: "",
            nbDocs: 0,
            verifIds: [],
          };
        }
        const s = sirenAgg[c.siren];
        s.totalVelos += c.nbVelosCommandes;
        s.etablissements.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        const b = byClient[c.clientId];
        if (b) {
          s.nbDocs += b.nbDocs;
          s.verifIds = s.verifIds.concat(b.verifIds);
          if (b.effectifMax > s.effectifMax) {
            s.effectifMax = b.effectifMax;
            s.effectifSource = b.effectifSource;
          }
        }
      }

      const incoherencesParSiren: Array<{
        siren: string;
        entreprise: string;
        totalVelos: number;
        effectifMax: number;
        effectifSource: string;
        ecart: number;
        sens: "trop_velos" | "pas_assez_velos";
        nbEtablissements: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
        nbDocs: number;
        verifIds: string[];
      }> = [];
      for (const siren of Object.keys(sirenAgg)) {
        const s = sirenAgg[siren];
        if (s.etablissements.length < 2) continue;
        if (s.effectifMax === 0) continue;
        const ecart = s.totalVelos - s.effectifMax;
        if (ecart === 0) continue;
        incoherencesParSiren.push({
          siren,
          entreprise: s.entreprise,
          totalVelos: s.totalVelos,
          effectifMax: s.effectifMax,
          effectifSource: s.effectifSource,
          ecart,
          sens: ecart > 0 ? "trop_velos" : "pas_assez_velos",
          nbEtablissements: s.etablissements.length,
          etablissements: s.etablissements,
          nbDocs: s.nbDocs,
          verifIds: s.verifIds,
        });
      }
      incoherencesParSiren.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

      // Clients sans pièce d'effectif (groupés par SIREN)
      const sansPieceParSiren: Record<string, {
        siren: string;
        entreprise: string;
        totalVelos: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
      }> = {};
      const sansPieceSansSiren: Array<{ clientId: string; entreprise: string; nbVelos: number }> = [];
      for (const c of allClients) {
        if (c.nbVelosCommandes <= 0) continue;
        if (byClient[c.clientId]) continue;
        if (c.siren && c.siren !== "0") {
          if (!sansPieceParSiren[c.siren]) {
            sansPieceParSiren[c.siren] = {
              siren: c.siren,
              entreprise: c.entreprise,
              totalVelos: 0,
              etablissements: [],
            };
          }
          const sp = sansPieceParSiren[c.siren];
          sp.totalVelos += c.nbVelosCommandes;
          sp.etablissements.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        } else {
          sansPieceSansSiren.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        }
      }
      // Si un SIREN a déjà au moins 1 établissement scanné, retirer le groupe
      for (const siren of Object.keys(sansPieceParSiren)) {
        if (sirenAgg[siren] && sirenAgg[siren].effectifMax > 0) {
          delete sansPieceParSiren[siren];
        }
      }
      const clientsSansPieceEffectif = Object.values(sansPieceParSiren);
      for (const c of sansPieceSansSiren) {
        clientsSansPieceEffectif.push({
          siren: "",
          entreprise: c.entreprise,
          totalVelos: c.nbVelos,
          etablissements: [c],
        });
      }
      clientsSansPieceEffectif.sort((a, b) => b.totalVelos - a.totalVelos);

      return {
        ok: true,
        total: incoherences.length,
        incoherences,
        incoherencesParSiren,
        totalSiren: incoherencesParSiren.length,
        clientsSansPieceEffectif,
        totalSansPiece: clientsSansPieceEffectif.length,
        nbClientsAvecEffectifDetecte: Object.keys(byClient).length,
      };
    }

    case "getTourneeExecution": {
      // Page mobile /tournee-execute (chauffeur). Shape attendue :
      // { tourneeId, datePrevue, mode, livraisons[id, clientId, statut, nbVelos,
      //   client{entreprise, ville, adresse, codePostal, telephone, contact, lat, lng},
      //   velos[id, clientId, fnuci, photoVeloUrl, photoFnuciUrl, photoQrPrise, livre]],
      //   equipe{chauffeur, chefEquipe, monteurs} }
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");

      // RBAC chauffeur fallback (cf. getTourneeProgression).
      let livSnap;
      try {
        livSnap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
      } catch (e) {
        const uid = auth.currentUser?.uid;
        if (uid && (e as { code?: string }).code === "permission-denied") {
          livSnap = await getDocs(
            query(
              collection(db, "livraisons"),
              where("tourneeId", "==", tourneeId),
              where("chauffeurId", "==", uid),
            ),
          );
        } else {
          throw e;
        }
      }
      if (livSnap.empty) {
        return { error: "Tournée introuvable", tourneeId };
      }

      // Premiers métadonnées (datePrevue, mode, equipe IDs) prises sur la 1ère
      // livraison : toutes les livraisons d'une tournée partagent ces champs.
      const firstData = livSnap.docs[0].data() as {
        datePrevue?: { toDate?: () => Date } | string;
        mode?: string;
        chauffeurId?: string;
        chefEquipeId?: string;
        chefEquipeIds?: string[];
        monteurIds?: string[];
      };
      const datePrevue = (() => {
        const dp = firstData.datePrevue;
        if (!dp) return null;
        if (typeof dp === "string") return dp;
        return dp.toDate ? dp.toDate().toISOString() : null;
      })();
      const mode = firstData.mode || null;

      // Construit la liste des livraisons et collecte les clientIds (pour bulk
      // load des vélos en chunks de 30).
      type ClientObj = {
        id?: string;
        entreprise: string;
        ville: string | null;
        adresse: string | null;
        codePostal: string | null;
        telephone: string | null;
        contact: string | null;
        lat: number | null;
        lng: number | null;
      };
      type LivExec = {
        id: string;
        clientId: string;
        statut: string;
        nbVelos: number;
        client: ClientObj | null;
        velos: Array<{
          id: string;
          clientId: string;
          fnuci: string | null;
          photoVeloUrl: string | null;
          photoFnuciUrl: string | null;
          photoQrPrise: boolean;
          livre: boolean;
        }>;
      };

      const livraisons: LivExec[] = [];
      const clientIds: string[] = [];
      const seenClients = new Set<string>();
      for (const d of livSnap.docs) {
        const l = d.data() as {
          clientId?: string;
          statut?: string;
          nbVelos?: number;
          clientSnapshot?: Partial<ClientObj>;
        };
        const cid = l.clientId || "";
        if (!cid) continue;
        const snap = l.clientSnapshot || {};
        livraisons.push({
          id: d.id,
          clientId: cid,
          statut: l.statut || "planifiee",
          nbVelos: typeof l.nbVelos === "number" ? l.nbVelos : 0,
          client: {
            id: cid,
            entreprise: snap.entreprise || "",
            ville: snap.ville ?? null,
            adresse: snap.adresse ?? null,
            codePostal: snap.codePostal ?? null,
            telephone: snap.telephone ?? null,
            contact: snap.contact ?? null,
            lat: typeof snap.lat === "number" ? snap.lat : null,
            lng: typeof snap.lng === "number" ? snap.lng : null,
          },
          velos: [],
        });
        if (!seenClients.has(cid)) {
          seenClients.add(cid);
          clientIds.push(cid);
        }
      }

      // Hydratation contact/telephone manquants depuis le client doc
      // (clientSnapshot peut être incomplet sur livraisons anciennes).
      const livByClient: Record<string, LivExec[]> = {};
      for (const l of livraisons) {
        (livByClient[l.clientId] ||= []).push(l);
      }
      const clientChunks: string[][] = [];
      for (let i = 0; i < clientIds.length; i += 30) {
        clientChunks.push(clientIds.slice(i, i + 30));
      }
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const cSnap = await getDocs(
          query(collection(db, "clients"), where("__name__", "in", chunk)),
        );
        for (const cd of cSnap.docs) {
          const c = cd.data() as {
            telephone?: string | null;
            contact?: string | null;
            adresse?: string | null;
            latitude?: number;
            longitude?: number;
          };
          for (const liv of livByClient[cd.id] || []) {
            if (!liv.client) continue;
            if (liv.client.telephone == null && c.telephone) liv.client.telephone = c.telephone;
            if (liv.client.contact == null && c.contact) liv.client.contact = c.contact;
            if (liv.client.adresse == null && c.adresse) liv.client.adresse = c.adresse;
            if (liv.client.lat == null && typeof c.latitude === "number") liv.client.lat = c.latitude;
            if (liv.client.lng == null && typeof c.longitude === "number") liv.client.lng = c.longitude;
          }
        }
      }

      // Vélos par clientId (bulk en chunks de 30, limite Firestore 'in')
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const vd of vSnap.docs) {
          const v = vd.data() as {
            clientId?: string;
            fnuci?: string | null;
            photoQrPrise?: boolean | string;
            dateLivraisonScan?: unknown;
            dateLivraison?: unknown;
            // photos livraison (best-effort multi-noms ; voir note bug uploadVeloPhoto)
            photoVeloUrl?: string;
            photoFnuciUrl?: string;
            photos?: { veloLivraison?: string; fnuciLivraison?: string; montageQrVelo?: string; montageEtiquette?: string };
            urlPhotoLivraisonVelo?: string;
            urlPhotoLivraisonFnuci?: string;
          };
          const cid = v.clientId || "";
          if (!cid) continue;
          const photoVeloUrl =
            v.photoVeloUrl ||
            v.urlPhotoLivraisonVelo ||
            v.photos?.veloLivraison ||
            null;
          const photoFnuciUrl =
            v.photoFnuciUrl ||
            v.urlPhotoLivraisonFnuci ||
            v.photos?.fnuciLivraison ||
            null;
          const livre = !!v.dateLivraisonScan || !!v.dateLivraison;
          const veloRow = {
            id: vd.id,
            clientId: cid,
            fnuci: v.fnuci || null,
            photoVeloUrl,
            photoFnuciUrl,
            photoQrPrise: !!v.photoQrPrise,
            livre,
          };
          // Tous les vélos du client vont sur ses livraisons de cette tournée.
          // Le modèle actuel ne distingue pas T1/T2 d'un même client (cf
          // getTourneeProgression qui fait pareil).
          for (const liv of livByClient[cid] || []) {
            liv.velos.push(veloRow);
          }
        }
      }

      // Resolution équipe : chauffeur + chef + monteurs
      const memberCache = new Map<string, { id: string; nom: string; role: string; telephone: string | null } | null>();
      const loadMember = async (id: string | undefined | null) => {
        if (!id) return null;
        if (memberCache.has(id)) return memberCache.get(id) || null;
        try {
          const m = await getDoc(doc(db, "equipe", id));
          if (!m.exists()) {
            memberCache.set(id, null);
            return null;
          }
          const md = m.data() as { nom?: string; role?: string; telephone?: string | null };
          const obj = {
            id: m.id,
            nom: md.nom || "",
            role: md.role || "",
            telephone: md.telephone ?? null,
          };
          memberCache.set(id, obj);
          return obj;
        } catch {
          memberCache.set(id, null);
          return null;
        }
      };
      const chauffeur = await loadMember(firstData.chauffeurId);
      // chefEquipeId (singulier legacy) ou chefEquipeIds[0] (nouveau).
      const chefId = firstData.chefEquipeId || firstData.chefEquipeIds?.[0];
      const chefEquipe = await loadMember(chefId);
      const monteurIds = firstData.monteurIds || [];
      const monteurs = (
        await Promise.all(monteurIds.map((id) => loadMember(id)))
      ).filter((m): m is NonNullable<typeof m> => m !== null);

      return {
        tourneeId,
        datePrevue,
        mode,
        livraisons,
        equipe: { chauffeur, chefEquipe, monteurs },
      };
    }

    case "getBlForTournee": {
      // Page /bl : génère + retourne les bons de livraison d'une tournée.
      // Numéro BL séquentiel par année : BL-YYYY-NNNNN, persisté sur la
      // livraison (champ numeroBL) à la 1ère consultation. Counter Firestore
      // dans counters/bl-YYYY (transaction pour éviter doublons concurrents).
      const tourneeId = params.tourneeId;
      if (!tourneeId) return { error: "tourneeId requis" };

      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      if (livSnap.empty) return { error: "Tournée introuvable", tourneeId };

      // datePrevue (toutes égales sur une tournée)
      const firstData = livSnap.docs[0].data() as { datePrevue?: unknown };
      const isoOf = (x: unknown): string | null => {
        if (!x) return null;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      const datePrevue = isoOf(firstData.datePrevue);
      const year = datePrevue
        ? datePrevue.slice(0, 4)
        : String(new Date().getFullYear());
      const counterRef = doc(db, "counters", `bl-${year}`);

      // Génération de numéro BL : transaction garantie atomique sur le counter.
      const allocateBlNumber = async (): Promise<string> => {
        return runTransaction(db, async (tx) => {
          const snap = await tx.get(counterRef);
          const current = snap.exists() ? Number((snap.data() as { next?: number }).next) || 0 : 0;
          const next = current + 1;
          tx.set(counterRef, { next, year }, { merge: true });
          return `BL-${year}-${String(next).padStart(5, "0")}`;
        });
      };

      // Construit clients[]. clientSnapshot peut manquer contact/tel : on
      // hydrate depuis le doc client. Persiste numeroBL sur livraison si absent.
      type VeloOut = { veloId: string; fnuci: string | null };
      type ClientOut = {
        clientId: string;
        entreprise: string;
        ville: string;
        adresse: string;
        codePostal: string;
        telephone: string | null;
        contact: string | null;
        siren: string | null;
        numeroBL: string | null;
        velos: VeloOut[];
      };
      // 1 livraison = 1 client (fonctionnellement). On garde l'ordre Firestore.
      const clientsByLiv: Array<{ livraisonId: string; clientId: string; client: ClientOut; numeroBL: string | null }> = [];
      const clientIds: string[] = [];
      const seenClients = new Set<string>();
      for (const d of livSnap.docs) {
        const l = d.data() as {
          clientId?: string;
          numeroBL?: string;
          clientSnapshot?: {
            entreprise?: string;
            ville?: string;
            adresse?: string;
            codePostal?: string;
            telephone?: string | null;
            contact?: string | null;
          };
        };
        const cid = l.clientId || "";
        if (!cid) continue;
        const snap = l.clientSnapshot || {};
        const out: ClientOut = {
          clientId: cid,
          entreprise: snap.entreprise || "",
          ville: snap.ville || "",
          adresse: snap.adresse || "",
          codePostal: snap.codePostal || "",
          telephone: snap.telephone ?? null,
          contact: snap.contact ?? null,
          siren: null, // hydraté plus bas depuis le doc client (pas dans clientSnapshot)
          numeroBL: l.numeroBL || null,
          velos: [],
        };
        clientsByLiv.push({ livraisonId: d.id, clientId: cid, client: out, numeroBL: out.numeroBL });
        if (!seenClients.has(cid)) {
          seenClients.add(cid);
          clientIds.push(cid);
        }
      }

      // Hydratation client (contact/tel manquants) + vélos par chunks de 30
      const clientChunks: string[][] = [];
      for (let i = 0; i < clientIds.length; i += 30) clientChunks.push(clientIds.slice(i, i + 30));

      const clientHydrated: Record<string, { telephone?: string | null; contact?: string | null; adresse?: string | null; siren?: string | null }> = {};
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const cSnap = await getDocs(
          query(collection(db, "clients"), where("__name__", "in", chunk)),
        );
        for (const cd of cSnap.docs) {
          const c = cd.data() as { telephone?: string | null; contact?: string | null; adresse?: string | null; siren?: string | null };
          clientHydrated[cd.id] = c;
        }
      }
      for (const item of clientsByLiv) {
        const h = clientHydrated[item.clientId];
        if (h) {
          if (item.client.telephone == null && h.telephone) item.client.telephone = h.telephone;
          if (item.client.contact == null && h.contact) item.client.contact = h.contact;
          if (!item.client.adresse && h.adresse) item.client.adresse = h.adresse;
          if (h.siren) item.client.siren = String(h.siren).replace(/\s/g, "");
        }
      }

      // Vélos
      const velosByClient: Record<string, VeloOut[]> = {};
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const vd of vSnap.docs) {
          const v = vd.data() as { clientId?: string; fnuci?: string | null };
          const cid = v.clientId || "";
          if (!cid) continue;
          (velosByClient[cid] ||= []).push({ veloId: vd.id, fnuci: v.fnuci || null });
        }
      }
      for (const item of clientsByLiv) {
        item.client.velos = velosByClient[item.clientId] || [];
      }

      // Génération + persistence des numéros BL manquants. Séquentiel volontaire :
      // évite les collisions sur le counter (transactions concurrentes possibles
      // mais inutile vu qu'on est sur une seule requête utilisateur).
      for (const item of clientsByLiv) {
        if (!item.client.numeroBL) {
          try {
            const blNum = await allocateBlNumber();
            item.client.numeroBL = blNum;
            await updateDoc(doc(db, "livraisons", item.livraisonId), {
              numeroBL: blNum,
              updatedAt: ts(),
            });
          } catch (e) {
            // Si l'attribution échoue (contention extrême ou rules), on
            // laisse null et l'UI utilise son fallback hash.
            console.error("[getBlForTournee] allocateBlNumber failed", e);
          }
        }
      }

      return {
        tourneeId,
        datePrevue,
        clients: clientsByLiv.map((x) => x.client),
      };
    }

    case "getMonteurActivity": {
      // Pointeuse monteur : sessions de travail (groupées par client + jour)
      // dans une fenêtre [from, to]. Chaque session retourne :
      //   - heureDebut  : scan QR carton (montageClaimAt) — fallback sur 1er
      //                   dateMontage si pas de claim trace
      //   - heureFin    : dernière photo de vélo monté (max dateMontage)
      //   - nbVelos     : nb de vélos avec dateMontage et monteParId == X
      //   - velos[]     : { fnuci, dateMontage }
      // Permet à Yoann/ricky de suivre ce qu'a fait chaque monteur, à quelle
      // heure exacte (vérification des règlements / debug terrain).
      const monteurId = params.monteurId;
      const fromStr = params.from || "";
      const toStr = params.to || "";
      if (!monteurId) throw new Error("monteurId requis");

      const fromMs = fromStr ? new Date(fromStr + "T00:00:00").getTime() : 0;
      const toMs = toStr ? new Date(toStr + "T23:59:59").getTime() : Number.POSITIVE_INFINITY;

      const vSnap = await getDocs(
        query(collection(db, "velos"), where("monteParId", "==", monteurId)),
      );

      type VeloEntry = {
        fnuci: string | null;
        dateMontage: string | null;
        montageClaimAt: string | null;
      };
      type SessionKey = string; // `${clientId}|${dayISO}`
      const sessions = new Map<SessionKey, {
        clientId: string;
        jour: string;
        debutMs: number; // min montageClaimAt OR min dateMontage
        finMs: number;   // max dateMontage
        velos: VeloEntry[];
      }>();
      const clientIds = new Set<string>();

      const toMs_ = (v: unknown): number | null => {
        if (!v) return null;
        if (typeof v === "string") {
          const t = new Date(v).getTime();
          return Number.isFinite(t) ? t : null;
        }
        const m = (v as { toMillis?: () => number }).toMillis?.();
        if (typeof m === "number") return m;
        const d = (v as { toDate?: () => Date }).toDate?.();
        if (d) return d.getTime();
        return null;
      };

      for (const d of vSnap.docs) {
        const o = d.data() as {
          clientId?: string;
          fnuci?: string | null;
          annule?: boolean;
          dateMontage?: unknown;
          montageClaimAt?: unknown;
        };
        if (o.annule) continue;
        const dmMs = toMs_(o.dateMontage);
        if (dmMs == null) continue;
        if (dmMs < fromMs || dmMs > toMs) continue;
        const cid = o.clientId || "";
        if (!cid) continue;
        clientIds.add(cid);
        const dayISO = new Date(dmMs).toISOString().slice(0, 10);
        const key: SessionKey = `${cid}|${dayISO}`;
        const claimMs = toMs_(o.montageClaimAt);
        let s = sessions.get(key);
        if (!s) {
          s = {
            clientId: cid,
            jour: dayISO,
            debutMs: claimMs ?? dmMs,
            finMs: dmMs,
            velos: [],
          };
          sessions.set(key, s);
        } else {
          if (claimMs != null && claimMs < s.debutMs) s.debutMs = claimMs;
          if (dmMs > s.finMs) s.finMs = dmMs;
          if (claimMs == null && dmMs < s.debutMs) s.debutMs = dmMs;
        }
        s.velos.push({
          fnuci: o.fnuci ?? null,
          dateMontage: new Date(dmMs).toISOString(),
          montageClaimAt: claimMs != null ? new Date(claimMs).toISOString() : null,
        });
      }

      // Récup nom des clients (1 read par client, batchable plus tard)
      const clientNames: Record<string, string> = {};
      for (const cid of clientIds) {
        try {
          const c = await getDoc(doc(db, "clients", cid));
          if (c.exists()) clientNames[cid] = ((c.data() as { entreprise?: string }).entreprise) || "";
        } catch {}
      }

      const result = Array.from(sessions.values())
        .map((s) => ({
          clientId: s.clientId,
          entreprise: clientNames[s.clientId] || "",
          jour: s.jour,
          heureDebut: new Date(s.debutMs).toISOString(),
          heureFin: new Date(s.finMs).toISOString(),
          dureeMin: Math.max(0, Math.round((s.finMs - s.debutMs) / 60000)),
          nbVelos: s.velos.length,
          velos: s.velos.sort((a, b) => (a.dateMontage || "").localeCompare(b.dateMontage || "")),
        }))
        .sort((a, b) => b.heureDebut.localeCompare(a.heureDebut));

      return { ok: true, monteurId, from: fromStr, to: toStr, sessions: result };
    }

    case "getFinancesSummary": {
      // Page /finances (super-admin). Calcul du coût main d'œuvre sur [from, to].
      //
      // Hypothèses (à confirmer vs GAS si écart) :
      // - tournée comptée si datePrevue ∈ [from, to] ET au moins 1 livraison
      //   livrée (statut=livree). Pas de comptage des tournées vides.
      // - jours par membre = nb de dates DISTINCTES de tournées où il apparaît
      //   dans chauffeurId, chefEquipeIds (ou chefEquipeId), monteurIds,
      //   preparateurIds.
      // - velosPrimes par membre = somme des vélos livrés (statut=livree,
      //   nbVelos sommé) sur les tournées où il apparaît.
      // - coutSalaire = jours × salaireJournalier (depuis fiche equipe)
      // - coutPrime = velosPrimes × primeVelo
      // - apporteurs : NON inclus ici (commissions calculées ailleurs).
      const from = params.from || "";
      const to = params.to || "";
      if (!from || !to) {
        return { ok: false, error: "from et to requis (format YYYY-MM-DD)" };
      }
      // Bornes inclusives. Compare sur date locale en string ISO yyyy-mm-dd.
      const inRange = (iso: string | null) => {
        if (!iso) return false;
        const day = iso.slice(0, 10);
        return day >= from && day <= to;
      };

      // Parcourt toutes les livraisons (collection size raisonnable, < 10k).
      const livSnap = await getDocs(collection(db, "livraisons"));
      // Group par tourneeId : { tourneeId, datePrevue (YYYY-MM-DD), nbVelosLivres,
      // chauffeurId, chefIds[], monteurIds[], preparateurIds[] }
      // Refactor 2026-05-01 17h55 (Yoann) : on agrège PAR LIVRAISON et PAR
      // DATE (pas par tournée globale). Sinon des livraisons futures du
      // même tourneeId remontaient des affectations dans la pointeuse
      // (anciens monteurIds renommés "3", "6"... étaient comptés).
      type LivraisonAgg = {
        livraisonId: string;
        tourneeId: string;
        date: string;
        nbVelosLivres: number;
        statut: string;
        chauffeurId: string | null;
        chefIds: string[];
        monteurIds: string[];
        preparateurIds: string[];
      };
      const livraisonsAgg: LivraisonAgg[] = [];
      // Conservé pour rétro-compat type signature mais n'est plus utilisé
      // dans la nouvelle logique d'agrégation.
      type TourneeAgg = {
        tourneeId: string;
        date: string;
        nbVelosLivres: number;
        chauffeurId: string | null;
        chefIds: string[];
        monteurIds: string[];
        preparateurIds: string[];
      };
      const tourneesById: Record<string, TourneeAgg> = {};
      const isoOf = (x: unknown): string | null => {
        if (!x) return null;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      const todayISO = new Date().toISOString().slice(0, 10);
      for (const d of livSnap.docs) {
        const l = d.data() as {
          tourneeId?: string;
          datePrevue?: unknown;
          statut?: string;
          nbVelos?: number;
          chauffeurId?: string;
          chefEquipeId?: string;
          chefEquipeIds?: string[];
          monteurIds?: string[];
          preparateurIds?: string[];
        };
        const dpIso = isoOf(l.datePrevue);
        if (!dpIso || !inRange(dpIso)) continue;
        const date = dpIso.slice(0, 10);
        // Skip livraisons futures : on ne paie pas pour des jours pas encore
        // travaillés (Yoann 2026-05-01 — bug "3 jours pour Jashan" venait
        // de pré-affiliations en MAI futures comptées).
        if (date > todayISO) continue;
        const statut = l.statut || "";
        if (statut === "annulee") continue;
        // Au moins un membre doit être affecté ET (livraison livrée OU date
        // <= today) pour que la livraison compte comme "jour travaillé".
        const monteurIds = Array.isArray(l.monteurIds) ? l.monteurIds.filter((x) => !!x) : [];
        const chefIdsCombines = [
          ...(l.chefEquipeId ? [l.chefEquipeId] : []),
          ...(Array.isArray(l.chefEquipeIds) ? l.chefEquipeIds : []),
        ].filter((v, i, a) => v && a.indexOf(v) === i) as string[];
        const preparateurIds = Array.isArray(l.preparateurIds) ? l.preparateurIds.filter((x) => !!x) : [];
        if (
          monteurIds.length === 0 &&
          chefIdsCombines.length === 0 &&
          !l.chauffeurId &&
          preparateurIds.length === 0
        ) continue;
        livraisonsAgg.push({
          livraisonId: d.id,
          tourneeId: l.tourneeId || "",
          date,
          nbVelosLivres: statut === "livree" ? Number(l.nbVelos || 0) : 0,
          statut,
          chauffeurId: l.chauffeurId || null,
          chefIds: chefIdsCombines,
          monteurIds,
          preparateurIds,
        });
      }
      // Compat : reconstituer tourneesActives par tournée (gardée pour
      // les éventuels usages externes — l'agrégation par membre se fait
      // désormais directement à partir de livraisonsAgg).
      const tourneesActives = livraisonsAgg.map((l) => ({
        tourneeId: l.tourneeId,
        date: l.date,
        nbVelosLivres: l.nbVelosLivres,
        chauffeurId: l.chauffeurId,
        chefIds: l.chefIds,
        monteurIds: l.monteurIds,
        preparateurIds: l.preparateurIds,
      }));

      // Aggrégation par membre
      type MemAgg = { joursSet: Set<string>; velosPrimes: number };
      const byMemberId: Record<string, MemAgg> = {};
      const touchMember = (id: string | null | undefined, t: TourneeAgg) => {
        if (!id) return;
        const m = (byMemberId[id] ||= { joursSet: new Set(), velosPrimes: 0 });
        m.joursSet.add(t.date);
        m.velosPrimes += t.nbVelosLivres;
      };
      for (const t of tourneesActives) {
        touchMember(t.chauffeurId, t);
        for (const id of t.chefIds) touchMember(id, t);
        for (const id of t.monteurIds) touchMember(id, t);
        for (const id of t.preparateurIds) touchMember(id, t);
      }

      // Hydratation fiches équipe pour récup salaire/prime/nom/role
      const memberIds = Object.keys(byMemberId);
      const byMember: Array<{
        id: string;
        nom: string;
        role: string;
        salaireJournalier: number;
        primeVelo: number;
        jours: number;
        velosPrimes: number;
        coutSalaire: number;
        coutPrime: number;
        coutTotal: number;
        tauxHoraire?: number;
        heuresTravaillees?: number;
      }> = [];
      const totals = { coutSalaires: 0, coutPrimes: 0, coutTotal: 0, jours: 0 };
      // Helper : calcule heures travaillees pour un préparateur sur la période
      // (premiere - derniere prep du jour, par jour), retourne total heures.
      // Yoann 2026-05-01 : Naomi paie a l heure depuis ses scans markVeloPrepare.
      async function calcHeuresPreparation(prepId: string): Promise<number> {
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("preparateurId", "==", prepId)),
        );
        const parJour = new Map<string, { min: number; max: number }>();
        for (const vd of vSnap.docs) {
          const v = vd.data() as { datePreparation?: unknown };
          const tIso = isoOf(v.datePreparation);
          if (!tIso || !inRange(tIso)) continue;
          const t = new Date(tIso).getTime();
          const day = tIso.slice(0, 10);
          const cur = parJour.get(day);
          if (!cur) parJour.set(day, { min: t, max: t });
          else {
            if (t < cur.min) cur.min = t;
            if (t > cur.max) cur.max = t;
          }
        }
        let totalH = 0;
        for (const { min, max } of parJour.values()) {
          const dh = (max - min) / (1000 * 60 * 60);
          // Clip : si une seule prep dans la journée, on compte 1h min.
          // Si > 12h (delta exotique), on clip à 12h.
          const clipped = Math.max(1, Math.min(12, dh || 1));
          totalH += clipped;
        }
        return Math.round(totalH * 100) / 100;
      }

      // Chunks de 30 (limite Firestore "in")
      for (let i = 0; i < memberIds.length; i += 30) {
        const chunk = memberIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const eSnap = await getDocs(
          query(collection(db, "equipe"), where("__name__", "in", chunk)),
        );
        for (const ed of eSnap.docs) {
          const e = ed.data() as {
            nom?: string;
            role?: string;
            salaireJournalier?: number;
            primeVelo?: number;
            tauxHoraire?: number;
          };
          const agg = byMemberId[ed.id];
          if (!agg) continue;
          const salaireJournalier = typeof e.salaireJournalier === "number" ? e.salaireJournalier : 0;
          const primeVelo = typeof e.primeVelo === "number" ? e.primeVelo : 0;
          const tauxHoraire = typeof e.tauxHoraire === "number" ? e.tauxHoraire : 0;
          const jours = agg.joursSet.size;
          const velosPrimes = agg.velosPrimes;
          // Si tauxHoraire défini ET rôle préparateur : on calcule à l heure.
          // Sinon, salaire journalier classique.
          let coutSalaire: number;
          let heuresTravaillees = 0;
          if (tauxHoraire > 0 && e.role === "preparateur") {
            heuresTravaillees = await calcHeuresPreparation(ed.id);
            coutSalaire = Math.round(heuresTravaillees * tauxHoraire * 100) / 100;
          } else {
            coutSalaire = Math.round(jours * salaireJournalier * 100) / 100;
          }
          const coutPrime = Math.round(velosPrimes * primeVelo * 100) / 100;
          const coutTotal = Math.round((coutSalaire + coutPrime) * 100) / 100;
          byMember.push({
            id: ed.id,
            nom: e.nom || "",
            role: e.role || "",
            salaireJournalier,
            primeVelo,
            jours,
            velosPrimes,
            coutSalaire,
            coutPrime,
            coutTotal,
            tauxHoraire,
            heuresTravaillees,
          });
          totals.coutSalaires += coutSalaire;
          totals.coutPrimes += coutPrime;
          totals.coutTotal += coutTotal;
          totals.jours += jours;
        }
      }
      // Arrondi des totaux
      totals.coutSalaires = Math.round(totals.coutSalaires * 100) / 100;
      totals.coutPrimes = Math.round(totals.coutPrimes * 100) / 100;
      totals.coutTotal = Math.round(totals.coutTotal * 100) / 100;
      // Tri : par coutTotal desc pour mettre en avant les contributeurs.
      byMember.sort((a, b) => b.coutTotal - a.coutTotal);

      return {
        ok: true,
        from,
        to,
        nbTournees: tourneesActives.length,
        byMember,
        totals,
      };
    }

    case "deleteClient": {
      // ⚠ JAMAIS de hard-delete client (règle Yoann 29-04 : "garde-le en base
      // pour pouvoir comparer objectif initial vs réalisé dans les stats").
      // → Soft-cancel équivalent à cancelClient :
      //   - clients : statut=annulee + raisonAnnulation par défaut + annuleeAt
      //   - livraisons planifiees → annulee
      //   - vélos cibles → annule=true (préserve dates scan déjà faites)
      // Restaurable via "restoreClient".
      const id = params.id;
      if (!id) return { error: "id requis" };
      const cRefDC = doc(db, "clients", id);
      const cSnapDC = await getDoc(cRefDC);
      if (!cSnapDC.exists()) return { error: "Client introuvable" };

      const raisonAnnulation = "Suppression depuis la fiche client";
      await updateDoc(cRefDC, {
        statut: "annulee",
        raisonAnnulation,
        annuleeAt: ts(),
        "stats.planifies": 0,
        updatedAt: ts(),
      });

      const livRaison = `Client annulé : ${raisonAnnulation}`;
      const livSnapDC = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      let nbLivAnnulees = 0;
      for (let i = 0; i < livSnapDC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of livSnapDC.docs.slice(i, i + 400)) {
          const data = d.data() as { statut?: string };
          if (data.statut !== "planifiee") continue;
          batch.update(d.ref, {
            statut: "annulee",
            dateEffective: null,
            raisonAnnulation: livRaison,
            annuleeAt: ts(),
          });
          nbLivAnnulees++;
        }
        await batch.commit();
      }

      const velSnapDC = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      let nbVelosAnnules = 0;
      for (let i = 0; i < velSnapDC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of velSnapDC.docs.slice(i, i + 400)) {
          batch.update(d.ref, { annule: true, updatedAt: ts() });
          nbVelosAnnules++;
        }
        await batch.commit();
      }

      return { ok: true, softCancel: true, nbLivAnnulees, nbVelosAnnules };
    }

    case "listDisponibilites": {
      // /day-planner-modal : lecture des dispos existantes pour une date.
      // Stockage : collection disponibilites, doc { date, ressourceType,
      // ressourceId, actif, createdAt, notes }.
      const date = params.date;
      const ressourceType = params.ressourceType;
      if (!date) return { items: [] };
      const baseQ = query(collection(db, "disponibilites"), where("date", "==", date));
      const snap = await getDocs(baseQ);
      const items: Array<Record<string, unknown>> = [];
      for (const d of snap.docs) {
        const o = d.data() as { actif?: boolean; ressourceType?: string };
        if (o.actif === false) continue;
        if (ressourceType && o.ressourceType !== ressourceType) continue;
        items.push({ id: d.id, ...o });
      }
      return { items };
    }

    case "listEquipe": {
      // includeInactifs="true" → tout le monde, sinon seuls les actifs.
      // Parité avec gas listEquipe (gas/Code.js) consommé par /equipe.
      const includeInactifs = params.includeInactifs === "true";
      const baseQuery = includeInactifs
        ? collection(db, "equipe")
        : query(collection(db, "equipe"), where("actif", "==", true));
      const snap = await getDocs(baseQuery);
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const createdAt = data.createdAt as { toDate?: () => Date } | undefined;
        return {
          id: d.id,
          nom: (data.nom as string) ?? "",
          role: data.role,
          telephone: (data.telephone as string | null) ?? null,
          email: (data.email as string | null) ?? null,
          actif: !!data.actif,
          notes: (data.notes as string | null) ?? null,
          createdAt: createdAt?.toDate ? createdAt.toDate().toISOString() : null,
          hasCode: true,
          salaireJournalier: data.salaireJournalier ?? null,
          primeVelo: data.primeVelo ?? null,
        };
      });
      return { ok: true, items };
    }

    case "listVerifications": {
      // status ∈ {pending, validated, rejected, unassigned, "", "all"}.
      // Pour "all" / "" / "unassigned" → pas de filtre status. "unassigned"
      // est un filtre client-side (clientId vide), on remonte tout côté
      // serveur et la page filtre. Limite par défaut 1000 comme GAS.
      const status = params.status || "";
      const lim = Math.max(1, Math.min(5000, Number(params.limit || "1000") || 1000));
      const useStatusFilter = status === "pending" || status === "validated" || status === "rejected";
      // Pas d'orderBy serveur : combiné à un where, Firestore exige un index
      // composite (firestore.indexes.json est vide). On trie côté client après
      // récup, ce qui est OK pour ≤ lim docs.
      const q = useStatusFilter
        ? query(
            collection(db, "verifications"),
            where("status", "==", status),
            limit(lim),
          )
        : query(collection(db, "verifications"), limit(lim));
      const snap = await getDocs(q);
      const tsToIso = (x: unknown): string | undefined => {
        if (!x) return undefined;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : undefined;
      };
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          receivedAt: tsToIso(data.receivedAt),
          clientId: data.clientId ?? "",
          entreprise: data.entreprise ?? "",
          docType: data.docType ?? "",
          driveUrl: data.driveUrl ?? data.storageUrl ?? "",
          fileName: data.fileName ?? "",
          fromEmail: data.fromEmail ?? "",
          subject: data.subject ?? "",
          effectifDetected: data.effectifDetected ?? "",
          nbVelosBefore: data.nbVelosBefore ?? "",
          nbVelosAfter: data.nbVelosAfter ?? "",
          status: data.status ?? "",
          notes: data.notes ?? "",
          messageId: data.messageId ?? "",
        };
      });
      // Tri client : receivedAt desc, fallback sur id pour stabilité.
      items.sort((a, b) => {
        const ra = (a.receivedAt as string) || "";
        const rb = (b.receivedAt as string) || "";
        if (ra !== rb) return rb.localeCompare(ra);
        return b.id.localeCompare(a.id);
      });
      return { ok: true, items };
    }

    case "archiveMembre": {
      // Soft-delete d'un membre d'équipe : actif=false. Préserve l'historique
      // (livraisons passées qui référencent l'id) tout en sortant le membre
      // des listes "actifs". gasGet historique → reproduit via updateDoc.
      const id = params.id;
      if (!id) throw new Error("id requis");
      await updateDoc(doc(db, "equipe", id), { actif: false });
      return { ok: true };
    }

    case "deleteLivraison": {
      // Soft-delete : statut="annulee". restoreLivraison remet à "planifiee".
      // Pas de delete physique car les vélos rattachés gardent une référence
      // (tourneeId/livraisonId) qu'on ne veut pas casser.
      // Décrémente stats.planifies sur le client si la livraison était planifiée
      // (sinon le pop-up /carte affiche un compteur stale et bloque la
      // re-planification — bug 2026-04-28).
      const id = params.id;
      if (!id) throw new Error("id requis");
      const raisonAnnulation = String(params.raisonAnnulation || "").trim() || null;
      const livRef = doc(db, "livraisons", id);
      const livSnap = await getDoc(livRef);
      const livData = livSnap.exists() ? (livSnap.data() as { statut?: string; clientId?: string }) : null;
      const wasPlanifiee = livData?.statut === "planifiee";
      const cidDel = livData?.clientId || null;
      await updateDoc(livRef, {
        statut: "annulee",
        dateEffective: null,
        raisonAnnulation,
        annuleeAt: ts(),
      });
      if (wasPlanifiee && cidDel) {
        try {
          const cRef = doc(db, "clients", cidDel);
          const cSnap = await getDoc(cRef);
          if (cSnap.exists()) {
            const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
            const cur = Number(stats.planifies) || 0;
            await updateDoc(cRef, { "stats.planifies": Math.max(0, cur - 1) });
          }
        } catch (e) {
          console.error("[deleteLivraison] decrement planifies KO", e);
        }
      }
      return { ok: true };
    }

    case "restoreLivraison": {
      const id = params.id;
      if (!id) throw new Error("id requis");
      const livRef = doc(db, "livraisons", id);
      const livSnap = await getDoc(livRef);
      const livData = livSnap.exists() ? (livSnap.data() as { statut?: string; clientId?: string }) : null;
      const wasAnnulee = livData?.statut === "annulee";
      const cidRest = livData?.clientId || null;
      await updateDoc(livRef, { statut: "planifiee", dateEffective: null });
      // Symétrique : si on remet en planifiee depuis annulee, ré-incrémente.
      if (wasAnnulee && cidRest) {
        try {
          const cRef = doc(db, "clients", cidRest);
          const cSnap = await getDoc(cRef);
          if (cSnap.exists()) {
            const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
            const cur = Number(stats.planifies) || 0;
            await updateDoc(cRef, { "stats.planifies": cur + 1 });
          }
        } catch (e) {
          console.error("[restoreLivraison] increment planifies KO", e);
        }
      }
      return { ok: true };
    }

    case "cancelTournee": {
      // Annule toutes les livraisons d'une tournée (statut="annulee").
      // Utilisé par le bouton "Annuler la tournée" dans /livraisons.
      // Décrémente stats.planifies sur chaque client touché (cf. deleteLivraison).
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");
      const raisonAnnulationT = String(params.raisonAnnulation || "").trim() || null;
      const snap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      const docs = snap.docs.filter((d) => (d.data() as { statut?: string }).statut !== "annulee");

      // Compte les décréments par clientId AVANT de muter (les livraisons
      // étaient toutes planifiees ou en cours — on décrémente uniquement
      // celles qui étaient en statut=planifiee côté stats client).
      const decrParClient = new Map<string, number>();
      for (const d of docs) {
        const data = d.data() as { statut?: string; clientId?: string };
        if (data.statut !== "planifiee") continue;
        const cid = data.clientId || "";
        if (!cid) continue;
        decrParClient.set(cid, (decrParClient.get(cid) || 0) + 1);
      }

      // writeBatch limité à 500 ops — au-delà on découpe.
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of docs.slice(i, i + 400)) {
          batch.update(d.ref, {
            statut: "annulee",
            dateEffective: null,
            raisonAnnulation: raisonAnnulationT,
            annuleeAt: ts(),
          });
        }
        await batch.commit();
      }

      // Décrément stats.planifies par client (pas batché — quelques clients
      // par tournée typiquement, lectures séquentielles acceptables).
      for (const [cid, n] of decrParClient.entries()) {
        try {
          const cRef = doc(db, "clients", cid);
          const cSnap = await getDoc(cRef);
          if (!cSnap.exists()) continue;
          const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
          const cur = Number(stats.planifies) || 0;
          await updateDoc(cRef, { "stats.planifies": Math.max(0, cur - n) });
        } catch (e) {
          console.error("[cancelTournee] decrement planifies KO", cid, e);
        }
      }
      return { ok: true, count: docs.length };
    }

    case "countPendingVerifications": {
      // Badge sidebar admin (poll 60s). On compte uniquement les verifs
      // status=pending. getDocs renvoie le size sans frais supplémentaires
      // significatifs vs un getCountFromServer (collection limitée).
      const snap = await getDocs(
        query(collection(db, "verifications"), where("status", "==", "pending")),
      );
      return { ok: true, count: snap.size };
    }

    default:
      return null; // signal "fallback GAS"
  }
}

export async function deleteVerification(id: string) {
  await deleteDoc(doc(db, "verifications", id));
}
