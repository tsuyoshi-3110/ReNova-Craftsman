// src/app/projects/[projectId]/menu/MenuClient.tsx
"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import {
  loadCraftsmanSession,
  saveCraftsmanSession,
} from "@/lib/craftsmanSession";

type CraftsmanProfile = {
  uid?: string;
  name?: string;
  company?: string;

  // 旧：1現場運用
  projectId?: string;
  projectName?: string | null;

  // 新：複数現場（今後はこちらを優先）
  projects?: Array<{ projectId: string; projectName?: string | null }>;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export default function MenuClient({
  initialProjectId,
}: {
  initialProjectId?: string;
}) {
  const router = useRouter();

  const session = useMemo(() => loadCraftsmanSession(), []);

  // ✅ projectId は「URL params（initialProjectId）」を最優先。次に session。
  const resolvedProjectId = useMemo(() => {
    return (
      toNonEmptyString(initialProjectId) || toNonEmptyString(session?.projectId)
    );
  }, [initialProjectId, session]);

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<CraftsmanProfile | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null);
          setProfile(null);
          setLoading(false);
          router.replace("/login");
          return;
        }

        setUser(u);

        const ref = doc(db, "craftsmen", u.uid);
        const snap = await getDoc(ref);

        if (!snap.exists()) {
          setProfile(null);
          setLoading(false);
          await signOut(auth);
          router.replace("/login");
          return;
        }

        const p = snap.data() as CraftsmanProfile;
        setProfile(p);

        const pickedProjectId = resolvedProjectId;

        if (!pickedProjectId) {
          setProjectId("");
          setProjectName(null);
          setLoading(false);
          router.replace("/projects");
          return;
        }

        // projectName は session を優先。無ければ craftsman の legacy / projects から推測
        let pickedProjectName: string | null = session?.projectName ?? null;

        if (!pickedProjectName) {
          const legacyId = toNonEmptyString(p.projectId);
          if (legacyId && legacyId === pickedProjectId) {
            pickedProjectName = (p.projectName ?? null) as string | null;
          }

          const list = Array.isArray(p.projects)
            ? p.projects
                .map((x) => ({
                  projectId: toNonEmptyString(x.projectId),
                  projectName: x.projectName ?? null,
                }))
                .filter((x) => x.projectId)
            : [];

          const hit = list.find((x) => x.projectId === pickedProjectId);
          if (hit?.projectName) pickedProjectName = hit.projectName;
        }

        setProjectId(pickedProjectId);
        setProjectName(pickedProjectName);

        saveCraftsmanSession({
          projectId: pickedProjectId,
          projectName: pickedProjectName ?? null,
        });

        setLoading(false);
      } catch (e) {
        console.error("menu load error:", e);
        setUser(null);
        setProfile(null);
        setLoading(false);
        router.replace("/login");
      }
    });

    return () => unsub();
  }, [router, resolvedProjectId, session]);

  async function handleLogout() {
    await signOut(auth);
    router.replace("/login");
  }

  if (loading) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-md px-4 py-10">
          <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
              読み込み中...
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!user) return null;

  const name =
    toNonEmptyString(profile?.name) ||
    toNonEmptyString(user.displayName) ||
    "職人";
  const company = toNonEmptyString(profile?.company);

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
                メニュー
              </div>
              <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                {name}
                {company ? ` / ${company}` : ""}
                {projectName ? ` / ${projectName}` : ""}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleLogout()}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                         dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
            >
              ログアウト
            </button>
          </div>

          <button
            type="button"
            onClick={() => router.push("/projects")}
            className="mt-4 w-full rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                         dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
          >
            工事を切り替える
          </button>

          <div className="mt-6 grid gap-3">
            <button
              type="button"
              onClick={() => {
                console.log("projectId:", projectId);
                router.push(`/projects/${encodeURIComponent(projectId)}/board`);
              }}
              className="w-full rounded-2xl border bg-white p-4 text-left hover:bg-gray-50
                         dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900"
            >
              <div className="text-base font-extrabold text-gray-900 dark:text-gray-100">
                掲示板（職人用PDF）
              </div>
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                Renovaの職人用PDFを確認
              </div>
            </button>

            <button
              type="button"
              onClick={() =>
                router.push(`/projects/${encodeURIComponent(projectId)}/chat`)
              }
              className="w-full rounded-2xl border bg-white p-4 text-left hover:bg-gray-50
             dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900"
            >
              <div className="text-base font-extrabold text-gray-900 dark:text-gray-100">
                現場関係者グループチャット
              </div>
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                監督・職人で画像/動画も共有して報告
              </div>
            </button>

            <button
              type="button"
              onClick={() =>
                router.push(
                  `/projects/${encodeURIComponent(projectId)}/managers`,
                )
              }
              className="w-full rounded-2xl border bg-white p-4 text-left hover:bg-gray-50
             dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900"
            >
              <div className="text-base font-extrabold text-gray-900 dark:text-gray-100">
                監督員にDM
              </div>
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                監督員一覧を開いて個別にDMできます（画像/動画/PDFも送信予定）
              </div>
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
