"use client";

import React, { useEffect, useMemo, useState } from "react";
import { gasGet } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";
import type { EquipeRole } from "@/lib/data-context";
import { ChargesOperationnellesSection } from "./charges-operationnelles";

interface MemberRow {
  id: string;
  nom: string;
  role: EquipeRole;
  salaireJournalier: number;
  primeVelo: number;
  jours: number;
  velosPrimes: number;
  coutSalaire: number;
  coutPrime: number;
  coutTotal: number;
  /** Yoann 2026-05-01 : Naomi paie a l heure (premiere/derniere prep). */
  tauxHoraire?: number;
  heuresTravaillees?: number;
}

interface FinancesResponse {
  ok?: boolean;
  error?: string;
  from?: string;
  to?: string;
  nbTournees?: number;
  byMember?: MemberRow[];
  totals?: { coutSalaires: number; coutPrimes: number; coutTotal: number; jours: number };
}

const ROLE_LABEL: Record<EquipeRole, string> = {
  superadmin: "Super admin",
  admin: "Admin",
  chauffeur: "Chauffeur",
  chef: "Chef d'équipe",
  monteur: "Monteur",
  preparateur: "Préparateur",
  apporteur: "Apporteur",
};

const ROLE_COLOR: Record<EquipeRole, string> = {
  superadmin: "bg-yellow-100 text-yellow-800",
  admin: "bg-red-100 text-red-800",
  chauffeur: "bg-blue-100 text-blue-800",
  chef: "bg-purple-100 text-purple-800",
  monteur: "bg-emerald-100 text-emerald-800",
  preparateur: "bg-orange-100 text-orange-800",
  apporteur: "bg-amber-100 text-amber-800",
};

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

const fmt = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n || 0);

