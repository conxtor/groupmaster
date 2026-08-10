"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";

type EventMapProps = {
  latitude: number;
  longitude: number;
  label: string;
  mapLabel?: string;
};

export default function EventMap({ latitude, longitude, label, mapLabel }: EventMapProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: LeafletMap | undefined;
    let disposed = false;

    void import("leaflet").then((leaflet) => {
      if (disposed || !elementRef.current) return;
      map = leaflet.map(elementRef.current, { zoomControl: true, scrollWheelZoom: false }).setView([latitude, longitude], 12);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      leaflet.marker([latitude, longitude], {
        icon: leaflet.divIcon({ className: "event-marker", html: "<span>✦</span>", iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).addTo(map).bindPopup(label).openPopup();
    });

    return () => {
      disposed = true;
      map?.remove();
    };
  }, [latitude, longitude, label]);

  return <div className="eventMap" ref={elementRef} aria-label={mapLabel ?? `Karte für ${label}`} />;
}
