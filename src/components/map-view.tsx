"use client";

import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

interface ClientPoint {
  id: string;
  entreprise: string;
  ville: string | null;
  departement: string | null;
  lat: number;
  lng: number;
  nbVelos: number;
  velosLivres: number;
  docsComplets: boolean;
}

interface TourneeStop {
  id: string;
  lat: number;
  lng: number;
  entreprise: string;
  nbVelos: number;
}

interface MapViewProps {
  clients: ClientPoint[];
  selectedId: string | null;
  tourneeIds: Set<string>;
  tournee: TourneeStop[];
  onSelectClient: (id: string) => void;
}

function getColor(client: ClientPoint, selectedId: string | null, tourneeIds: Set<string>) {
  if (client.id === selectedId) return "#2563eb";
  if (tourneeIds.has(client.id)) return "#16a34a";
  if (client.velosLivres === client.nbVelos && client.nbVelos > 0) return "#9ca3af";
  if (client.docsComplets) return "#f59e0b";
  return "#ef4444";
}

function getRadius(nbVelos: number) {
  if (nbVelos >= 100) return 12;
  if (nbVelos >= 50) return 10;
  if (nbVelos >= 20) return 8;
  if (nbVelos >= 10) return 6;
  return 5;
}

function FitBounds({ clients }: { clients: ClientPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (clients.length > 0) {
      const lats = clients.map((c) => c.lat);
      const lngs = clients.map((c) => c.lng);
      map.fitBounds([
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ], { padding: [30, 30] });
    }
  }, [clients, map]);
  return null;
}

export default function MapView({
  clients,
  selectedId,
  tourneeIds,
  tournee,
  onSelectClient,
}: MapViewProps) {
  const routeLine: [number, number][] = tournee.map((t) => [t.lat, t.lng]);

  return (
    <MapContainer
      center={[46.6, 2.3]}
      zoom={6}
      className="w-full h-full"
      style={{ background: "#f0f0f0" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds clients={clients} />

      {routeLine.length > 1 && (
        <Polyline
          positions={routeLine}
          color="#16a34a"
          weight={3}
          opacity={0.7}
          dashArray="8 4"
        />
      )}

      {clients.map((c) => (
        <CircleMarker
          key={c.id}
          center={[c.lat, c.lng]}
          radius={getRadius(c.nbVelos)}
          pathOptions={{
            fillColor: getColor(c, selectedId, tourneeIds),
            color: c.id === selectedId ? "#1d4ed8" : "#fff",
            weight: c.id === selectedId ? 3 : 1,
            fillOpacity: 0.85,
          }}
          eventHandlers={{
            click: () => onSelectClient(c.id),
          }}
        >
          <Popup>
            <div className="text-sm">
              <div className="font-bold">{c.entreprise}</div>
              <div className="text-gray-600">
                {c.ville} ({c.departement})
              </div>
              <div className="mt-1">
                {c.nbVelos} vélos — {c.velosLivres} livrés
              </div>
              <div className="mt-1">
                Docs: {c.docsComplets ? "complets" : "incomplets"}
              </div>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
