"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
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

      unsubMember = onSnapshot(
        doc(db, "equipe", user.uid),
        (snap) => {
          if (!snap.exists()) {
            clearCurrentUser();
            setState({
              loading: false,
              user,
              member: null,
              denyReason: "Compte non rattaché à un membre d'équipe.",
            });
            return;
          }
          const data = snap.data() as EquipeMemberDoc;
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
          // Compat legacy : pages qui utilisent encore useCurrentUser() continuent
          // de fonctionner. À retirer quand toutes les pages utilisent useFirebaseUser.
          setCurrentUser({ id: user.uid, nom: data.nom, role: data.role });
          setState({
            loading: false,
            user,
            member: { ...data, uid: user.uid },
            denyReason: null,
          });
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
