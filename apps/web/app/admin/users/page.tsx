"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch } from "../../auth";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  status: "active" | "disabled";
  roles: string[];
  createdAt: string;
  lastConnectedAt?: string;
};

function UserAdminContent() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "user" });
  const [creatingUser, setCreatingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    const response = await apiFetch("/api/v1/admin/users");
    if (!response.ok) throw new Error("Nutzer konnten nicht geladen werden");
    setUsers(await response.json() as AdminUser[]);
  }

  useEffect(() => {
    void loadUsers().catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen"));
  }, []);

  async function updateUser(user: AdminUser, patch: Partial<Pick<AdminUser, "roles" | "status">>) {
    const role = patch.roles?.[0] ?? user.roles[0] ?? "user";
    const status = patch.status ?? user.status;
    const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, status }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? "Nutzer konnte nicht aktualisiert werden");
    }
    await loadUsers();
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingUser(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(newUser),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "Nutzer konnte nicht angelegt werden");
      setNewUser({ name: "", email: "", password: "", role: "user" });
      await loadUsers();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Nutzer konnte nicht angelegt werden");
    } finally {
      setCreatingUser(false);
    }
  }

  return <main className="shell adminPage">
    <header className="topbar">
      <div><p className="eyebrow">WAGI / ADMINISTRATION</p><h1>Benutzerverwaltung</h1><p className="muted">Konten, Rollen und Zugriffsstatus verwalten.</p></div>
      <nav className="pageNav"><Link href="/">Dashboard</Link><Link href="/admin">Admin-Übersicht</Link><Link className="pageNavActive" href="/admin/users">Benutzer</Link></nav>
    </header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel">
      <div className="panelHead"><div><h2>Benutzer</h2><p className="muted">Gruppen und Connectoren verwaltet jeder Nutzer selbst.</p></div><span className="count">{users.length}</span></div>
      <form className="adminCreateForm" onSubmit={createUser}>
        <input aria-label="Name" placeholder="Name" required minLength={2} value={newUser.name} onChange={(event) => setNewUser({ ...newUser, name: event.target.value })} />
        <input aria-label="E-Mail" type="email" placeholder="E-Mail" required value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} />
        <input aria-label="Passwort" type="password" placeholder="Passwort (mind. 10 Zeichen)" required minLength={10} value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} />
        <select aria-label="Rolle" value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}><option value="user">Nutzer</option><option value="admin">Administrator</option></select>
        <button className="primaryButton" disabled={creatingUser}>{creatingUser ? "Wird angelegt …" : "Nutzer anlegen"}</button>
      </form>
      <div className="adminUserList">{users.map((user) => <div className="adminUserRow" key={user.id}>
        <div><strong>{user.name}</strong><small>{user.email}</small><div className="adminUserMeta"><span>Registriert: {new Date(user.createdAt).toLocaleString()}</span><span>Letzte Verbindung: {user.lastConnectedAt ? new Date(user.lastConnectedAt).toLocaleString() : "Noch keine Verbindung"}</span></div></div>
        <select value={user.roles[0] ?? "user"} onChange={(event) => void updateUser(user, { roles: [event.target.value] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="user">Nutzer</option><option value="admin">Administrator</option></select>
        <select value={user.status} onChange={(event) => void updateUser(user, { status: event.target.value as AdminUser["status"] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="active">Aktiv</option><option value="disabled">Deaktiviert</option></select>
      </div>)}</div>
    </section>
  </main>;
}

export default function AdminUsersPage() {
  return <AuthGate><UserAdminContent /></AuthGate>;
}
