"use client";

import { FormEvent, useEffect, useState } from "react";
import { AuthGate, apiFetch, useAppLocale } from "../../auth";
import { adminTranslate } from "../admin-i18n";

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
  const { locale } = useAppLocale();
  const at = (key: Parameters<typeof adminTranslate>[1], values?: Record<string, string | number>) => adminTranslate(locale, key, values);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "user" });
  const [creatingUser, setCreatingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    const response = await apiFetch("/api/v1/admin/users");
    if (!response.ok) throw new Error(at("usersLoadError"));
    setUsers(await response.json() as AdminUser[]);
  }

  useEffect(() => {
    void loadUsers().catch((value) => setError(value instanceof Error ? value.message : at("loadFailed")));
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
      throw new Error(body?.error ?? at("userUpdateError"));
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
      if (!response.ok) throw new Error(body?.error ?? at("userCreateError"));
      setNewUser({ name: "", email: "", password: "", role: "user" });
      await loadUsers();
    } catch (value) {
      setError(value instanceof Error ? value.message : at("userCreateError"));
    } finally {
      setCreatingUser(false);
    }
  }

  return <main className="shell adminPage">
    <header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{at("userManagementTitle")}</h1><p className="muted">{at("userManagementHint")}</p></div></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel">
      <div className="panelHead"><div><h2>{at("users")}</h2><p className="muted">{at("groupsSelfManaged")}</p></div><span className="count">{users.length}</span></div>
      <form className="adminCreateForm" onSubmit={createUser}>
        <input aria-label={at("name")} placeholder={at("name")} required minLength={2} value={newUser.name} onChange={(event) => setNewUser({ ...newUser, name: event.target.value })} />
        <input aria-label={at("email")} type="email" placeholder={at("email")} required value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} />
        <input aria-label={at("password")} type="password" placeholder={at("passwordMinimum")} required minLength={10} value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} />
        <select aria-label={at("role")} value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}><option value="user">{at("userRole")}</option><option value="admin">{at("administratorRole")}</option></select>
        <button className="primaryButton" disabled={creatingUser}>{creatingUser ? at("creatingUser") : at("createUser")}</button>
      </form>
      <div className="adminUserList">{users.map((user) => <div className="adminUserRow" key={user.id}>
        <div><strong>{user.name}</strong><small>{user.email}</small><div className="adminUserMeta"><span>{at("registered")}: {new Date(user.createdAt).toLocaleString(locale)}</span><span>{at("lastConnection")}: {user.lastConnectedAt ? new Date(user.lastConnectedAt).toLocaleString(locale) : at("noConnection")}</span></div></div>
        <select value={user.roles[0] ?? "user"} onChange={(event) => void updateUser(user, { roles: [event.target.value] }).catch((value) => setError(value instanceof Error ? value.message : at("userUpdateError")))}><option value="user">{at("userRole")}</option><option value="admin">{at("administratorRole")}</option></select>
        <select value={user.status} onChange={(event) => void updateUser(user, { status: event.target.value as AdminUser["status"] }).catch((value) => setError(value instanceof Error ? value.message : at("userUpdateError")))}><option value="active">{at("activeStatus")}</option><option value="disabled">{at("disabledStatus")}</option></select>
      </div>)}</div>
    </section>
  </main>;
}

export default function AdminUsersPage() {
  return <AuthGate><UserAdminContent /></AuthGate>;
}
