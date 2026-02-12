"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getDocs, query, where } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

type ProjectMember = {
  uid?: string;
  role?: string; // "manager" 想定
  name?: string;
  company?: string;
  phone?: string;
  email?: string;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export default function ManagersPage() {
  const router = useRouter();

  const session = useMemo(
    () => (typeof window === "undefined" ? null : loadCraftsmanSession()),
    [],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [items, setItems] = useState<Array<{ id: string; data: ProjectMember }>>([]);

  const projectId = toNonEmptyString(session?.projectId);

  // auth guard
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) router.replace("/login");
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!projectId) {
      router.replace("/menu");
      return;
    }

    let mounted = true;

    (async () => {
      try {
        setBusy(true);
        setErrorText(null);

        // ✅ projects/{projectId}/members の「manager」を一覧
        const colRef = collection(db, "projects", projectId, "members");
        const qy = query(colRef, where("role", "==", "manager"));
        const snap = await getDocs(qy);

        const rows: Array<{ id: string; data: ProjectMember }> = [];
        snap.forEach((d) => rows.push({ id: d.id, data: d.data() as ProjectMember }));

        if (!mounted) return;
        setItems(rows);
      } catch (e) {
        console.log("managers list error:", e);
        if (!mounted) return;
        setErrorText("監督員一覧の取得に失敗しました。");
      } finally {
        if (!mounted) return;
        setBusy(false);
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [router, projectId]);

  if (loading) return null;

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              監督員一覧
            </div>
            <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
              現場：{session?.projectName || "（名称未設定）"}
            </div>
          </div>

          <button
            type="button"
            onClick={() => router.push("/menu")}
            className="rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                       dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
          >
            戻る
          </button>
        </div>

        {errorText && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">{errorText}</p>
          </div>
        )}

        <div className="mt-6 grid gap-3">
          {busy ? (
            <div className="rounded-2xl border bg-white p-4 text-sm font-bold text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200">
              読み込み中...
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border bg-white p-4 text-sm font-bold text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200">
              この現場の監督員が見つかりません。
            </div>
          ) : (
            items.map((it) => {
              const name = toNonEmptyString(it.data.name) || "監督員";
              const company = toNonEmptyString(it.data.company);
              const phone = toNonEmptyString(it.data.phone);

              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => router.push(`/dm/${encodeURIComponent(it.id)}`)}
                  className="rounded-2xl border bg-white p-4 text-left hover:bg-gray-50
                             dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900/70"
                >
                  <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                    {name}
                  </div>
                  <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                    {company ? `会社：${company}` : ""}
                    {company && phone ? " / " : ""}
                    {phone ? `TEL：${phone}` : ""}
                  </div>
                  <div className="mt-2 text-xs font-bold text-blue-600">
                    DMを開く
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}
