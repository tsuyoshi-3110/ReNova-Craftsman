// src/lib/craftsmanSession.ts
export type CraftsmanSession = {
  projectId: string;
  projectName?: string | null;
};

const KEY = "CRAFTSMAN_SESSION_V1";

export function saveCraftsmanSession(s: CraftsmanSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(s));
}

export function loadCraftsmanSession(): CraftsmanSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<CraftsmanSession>;
    if (!obj?.projectId) return null;
    return { projectId: String(obj.projectId), projectName: obj.projectName ?? null };
  } catch {
    return null;
  }
}

export function clearCraftsmanSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
