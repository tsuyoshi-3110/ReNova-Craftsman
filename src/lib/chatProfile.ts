import { doc, getDoc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

type RenovaMemberDoc = {
  uid?: string;
  name?: string;
  email?: string;

  projectId?: string;
  projectName?: string | null;
};

type CraftsmanDoc = {
  uid?: string;
  name?: string;
  company?: string;
  email?: string;

  projectId?: string;
  projectName?: string | null;
};

export type ChatRole = "manager" | "craftsman";

export type ChatProfile = {
  uid: string;
  role: ChatRole;
  name: string;
  email?: string;
  projectId: string;
  projectName: string | null;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export async function loadChatProfile(db: Firestore, uid: string): Promise<ChatProfile | null> {
  // 1) 作業員を先に見る（renova-craftsman）
  {
    const snap = await getDoc(doc(db, "craftsmen", uid));
    if (snap.exists()) {
      const d = snap.data() as CraftsmanDoc;

      const projectId = toNonEmptyString(d.projectId);
      if (!projectId) return null;

      const name = toNonEmptyString(d.name) || "作業員";
      const projectName = d.projectName ?? null;

      return {
        uid,
        role: "craftsman",
        name,
        email: toNonEmptyString(d.email) || undefined,
        projectId,
        projectName,
      };
    }
  }

  // 2) 管理者（Renova）
  {
    const snap = await getDoc(doc(db, "renovaMembers", uid));
    if (snap.exists()) {
      const d = snap.data() as RenovaMemberDoc;

      const projectId = toNonEmptyString(d.projectId);
      if (!projectId) return null;

      const name = toNonEmptyString(d.name) || "管理者";
      const projectName = d.projectName ?? null;

      return {
        uid,
        role: "manager",
        name,
        email: toNonEmptyString(d.email) || undefined,
        projectId,
        projectName,
      };
    }
  }

  return null;
}
