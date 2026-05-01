"use client";

import { useEffect, useMemo, useState } from "react";
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
  const isChefMonteurView = user?.role === "monteur" && user?.estChefMonteur === true;
  if (user && user.role !== "superadmin" && !isChefMonteurView) {
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
      {(user?.role === "superadmin" || user?.role === "admin") && (
        <ChargesOperationnellesSection
          from={from}
          to={to}
          coutMainOeuvre={data?.totals?.coutTotal || 0}
        />
      )}

      {data?.ok && (
        <>
          {/* === Pointeuse monteurs (compact, click pour détail) === */}
          {(() => {
            const monteurs = (data.byMember || [])
              .filter((m) => m.role === "monteur")
              .sort((a, b) => b.coutTotal - a.coutTotal);
            if (monteurs.length === 0) return null;
            const totalMonteurs = monteurs.reduce((s, m) => s + m.coutTotal, 0);
            const totalVelosMontes = monteurs.reduce((s, m) => s + (m.velosPrimes || 0), 0);
            return (
              <div className="mb-6 bg-white rounded-xl border overflow-hidden">
                <div className="px-4 py-2.5 border-b bg-emerald-50 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    🔧 Pointeuse monteurs
                  </h2>
                  <span className="text-[11px] text-emerald-700">
                    {totalVelosMontes} vélos · {monteurs.length} monteur{monteurs.length > 1 ? "s" : ""} · <span className="font-semibold">{fmt(totalMonteurs)}</span>
                  </span>
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
                    {monteurs.map((m) => (
                      <MonteurPointeuseRow key={m.id} m={m} from={from} to={to} />
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}

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
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(["chauffeur", "chef", "monteur", "preparateur", "apporteur"] as EquipeRole[]).flatMap((r) => {
                      const list = byRole[r] || [];
                      if (list.length === 0) return [];
                      return list.map((m) => (
                        <tr key={m.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium text-gray-900">{m.nom}</td>
                          <td className="px-4 py-2">
                            <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${ROLE_COLOR[m.role]}`}>
                              {ROLE_LABEL[m.role]}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">{m.jours || "—"}</td>
                          <td className="px-3 py-2 text-right">{m.velosPrimes || "—"}</td>
                          <td className="px-3 py-2 text-right text-xs text-gray-500">
                            {m.salaireJournalier ? fmt(m.salaireJournalier) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-gray-500">
                            {m.primeVelo ? fmt(m.primeVelo) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-blue-700">{m.coutSalaire ? fmt(m.coutSalaire) : "—"}</td>
                          <td className="px-3 py-2 text-right text-amber-700">{m.coutPrime ? fmt(m.coutPrime) : "—"}</td>
                          <td className="px-4 py-2 text-right font-semibold text-emerald-700">{fmt(m.coutTotal)}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                  <tfoot className="border-t bg-gray-50 font-semibold">
                    <tr>
                      <td className="px-4 py-2" colSpan={6}>Total</td>
                      <td className="px-3 py-2 text-right text-blue-700">{fmt(data.totals?.coutSalaires || 0)}</td>
                      <td className="px-3 py-2 text-right text-amber-700">{fmt(data.totals?.coutPrimes || 0)}</td>
                      <td className="px-4 py-2 text-right text-emerald-700">{fmt(data.totals?.coutTotal || 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

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
