"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch } from "../auth";

type AdminUser = { id: string; email: string; name: string; status: "active" | "disabled"; roles: string[]; createdAt: string };

function AdminContent() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    const response = await apiFetch("/api/v1/admin/users");
    if (!response.ok) throw new Error("Nutzer konnten nicht geladen werden");
    const next = await response.json() as AdminUser[];
    setUsers(next);
  }

  useEffect(() => { void loadUsers().catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen")); }, []);

  async function updateUser(user: AdminUser, patch: Partial<Pick<AdminUser, "roles" | "status">>) {
    const role = patch.roles?.[0] ?? user.roles[0] ?? "user";
    const status = patch.status ?? user.status;
    const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, status }) });
    if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? "Nutzer konnte nicht aktualisiert werden"); }
    await loadUsers();
  }

  return <main className="shell adminPage">
    <header className="topbar"><div><p className="eyebrow">WAGI / ADMINISTRATION</p><h1>Benutzerverwaltung</h1></div><nav className="pageNav"><Link href="/">Dashboard</Link><Link href="/groups">Gruppen</Link></nav></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Benutzer und Rollen</h2><p className="muted">Gruppen und Connectoren verwaltet jeder Nutzer selbst im persönlichen Bereich.</p></div><span className="count">{users.length}</span></div>
      <div className="adminUserList">{users.map((user) => <div className="adminUserRow" key={user.id}><div><strong>{user.name}</strong><small>{user.email}</small></div><select value={user.roles[0] ?? "user"} onChange={(event) => void updateUser(user, { roles: [event.target.value] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="user">Nutzer</option><option value="admin">Administrator</option></select><select value={user.status} onChange={(event) => void updateUser(user, { status: event.target.value as AdminUser["status"] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="active">Aktiv</option><option value="disabled">Deaktiviert</option></select></div>)}</div>
    </section>
  </main>;
}

export default function AdminPage() {
  return <AuthGate><AdminContent /></AuthGate>;
}
