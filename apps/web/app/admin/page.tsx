"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch } from "../auth";

type AdminUser = { id: string; email: string; name: string; status: "active" | "disabled"; roles: string[]; createdAt: string };
type GroupAccess = { groupId: string; subject: string; platform: string; chatType: string; parentGroupId?: string; isSelected: boolean; canRead: boolean; canManage: boolean };

function AdminContent() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<GroupAccess[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    const response = await apiFetch("/api/v1/admin/users");
    if (!response.ok) throw new Error("Nutzer konnten nicht geladen werden");
    const next = await response.json() as AdminUser[];
    setUsers(next);
    setSelectedUser((current) => current || next.find((user) => user.roles.includes("user"))?.id || next[0]?.id || "");
  }

  async function loadGroups(userID: string) {
    if (!userID) return;
    const response = await apiFetch(`/api/v1/admin/groups/access?userId=${encodeURIComponent(userID)}`);
    if (!response.ok) throw new Error("Gruppenrechte konnten nicht geladen werden");
    setGroups(await response.json() as GroupAccess[]);
  }

  useEffect(() => { void loadUsers().catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen")); }, []);
  useEffect(() => { void loadGroups(selectedUser).catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen")); }, [selectedUser]);

  async function updateUser(user: AdminUser, patch: Partial<Pick<AdminUser, "roles" | "status">>) {
    const role = patch.roles?.[0] ?? user.roles[0] ?? "user";
    const status = patch.status ?? user.status;
    const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, status }) });
    if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? "Nutzer konnte nicht aktualisiert werden"); }
    await loadUsers();
  }

  async function updateAccess(access: GroupAccess, canRead: boolean, canManage: boolean) {
    const response = await apiFetch("/api/v1/admin/groups/access", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: selectedUser, groupId: access.groupId, canRead, canManage }) });
    if (!response.ok) throw new Error("Gruppenrecht konnte nicht gespeichert werden");
    setGroups((current) => current.map((item) => item.groupId === access.groupId ? { ...item, canRead, canManage: canRead && canManage } : item));
  }

  return <main className="shell adminPage">
    <header className="topbar"><div><p className="eyebrow">WAGI / ADMINISTRATION</p><h1>Benutzer und Rechte</h1></div><nav className="pageNav"><Link href="/">Dashboard</Link><Link href="/groups">Gruppen</Link></nav></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Benutzer</h2><p className="muted">Neue Konten erhalten erst nach einer Freigabe Zugriff auf Gruppen.</p></div><span className="count">{users.length}</span></div>
      <div className="adminUserList">{users.map((user) => <div className="adminUserRow" key={user.id}><div><strong>{user.name}</strong><small>{user.email}</small></div><select value={user.roles[0] ?? "user"} onChange={(event) => void updateUser(user, { roles: [event.target.value] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="user">Nutzer</option><option value="admin">Administrator</option></select><select value={user.status} onChange={(event) => void updateUser(user, { status: event.target.value as AdminUser["status"] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="active">Aktiv</option><option value="disabled">Deaktiviert</option></select></div>)}</div>
    </section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Gruppenrechte</h2><p className="muted">Lese- und Verwaltungsrechte werden pro Nutzer vergeben.</p></div><select value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}>{users.filter((user) => !user.roles.includes("admin")).map((user) => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select></div>
      <div className="adminGroupList">{groups.map((group) => <div className="adminGroupRow" key={group.groupId}><div><strong>{group.subject}</strong><small>{group.platform} · {group.chatType}</small></div><label><input type="checkbox" checked={group.canRead} onChange={(event) => void updateAccess(group, event.target.checked, group.canManage).catch((value) => setError(value instanceof Error ? value.message : "Gruppenrecht konnte nicht gespeichert werden"))} /> Lesen</label><label><input type="checkbox" checked={group.canManage} disabled={!group.canRead} onChange={(event) => void updateAccess(group, group.canRead, event.target.checked).catch((value) => setError(value instanceof Error ? value.message : "Gruppenrecht konnte nicht gespeichert werden"))} /> Verwalten</label></div>)}</div>
    </section>
  </main>;
}

export default function AdminPage() {
  return <AuthGate><AdminContent /></AuthGate>;
}
