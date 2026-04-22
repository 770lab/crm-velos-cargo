"use client";

import { useEffect, useState } from "react";
import { gasGet, gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";

export default function LivraisonsPage() {
  const { livraisons, clients: allClients, loading, refresh } = useData();
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    refresh("livraisons");
  }, [refresh]);

  const updateStatut = async (id: string, statut: string) => {
    const data: Record<string, unknown> = { statut };
    if (statut === "livree") data.dateEffective = new Date().toISOString();
    await gasPost("updateLivraison", { id, data });
    refresh("livraisons");
  };

  const deleteLivraison = async (id: string) => {
    if (!confirm("Supprimer cette livraison ?")) return;
    await gasGet("deleteLivraison", { id });
    refresh("livraisons");
  };

  const statutColors: Record<string, string> = {
    planifiee: "bg-gray-100 text-gray-700",
    en_cours: "bg-blue-100 text-blue-700",
    livree: "bg-green-100 text-green-700",
    annulee: "bg-red-100 text-red-700",
  };

  const parseNotes = (notes: string | null) => {
    if (!notes) return { tourneeId: null, ordre: null, total: null, display: "" };
    const tourneeId = notes.match(/\[([a-f0-9]{8})\]\s*$/)?.[1] ?? null;
    const ordreMatch = notes.match(/arrêt\s+(\d+)\/(\d+)/);
    const ordre = ordreMatch ? Number(ordreMatch[1]) : null;
    const total = ordreMatch ? Number(ordreMatch[2]) : null;
    let display = notes;
    if (tourneeId) display = display.replace(/\s*—?\s*\[[a-f0-9]{8}\]\s*$/, "");
    if (ordre && total) display = display.replace(/Tournée\s+\S+\s*—\s*arrêt\s+\d+\/\d+\s*—?\s*/i, "");
    display = display.replace(/^—\s*/, "").trim();
    return { tourneeId, ordre, total, display };
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Livraisons</h1>
          <p className="text-gray-500 mt-1">{livraisons.length} livraisons planifiées</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
        >
          + Planifier une livraison
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Client</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Adresse</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Vélos</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Date prévue</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Tournée / Notes</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Statut</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {livraisons.map((l) => {
              const info = parseNotes(l.notes);
              return (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{l.client.entreprise}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {[l.client.adresse, l.client.ville].filter(Boolean).join(", ") || "-"}
                </td>
                <td className="text-center px-4 py-3">{l._count.velos}</td>
                <td className="text-center px-4 py-3">
                  {l.datePrevue
                    ? new Date(l.datePrevue).toLocaleDateString("fr-FR")
                    : "-"}
                </td>
                <td className="px-4 py-3 text-xs">
                  {info.tourneeId && (
                    <span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-mono mr-1">
                      🚛 {info.tourneeId}
                      {info.ordre && info.total && (
                        <span className="text-indigo-500">· {info.ordre}/{info.total}</span>
                      )}
                    </span>
                  )}
                  {info.display && (
                    <span className="text-gray-500" title={l.notes ?? undefined}>
                      {info.display.length > 50 ? info.display.slice(0, 50) + "…" : info.display}
                    </span>
                  )}
                </td>
                <td className="text-center px-4 py-3">
                  <select
                    value={l.statut}
                    onChange={(e) => updateStatut(l.id, e.target.value)}
                    className={`text-xs px-2 py-1 rounded-full border-0 ${statutColors[l.statut] || ""}`}
                  >
                    <option value="planifiee">Planifiée</option>
                    <option value="en_cours">En cours</option>
                    <option value="livree">Livrée</option>
                    <option value="annulee">Annulée</option>
                  </select>
                </td>
                <td className="text-center px-4 py-3">
                  <button
                    onClick={() => deleteLivraison(l.id)}
                    className="text-red-400 hover:text-red-600 text-xs"
                  >
                    Supprimer
                  </button>
                </td>
              </tr>
              );
            })}
            {livraisons.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  Aucune livraison planifiée.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddLivraisonModal clients={allClients} onClose={() => { setShowAdd(false); refresh("livraisons"); }} />}
    </div>
  );
}

function AddLivraisonModal({ clients, onClose }: { clients: { id: string; entreprise: string; stats: { totalVelos: number } }[]; onClose: () => void }) {
  const [clientId, setClientId] = useState("");
  const [datePrevue, setDatePrevue] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId) return;
    setLoading(true);
    await gasPost("createLivraison", { clientId, datePrevue: datePrevue || null, notes: notes || null });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-4">Planifier une livraison</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <select
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          >
            <option value="">Sélectionner un client...</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.entreprise} ({c.stats.totalVelos} vélos)
              </option>
            ))}
          </select>
          <input
            type="date"
            value={datePrevue}
            onChange={(e) => setDatePrevue(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          <textarea
            placeholder="Notes (optionnel)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
            rows={2}
          />
          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              Planifier
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