export default function FinancesPage() {
  const user = useCurrentUser();
  const today = useMemo(() => new Date(), []);
  // Filtre par défaut = Année 2026 (Yoann 2026-05-01) : vue globale à
  // l'arrivée pour piloter, pas le mois en cours.
  const [from, setFrom] = useState(`${today.getFullYear()}-01-01`);
  const [to, setTo] = useState(`${today.getFullYear()}-12-31`);
  const [data, setData] = useState<FinancesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Charge le récap quand la fenêtre [from, to] change. On debounce pas — l'user
  // déclenche via les boutons preset ou en éditant les dates manuellement.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const r = (await gasGet("getFinancesSummary", { from, to })) as FinancesResponse;
        if (cancelled) return;
        if (r.error) {
          setError(r.error);
          setData(null);
        } else {
          setData(r);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  // Garde-fou : super-admin = accès complet. Chef monteur (ricky) = vue
  // restreinte aux règlements de SES monteurs (pas la masse salariale globale,
  // pas les chauffeurs/préparateurs/apporteurs). Les admins standards et les
  // autres rôles n'ont pas accès du tout.
  // Yoann 2026-05-03 :
  // - chef monteur (chefDeMonteurs===true, Ricky/Nordine) → vue restreinte
  //   (pointeuse de SES monteurs + grand livre paiements)
  // - chef admin terrain (chefDeMonteurs!==true, Julia/Ethan) → vue admin
  //   complète (comme superadmin)
  const isChefAdminTerrain = user?.role === "chef" && user?.chefDeMonteurs !== true;
  const isChefMonteurView =
    (user?.role === "monteur" && user?.estChefMonteur === true) ||
    (user?.role === "chef" && user?.chefDeMonteurs === true);
  if (
    user &&
    user.role !== "superadmin" &&
    !isChefAdminTerrain &&
    !isChefMonteurView
  ) {
    return (
      <div className="max-w-2xl mx-auto bg-amber-50 border border-amber-200 rounded-xl p-6 text-amber-800">
        Cette page est réservée au super-admin (accès aux salaires/primes).
      </div>
    );
  }

  const setMonth = (delta: number) => {
    const d = new Date(today.getFullYear(), today.getMonth() + delta, 1);
    setFrom(isoDay(startOfMonth(d)));
    setTo(isoDay(endOfMonth(d)));
  };
  const setYear = () => {
    setFrom(`${today.getFullYear()}-01-01`);
    setTo(`${today.getFullYear()}-12-31`);
  };
  // Aujourd'hui (Yoann 2026-05-01)
  const setDay = () => {
    const iso = isoDay(today);
    setFrom(iso);
    setTo(iso);
  };
  // Semaine ISO (Lundi → Dimanche)
  const setWeek = () => {
    const d = new Date(today);
    const dow = (d.getDay() + 6) % 7; // 0=Lun, 6=Dim
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    setFrom(isoDay(monday));
    setTo(isoDay(sunday));
  };

  const byRole = useMemo(() => {
    const groups: Record<string, MemberRow[]> = {};
    if (!data?.byMember) return groups;
    for (const m of data.byMember) {
      if (!groups[m.role]) groups[m.role] = [];
      groups[m.role].push(m);
    }
    return groups;
  }, [data]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Finances</h1>
        <p className="text-sm text-gray-500 mt-1">
          Coût main d&apos;œuvre sur la période — salaires journaliers + primes vélo (équipe terrain) +
          commissions apporteurs.
        </p>
      </div>

      {/* Sélecteur de période */}
      <div className="bg-white rounded-xl border p-4 mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Du</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Au</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <button onClick={setDay} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">
            Aujourd&apos;hui
          </button>
          <button onClick={setWeek} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">
            Cette semaine
          </button>
          <button onClick={() => setMonth(-1)} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">
            Mois précédent
          </button>
          <button onClick={() => setMonth(0)} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">
            Ce mois
          </button>
          <button onClick={setYear} className="px-3 py-1.5 text-sm border rounded-lg bg-green-50 border-green-300 text-green-700 hover:bg-green-100">
            Année {today.getFullYear()}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 mb-4 text-sm">
          {error}
        </div>
      )}
      {loading && !data && (
        <div className="text-sm text-gray-400 italic">Calcul en cours…</div>
      )}

      {/* === Charges opérationnelles (frais saisis + achats vélos Axdis) ===
          Indépendant du chargement GAS — utilise Firestore en temps réel.
          On y injecte la masse salariale calculée plus bas (data.totals.coutTotal)
          pour avoir un "coût / vélo all-in" qui inclut salaires + primes +
          commissions apporteurs (demande Yoann 2026-05-01). Si data n'est
          pas encore chargé, on passe 0 et la carte all-in est masquée. */}
      {(user?.role === "superadmin" || user?.role === "admin" || isChefAdminTerrain) && (
        <ChargesOperationnellesSection
          from={from}
          to={to}
          coutMainOeuvre={data?.totals?.coutTotal || 0}
        />
      )}

      {data?.ok && (
        <>
          {/* === Pointeuse monteurs (compact, click pour détail) === */}
          <PointeuseMonteurs
            data={data}
            from={from}
            to={to}
            fmt={fmt}
            filterChefId={user?.role === "chef" && user?.chefDeMonteurs === true ? user.id : null}
          />

          {isChefMonteurView ? null : (
          <>
          {/* Compteurs en tête */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <KpiCard label="Tournées" value={String(data.nbTournees ?? 0)} />
            <KpiCard label="Jours-personne" value={String(data.totals?.jours ?? 0)} />
            <KpiCard label="Salaires" value={fmt(data.totals?.coutSalaires || 0)} accent="text-blue-700" />
            <KpiCard label="Primes vélo" value={fmt(data.totals?.coutPrimes || 0)} accent="text-amber-700" />
          </div>
          <div className="bg-gradient-to-r from-emerald-50 to-emerald-100 border border-emerald-200 rounded-xl p-4 mb-6 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-emerald-700 font-semibold">Coût total main d&apos;œuvre</div>
              <div className="text-3xl font-bold text-emerald-900 mt-0.5">{fmt(data.totals?.coutTotal || 0)}</div>
            </div>
            <div className="text-xs text-emerald-700 text-right">
              Du {new Date(data.from!).toLocaleDateString("fr-FR")}<br />
              au {new Date(data.to!).toLocaleDateString("fr-FR")}
            </div>
          </div>

          {/* Tableau par membre */}
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="px-4 py-3 border-b bg-gray-50 font-semibold text-sm">
              Détail par membre
            </div>
            {Object.keys(byRole).length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400 italic">
                Aucune dépense sur la période. Vérifie que les tournées ont des participants assignés et
                que les barèmes (salaire/prime) sont renseignés sur les fiches Équipe.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-xs text-gray-600">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Membre</th>
                      <th className="text-left px-4 py-2 font-medium">Rôle</th>
                      <th className="text-right px-3 py-2 font-medium">Jours</th>
                      <th className="text-right px-3 py-2 font-medium">Vélos primés</th>
                      <th className="text-right px-3 py-2 font-medium">€/jour</th>
                      <th className="text-right px-3 py-2 font-medium">€/vélo</th>
                      <th className="text-right px-3 py-2 font-medium">Salaire</th>
                      <th className="text-right px-3 py-2 font-medium">Prime</th>
                      <th className="text-right px-4 py-2 font-medium">Total</th>
                      <th className="text-right px-3 py-2 font-medium">Payé</th>
                      <th className="text-right px-4 py-2 font-medium">Solde</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(["chauffeur", "chef", "monteur", "preparateur", "apporteur"] as EquipeRole[]).flatMap((r) => {
                      const list = byRole[r] || [];
                      if (list.length === 0) return [];
                      return list.map((m) => (
                        <MemberRowWithPaiement
                          key={m.id}
                          member={m}
                          from={from}
                          to={to}
                        />
                      ));
                    })}
                  </tbody>
                  <tfoot className="border-t bg-gray-50 font-semibold">
                    <tr>
                      <td className="px-4 py-2" colSpan={6}>Total</td>
                      <td className="px-3 py-2 text-right text-blue-700">{fmt(data.totals?.coutSalaires || 0)}</td>
                      <td className="px-3 py-2 text-right text-amber-700">{fmt(data.totals?.coutPrimes || 0)}</td>
                      <td className="px-4 py-2 text-right text-emerald-700">{fmt(data.totals?.coutTotal || 0)}</td>
                      <td className="px-3 py-2" />
                      <td className="px-4 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* === Grand livre paiements (Yoann 2026-05-01) ===
              Traçabilité comptable des salaires/avances/primes payés. */}
          <GrandLivreSection from={from} to={to} />

          <p className="text-[11px] text-gray-400 mt-4 leading-snug">
            Salaires terrain = 1 jour de paye par tournée à laquelle le membre est affecté. Prime monteur = split entre les
            monteurs de l&apos;équipe sur la tournée. Prime apporteur = comptée à la livraison effective (statut « livrée »)
            des clients qu&apos;il a apportés. Pour modifier les barèmes : Équipe → ouvrir une fiche → bloc « Rémunération ».
          </p>
          </>
          )}
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent || "text-gray-900"}`}>{value}</div>
    </div>
  );
}

interface SessionRow {
  clientId: string;
  entreprise: string;
  jour: string;
  heureDebut: string;
  heureFin: string;
  dureeMin: number;
  nbVelos: number;
  velos: { fnuci: string | null; dateMontage: string | null; montageClaimAt: string | null }[];
}

function MonteurPointeuseRow({ m, from, to }: { m: MemberRow; from: string; to: string }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [errSessions, setErrSessions] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && sessions === null && !loadingSessions) {
      setLoadingSessions(true);
      setErrSessions(null);
      try {
        const r = await gasGet("getMonteurActivity", { monteurId: m.id, from, to }) as
          { ok?: boolean; sessions?: SessionRow[]; error?: string };
        if (r.error) setErrSessions(r.error);
        else setSessions(r.sessions || []);
      } catch (e) {
        setErrSessions(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingSessions(false);
      }
    }
  };

  const fmtTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short" });

  return (
    <>
      <tr className="hover:bg-gray-50 cursor-pointer" onClick={toggle}>
        <td className="px-3 py-1.5 text-gray-400 text-xs">{open ? "▼" : "▶"}</td>
        <td className="px-3 py-1.5 font-medium text-gray-900">{m.nom}</td>
        <td className="px-3 py-1.5 text-right text-gray-700">{m.jours || "—"}</td>
        <td className="px-3 py-1.5 text-right font-semibold">{m.velosPrimes || 0}</td>
        <td className="px-3 py-1.5 text-right text-xs text-gray-500">{m.primeVelo ? fmt(m.primeVelo) : "—"}</td>
        <td className="px-3 py-1.5 text-right font-semibold text-emerald-700">{fmt(m.coutTotal)}</td>
      </tr>
      {open && (
        <tr className="bg-gray-50">
          <td></td>
          <td colSpan={5} className="px-3 py-2">
            {loadingSessions && <div className="text-xs text-gray-400 italic">Chargement de la pointeuse…</div>}
            {errSessions && <div className="text-xs text-red-600">{errSessions}</div>}
            {sessions && sessions.length === 0 && (
              <div className="text-xs text-gray-400 italic">Aucune intervention enregistrée sur la période.</div>
            )}
            {sessions && sessions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">Jour</th>
                      <th className="text-left px-2 py-1 font-medium">Client</th>
                      <th className="text-left px-2 py-1 font-medium" title="Scan QR carton (début intervention)">Début</th>
                      <th className="text-left px-2 py-1 font-medium" title="Dernier vélo monté">Fin</th>
                      <th className="text-right px-2 py-1 font-medium">Durée</th>
                      <th className="text-right px-2 py-1 font-medium">Vélos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {sessions.map((s) => (
                      <tr key={`${s.clientId}-${s.jour}`} className="hover:bg-white">
                        <td className="px-2 py-1 text-gray-600 whitespace-nowrap">{fmtDate(s.jour)}</td>
                        <td className="px-2 py-1 font-medium text-gray-900 truncate max-w-xs">{s.entreprise || s.clientId}</td>
                        <td className="px-2 py-1 font-mono">{fmtTime(s.heureDebut)}</td>
                        <td className="px-2 py-1 font-mono">{fmtTime(s.heureFin)}</td>
                        <td className="px-2 py-1 text-right text-gray-600">
                          {s.dureeMin >= 60 ? `${Math.floor(s.dureeMin/60)}h${String(s.dureeMin%60).padStart(2,"0")}` : `${s.dureeMin}min`}
                        </td>
                        <td className="px-2 py-1 text-right font-semibold">{s.nbVelos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-1 text-[10px] text-gray-400 italic">
                  Début = scan QR carton (claim) · Fin = photo du dernier vélo monté
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// MemberRowWithPaiement (Yoann 2026-05-01) : ligne pointeuse avec
// agrégation paiements de la période + bouton "Marquer payé".
function MemberRowWithPaiement({
  member,
  from,
  to,
}: {
  member: MemberRow;
  from: string;
  to: string;
}) {
  const [paiements, setPaiements] = useState<{ id: string; montant: number; date: string; type: string; notes?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, query, where, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const q = query(
        collection(db, "paiementsEquipe"),
        where("memberId", "==", member.id),
        where("date", ">=", from),
        where("date", "<=", to),
      );
      const unsub = onSnapshot(q, (snap) => {
        if (!alive) return;
        const rows: typeof paiements = [];
        for (const d of snap.docs) {
          const data = d.data();
          rows.push({
            id: d.id,
            montant: Number(data.montant || 0),
            date: String(data.date || ""),
            type: String(data.type || "salaire"),
            notes: typeof data.notes === "string" ? data.notes : undefined,
          });
        }
        setPaiements(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, [member.id, from, to]);

  const totalPaye = paiements.reduce((s, p) => s + p.montant, 0);
  const solde = member.coutTotal - totalPaye;
  const fullPayee = solde <= 0 && member.coutTotal > 0;

  const markPaid = async () => {
    if (busy) return;
    if (member.coutTotal <= 0) return;
    if (!confirm(`Marquer ${member.nom} payé ${fmt(solde)} pour la période ${from} -> ${to} ?`)) return;
    setBusy(true);
    try {
      const { collection, addDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      await addDoc(collection(db, "paiementsEquipe"), {
        memberId: member.id,
        memberNom: member.nom,
        memberRole: member.role,
        montant: solde,
        type: "salaire",
        date: new Date().toISOString().slice(0, 10),
        periodeFrom: from,
        periodeTo: to,
        notes: `Paiement de la période ${from} -> ${to}`,
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-2 font-medium text-gray-900">{member.nom}</td>
      <td className="px-4 py-2">
        <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${ROLE_COLOR[member.role]}`}>
          {ROLE_LABEL[member.role]}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        {member.tauxHoraire && member.tauxHoraire > 0 && member.role === "preparateur" ? (
          <span title={`Paie horaire — ${member.heuresTravaillees ?? 0}h cumulées`}>
            <strong>{member.heuresTravaillees ?? 0}h</strong>
            <div className="text-[9px] text-gray-400">{member.jours || 0}j</div>
          </span>
        ) : (
          member.jours || "—"
        )}
      </td>
      <td className="px-3 py-2 text-right">{member.velosPrimes || "—"}</td>
      <td className="px-3 py-2 text-right text-xs text-gray-500">
        {member.tauxHoraire && member.tauxHoraire > 0 && member.role === "preparateur"
          ? `${fmt(member.tauxHoraire)}/h`
          : member.salaireJournalier ? fmt(member.salaireJournalier) : "—"}
      </td>
      <td className="px-3 py-2 text-right text-xs text-gray-500">
        {member.primeVelo ? fmt(member.primeVelo) : "—"}
      </td>
      <td className="px-3 py-2 text-right text-blue-700">{member.coutSalaire ? fmt(member.coutSalaire) : "—"}</td>
      <td className="px-3 py-2 text-right text-amber-700">{member.coutPrime ? fmt(member.coutPrime) : "—"}</td>
      <td className="px-4 py-2 text-right font-semibold text-emerald-700">{fmt(member.coutTotal)}</td>
      <td className="px-3 py-2 text-right text-emerald-600 text-xs">
        {totalPaye > 0 ? fmt(totalPaye) : "—"}
      </td>
      <td className="px-4 py-2 text-right">
        {fullPayee ? (
          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded font-semibold">
            ✓ Payé
          </span>
        ) : member.coutTotal > 0 ? (
          <button
            onClick={markPaid}
            disabled={busy}
            className="text-[11px] px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            title={`Solde dû : ${fmt(solde)}`}
          >
            💰 Payer {fmt(solde)}
          </button>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
    </tr>
  );
}

// GrandLivreSection (Yoann 2026-05-01) : liste de tous les paiements
// effectués sur la période, avec ajout manuel d'avance / prime / autre.
type PaiementRow = {
  id: string;
  memberId: string;
  memberNom: string;
  memberRole?: string;
  montant: number;
  type: string;
  date: string;
  notes?: string;
};
function GrandLivreSection({ from, to }: { from: string; to: string }) {
  const [paiements, setPaiements] = useState<PaiementRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, query, where, onSnapshot, orderBy } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const q = query(
        collection(db, "paiementsEquipe"),
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc"),
      );
      const unsub = onSnapshot(q, (snap) => {
        if (!alive) return;
        const rows: PaiementRow[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          rows.push({
            id: d.id,
            memberId: String(data.memberId || ""),
            memberNom: String(data.memberNom || ""),
            memberRole: typeof data.memberRole === "string" ? data.memberRole : undefined,
            montant: Number(data.montant || 0),
            type: String(data.type || "salaire"),
            date: String(data.date || ""),
            notes: typeof data.notes === "string" ? data.notes : undefined,
          });
        }
        setPaiements(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, [from, to]);

  const totalPaye = paiements.reduce((s, p) => s + p.montant, 0);
  const totalSalaires = paiements.filter((p) => p.type === "salaire").reduce((s, p) => s + p.montant, 0);
  const totalAvances = paiements.filter((p) => p.type === "avance").reduce((s, p) => s + p.montant, 0);
  const totalPrimes = paiements.filter((p) => p.type === "prime").reduce((s, p) => s + p.montant, 0);

  const removePaiement = async (id: string) => {
    if (!confirm("Supprimer ce paiement ?")) return;
    const { doc, deleteDoc } = await import("firebase/firestore");
    const { db } = await import("@/lib/firebase");
    await deleteDoc(doc(db, "paiementsEquipe", id));
  };

  return (
    <div className="mt-6 bg-white rounded-xl border overflow-hidden">
      <div className="px-4 py-3 border-b bg-purple-50 flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-sm">📒 Grand livre — Paiements équipe</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Traçabilité comptable des salaires, avances et primes versés sur la période.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-medium"
        >
          + Avance / prime / autre
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 bg-gray-50 border-b">
        <div className="text-center">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Total payé</div>
          <div className="text-lg font-bold text-emerald-700">{fmt(totalPaye)}</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Salaires</div>
          <div className="text-lg font-bold text-blue-700">{fmt(totalSalaires)}</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Avances</div>
          <div className="text-lg font-bold text-orange-700">{fmt(totalAvances)}</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Primes</div>
          <div className="text-lg font-bold text-amber-700">{fmt(totalPrimes)}</div>
        </div>
      </div>
      {paiements.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-400 italic">
          Aucun paiement enregistré sur la période. Clique « 💰 Payer » sur une ligne de la pointeuse
          ou « + Avance / prime » pour saisir manuellement.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b text-xs text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Date</th>
              <th className="text-left px-4 py-2 font-medium">Membre</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Notes</th>
              <th className="text-right px-4 py-2 font-medium">Montant</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {paiements.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-700">{p.date}</td>
                <td className="px-4 py-2 font-medium text-gray-900">{p.memberNom}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                    p.type === "salaire" ? "bg-blue-100 text-blue-800"
                    : p.type === "avance" ? "bg-orange-100 text-orange-800"
                    : p.type === "prime" ? "bg-amber-100 text-amber-800"
                    : "bg-gray-100 text-gray-700"
                  }`}>
                    {p.type}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">{p.notes || "—"}</td>
                <td className="px-4 py-2 text-right font-semibold text-emerald-700">{fmt(p.montant)}</td>
                <td className="px-2 text-right">
                  <button
                    onClick={() => removePaiement(p.id)}
                    className="text-red-400 hover:text-red-700 text-xs"
                    title="Supprimer ce paiement"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showAdd && <PaiementModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function PaiementModal({ onClose }: { onClose: () => void }) {
  const [equipeMembers, setEquipeMembers] = useState<{ id: string; nom: string; role: string }[]>([]);
  const [memberId, setMemberId] = useState("");
  const [montant, setMontant] = useState("");
  const [type, setType] = useState<"salaire" | "avance" | "prime" | "autre">("avance");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const snap = await getDocs(collection(db, "equipe"));
      if (!alive) return;
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
        .filter((m) => (m as { actif?: boolean }).actif !== false)
        .map((m) => ({
          id: m.id,
          nom: String((m as { nom?: string }).nom || ""),
          role: String((m as { role?: string }).role || ""),
        }))
        .sort((a, b) => a.nom.localeCompare(b.nom));
      setEquipeMembers(rows);
    })();
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    if (!memberId) {
      alert("Choisis un membre");
      return;
    }
    const m = parseFloat(montant.replace(",", "."));
    if (!Number.isFinite(m) || m === 0) {
      alert("Montant invalide");
      return;
    }
    if (!date) {
      alert("Date obligatoire");
      return;
    }
    setBusy(true);
    try {
      const member = equipeMembers.find((x) => x.id === memberId);
      const { collection, addDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      await addDoc(collection(db, "paiementsEquipe"), {
        memberId,
        memberNom: member?.nom || "",
        memberRole: member?.role || "",
        montant: m,
        type,
        date,
        notes: notes.trim() || null,
        createdAt: serverTimestamp(),
      });
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">+ Paiement</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Membre</label>
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              <option value="">— Choisir —</option>
              {equipeMembers.map((m) => (
                <option key={m.id} value={m.id}>{m.nom} ({m.role})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-600">Montant (€)</label>
              <input
                type="number"
                value={montant}
                onChange={(e) => setMontant(e.target.value)}
                placeholder="100"
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                className="w-full px-2 py-1.5 border rounded text-sm"
              >
                <option value="salaire">Salaire</option>
                <option value="avance">Avance</option>
                <option value="prime">Prime</option>
                <option value="autre">Autre</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Notes (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='Ex: "avance pour location appart"'
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Annuler</button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
          >
            {busy ? "..." : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}

// PointeuseMonteurs — Yoann 2026-05-03
// Section pointeuse avec toggle "Grouper par équipe (chef)". Les monteurs
// sont groupés par chefId (depuis equipe.chefId), affiché en sections
// "Équipe Ricky", "Équipe NORDINE", etc. + Sans équipe pour les isolés.
function PointeuseMonteurs({
  data,
  from,
  to,
  fmt,
  filterChefId = null,
}: {
  data: FinancesResponse;
  from: string;
  to: string;
  fmt: (n: number) => string;
  /** Yoann 2026-05-03 : si défini, on ne montre QUE les monteurs dont
   *  chefId == filterChefId (pour la vue chef d équipe). */
  filterChefId?: string | null;
}) {
  type EqLite = { id: string; nom: string; chefId: string | null };
  const [equipeAll, setEquipeAll] = useState<EqLite[]>([]);
  const [grouper, setGrouper] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const unsub = onSnapshot(collection(db, "equipe"), (snap) => {
        if (!alive) return;
        const rows: EqLite[] = [];
        for (const d of snap.docs) {
          const data = d.data() as { nom?: string; chefId?: string };
          rows.push({
            id: d.id,
            nom: String(data.nom || ""),
            chefId: typeof data.chefId === "string" && data.chefId ? data.chefId : null,
          });
        }
        setEquipeAll(rows);
      });
      return () => unsub();
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Filtre chef d équipe : si filterChefId fourni, on ne garde que les
  // monteurs dont chefId == filterChefId (lookup via equipeAll).
  const monteurs = (data.byMember || [])
    .filter((m) => m.role === "monteur")
    .filter((m) => {
      if (!filterChefId) return true;
      const eq = equipeAll.find((e) => e.id === m.id);
      return eq?.chefId === filterChefId;
    })
    .sort((a, b) => b.coutTotal - a.coutTotal);
  if (monteurs.length === 0) return null;
  const totalMonteurs = monteurs.reduce((s, m) => s + m.coutTotal, 0);
  const totalVelosMontes = monteurs.reduce((s, m) => s + (m.velosPrimes || 0), 0);

  // Mapping monteurId → chef (id + nom)
  const eqById = new Map(equipeAll.map((e) => [e.id, e]));
  const chefByMonteur = (mid: string): { id: string; nom: string } | null => {
    const eq = eqById.get(mid);
    if (!eq?.chefId) return null;
    const chef = eqById.get(eq.chefId);
    return chef ? { id: chef.id, nom: chef.nom } : null;
  };

  // Grouping
  type Group = { key: string; label: string; rows: MemberRow[] };
  let groups: Group[];
  if (grouper) {
    const map = new Map<string, Group>();
    for (const m of monteurs) {
      const chef = chefByMonteur(m.id);
      const key = chef?.id || "_aucun";
      const label = chef ? `Équipe ${chef.nom}` : "Sans équipe";
      if (!map.has(key)) map.set(key, { key, label, rows: [] });
      map.get(key)!.rows.push(m);
    }
    // Ordre : groupes avec le plus gros total d abord, "Sans équipe" en dernier
    groups = Array.from(map.values()).sort((a, b) => {
      if (a.key === "_aucun") return 1;
      if (b.key === "_aucun") return -1;
      const ta = a.rows.reduce((s, r) => s + r.coutTotal, 0);
      const tb = b.rows.reduce((s, r) => s + r.coutTotal, 0);
      return tb - ta;
    });
  } else {
    groups = [{ key: "all", label: "", rows: monteurs }];
  }

  return (
    <div className="mb-6 bg-white rounded-xl border overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-emerald-50 flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold flex items-center gap-2">🔧 Pointeuse monteurs</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-[11px] text-emerald-900 cursor-pointer">
            <input
              type="checkbox"
              checked={grouper}
              onChange={(e) => setGrouper(e.target.checked)}
              className="w-3 h-3"
            />
            Grouper par équipe
          </label>
          <span className="text-[11px] text-emerald-700">
            {totalVelosMontes} vélos · {monteurs.length} monteur{monteurs.length > 1 ? "s" : ""} ·{" "}
            <span className="font-semibold">{fmt(totalMonteurs)}</span>
          </span>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b text-[11px] text-gray-600">
          <tr>
            <th className="text-left px-3 py-1.5 font-medium w-8"></th>
            <th className="text-left px-3 py-1.5 font-medium">Monteur</th>
            <th className="text-right px-3 py-1.5 font-medium">Jours</th>
            <th className="text-right px-3 py-1.5 font-medium">Vélos montés</th>
            <th className="text-right px-3 py-1.5 font-medium">€/vélo</th>
            <th className="text-right px-3 py-1.5 font-medium">À régler</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {groups.map((g) => {
            const total = g.rows.reduce((s, r) => s + r.coutTotal, 0);
            const totalV = g.rows.reduce((s, r) => s + (r.velosPrimes || 0), 0);
            return (
              <React.Fragment key={g.key}>
                {grouper && (
                  <tr className="bg-emerald-50/50 border-y border-emerald-100">
                    <td colSpan={2} className="px-3 py-1.5 text-[11px] font-semibold text-emerald-900 uppercase tracking-wide">
                      👷 {g.label} <span className="opacity-60 normal-case font-normal">· {g.rows.length} monteur{g.rows.length > 1 ? "s" : ""}</span>
                    </td>
                    <td colSpan={2} className="text-right px-3 py-1.5 text-[11px] text-emerald-800">
                      {totalV} vélos
                    </td>
                    <td colSpan={2} className="text-right px-3 py-1.5 text-[11px] font-semibold text-emerald-900">
                      {fmt(total)}
                    </td>
                  </tr>
                )}
                {g.rows.map((m) => (
                  <MonteurPointeuseRow key={m.id} m={m} from={from} to={to} />
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
