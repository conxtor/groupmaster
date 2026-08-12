"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  roles: string[];
};

export async function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(`${apiBase.replace(/\/$/, "")}${path}`, { ...init, credentials: "include" });
}

export function AccountBar({ user }: { user: AuthUser }) {
  const router = useRouter();
  const isAdmin = user.roles.includes("admin");

  async function logout() {
    await apiFetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return <div className="accountBar">
    <span className="accountIdentity"><strong>{user.name}</strong><small>{user.email}</small></span>
    {isAdmin && <Link href="/admin">Administration</Link>}
    <button type="button" className="textButton" onClick={() => void logout()}>Abmelden</button>
  </div>;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void apiFetch("/api/v1/auth/me").then(async (response) => {
      if (!active) return;
      if (!response.ok) {
        router.replace(`/login?next=${encodeURIComponent(pathname || "/")}`);
        return;
      }
      setUser(await response.json() as AuthUser);
      setLoading(false);
    }).catch(() => {
      if (active) router.replace(`/login?next=${encodeURIComponent(pathname || "/")}`);
    });
    return () => { active = false; };
  }, [pathname, router]);

  if (loading || !user) return <main className="shell authLoading"><p className="muted">Sitzung wird geprüft …</p></main>;
  return <><AccountBar user={user} />{children}</>;
}
