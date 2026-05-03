"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, onSnapshot, getDocFromServer } from "firebase/firestore";
import { auth, db } from "./firebase";
import { setCurrentUser, clearCurrentUser } from "./current-user";

export type EquipeRole =
  | "superadmin"
  | "admin"
  | "chef"
  | "chauffeur"
  | "monteur"
  | "preparateur"
  | "apporteur";

export type EquipeMemberDoc = {
  uid: string;
  nom: string;
  role: EquipeRole;
  email: string | null;
  contactEmail?: string | null;
  telephone?: string | null;
  actif: boolean;
  notes?: string | null;
  legacyId?: string;
  /** Monteur référent qui pilote les autres monteurs : voit toutes les
   *  tournées des monteurs (pas seulement les siennes). */
  estChefMonteur?: boolean;
  /** Yoann 2026-05-03 : distingue chef monteur (gère équipe monteurs) vs
   *  chef admin terrain (permissions plus larges). */
  chefDeMonteurs?: boolean;
  /** Taux de règlement par vélo monté (en €). Sert au calcul des règlements
   *  affichés dans /finances. Si absent, on retombe sur le taux par défaut. */
  tauxParVeloMonte?: number;
};

export type FirebaseUserState = {
  /** true tant qu'on n'a pas résolu le user et le doc équipe */
  loading: boolean;
  /** user Firebase Auth (null si pas connecté) */
  user: User | null;
  /** doc Firestore équipe correspondant (null si pas mappé / non actif) */
  member: EquipeMemberDoc | null;
  /** raison textuelle si user authentifié mais refusé (pas dans équipe / inactif) */
  denyReason: string | null;
};

const INITIAL: FirebaseUserState = {
  loading: true,
  user: null,
  member: null,
  denyReason: null,
};

export function useFirebaseUser(): FirebaseUserState {
  const [state, setState] = useState<FirebaseUserState>(INITIAL);

  useEffect(() => {
    let unsubMember: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubMember) {
        unsubMember();
        unsubMember = null;
      }

      if (!user) {
        clearCurrentUser();
        setState({ loading: false, user: null, member: null, denyReason: null });
        return;
      }

      setState((s) => ({ ...s, loading: true, user }));

      // Fix définitif "Accès refusé" alors que doc existe (30-04 11h12).
      // Cause récurrente : IndexedDB Firestore persistance corrompue/désync
      // localement → onSnapshot fire avec snap.exists()=false alors que le
      // doc EXISTE côté serveur. Avant : on basculait direct en denyReason.
      // Maintenant : avant denyReason, on refait un getDocFromServer (bypass
      // cache local) → si serveur dit exists=true, on accepte (= vérité).
      const memberRef = doc(db, "equipe", user.uid);

      const acceptMember = (data: EquipeMemberDoc) => {
        if (!data.actif) {
          clearCurrentUser();
          setState({
            loading: false,
            user,
            member: null,
            denyReason: "Compte désactivé.",
          });
          return;
        }
        setCurrentUser({
          id: user.uid,
          nom: data.nom,
          role: data.role,
          estChefMonteur: data.estChefMonteur === true,
          chefDeMonteurs: data.chefDeMonteurs === true,
        });
        setState({
          loading: false,
          user,
          member: { ...data, uid: user.uid },
          denyReason: null,
        });
      };

      const verifyServerThenDeny = async () => {
        // Bypass total du cache local : interroge directement le serveur.
        // Si IndexedDB local dit "doc absent" mais que le serveur dit
        // "doc présent", on fait confiance au serveur (vérité).
        try {
          const fresh = await getDocFromServer(memberRef);
          if (fresh.exists()) {
            acceptMember(fresh.data() as EquipeMemberDoc);
            return;
          }
        } catch (err) {
          // Si le getDocFromServer plante (offline, perms…), on n'a aucune
          // info fiable → on déclare denyReason mais avec un message clair.
          setState({
            loading: false,
            user,
            member: null,
            denyReason: `Vérification serveur impossible : ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        // Le serveur confirme que le doc n'existe pas → vrai cas d'accès refusé.
        clearCurrentUser();
        setState({
          loading: false,
          user,
          member: null,
          denyReason: "Compte non rattaché à un membre d'équipe.",
        });
      };

      unsubMember = onSnapshot(
        memberRef,
        { includeMetadataChanges: true },
        (snap) => {
          // Snap depuis le cache offline ET vide → on ignore, on attend le serveur.
          if (!snap.exists() && snap.metadata.fromCache) {
            return;
          }
          if (!snap.exists()) {
            // Verif serveur avant de bascule en denyReason (peut être un
            // faux négatif du onSnapshot quand IndexedDB local est corrompu).
            void verifyServerThenDeny();
            return;
          }
          acceptMember(snap.data() as EquipeMemberDoc);
        },
        (err) => {
          setState({
            loading: false,
            user,
            member: null,
            denyReason: `Erreur Firestore : ${err.message}`,
          });
        },
      );
    });

    return () => {
      if (unsubMember) unsubMember();
      unsubAuth();
    };
  }, []);

  return state;
}
