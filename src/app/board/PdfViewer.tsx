// src/app/pdfs/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";

import { db } from "@/lib/firebaseClient";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

type BoardPdf = {
  target?: string;
  url?: string;
  fileName?: string;
  uploadedByEmail?: string;
  createdAt?: unknown;
};

export default function CraftsmanPdfsPage() {
  const router = useRouter();

  const session = useMemo(
    () => (typeof window === "undefined" ? null : loadCraftsmanSession()),
    [],
  );

  const [errorText, setErrorText] = useState<string | null>(null);
  const [items, setItems] = useState<Array<{ id: string; data: BoardPdf }>>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!session?.projectId) {
      router.replace("/menu");
      return;
    }

    let mounted = true;

    (async () => {
      try {
        setBusy(true);
        setErrorText(null);

        const colRef = collection(db, "projects", session.projectId, "boardPdfs");
        const qy = query(
          colRef,
          where("target", "==", "craftsman"),
          orderBy("createdAt", "desc"),
        );

        const snap = await getDocs(qy);
        const rows: Array<{ id: string; data: BoardPdf }> = [];
        snap.forEach((d) => rows.push({ id: d.id, data: d.data() as BoardPdf }));

        if (!mounted) return;
        setItems(rows);
      } catch (e) {
        console.log("craftsman pdf list error:", e);
        if (!mounted) return;
        setErrorText("PDF一覧の取得に失敗しました。");
      } finally {
        if (!mounted) return;
        setBusy(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [router, session?.projectId]);

  if (!session) return null;

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              職人向けPDF一覧
            </div>
            <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
              現場：{session.projectName || "（名称未設定）"}
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
              職人向けPDFはまだありません。
            </div>
          ) : (
            items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => router.push(`/board/${it.id}`)}
                className="rounded-2xl border bg-white p-4 text-left hover:bg-gray-50
                           dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900/70"
              >
                <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                  {it.data.fileName || "PDF"}
                </div>
                <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                  {it.data.uploadedByEmail ? `by ${it.data.uploadedByEmail}` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </main>
  );
}
