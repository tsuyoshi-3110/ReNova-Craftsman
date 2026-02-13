// src/app/projects/[projectId]/board/BoardClient.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

type BoardPdf = {
  target?: string;
  url?: string;
  fileName?: string;
  uploadedByEmail?: string;
  createdAt?: unknown;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export default function BoardClient(props: { initialProjectId: string }) {
  const router = useRouter();

  const projectId = useMemo(
    () => toNonEmptyString(props.initialProjectId),
    [props.initialProjectId],
  );

  const session = useMemo(
    () => (typeof window === "undefined" ? null : loadCraftsmanSession()),
    [],
  );

  const projectName =
    (session?.projectId === projectId ? session?.projectName : null) ?? null;

  const [ready, setReady] = useState(false); // auth guard 完了
  const [busy, setBusy] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [items, setItems] = useState<Array<{ id: string; data: BoardPdf }>>([]);

  // auth guard（ログイン必須）
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        router.replace("/login");
        return;
      }
      setReady(true);
    });
    return () => unsub();
  }, [router]);

  // boardPdfs 取得
  useEffect(() => {
    if (!ready) return;
    if (!projectId) return;

    let mounted = true;

    (async () => {
      try {
        setBusy(true);
        setErrorText(null);

        const colRef = collection(db, "projects", projectId, "boardPdfs");
        const qy = query(
          colRef,
          where("target", "==", "craftsman"),
          orderBy("createdAt", "desc"),
        );

        const snap = await getDocs(qy);

        const rows: Array<{ id: string; data: BoardPdf }> = snap.docs.map(
          (d) => ({
            id: d.id,
            data: d.data() as BoardPdf,
          }),
        );

        if (!mounted) return;
        setItems(rows);
      } catch (e) {
        console.log("board pdf list error:", e);
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
  }, [ready, projectId]);

  if (!projectId) return null;
  if (!ready) return null;

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              掲示板（職人用PDF）
            </div>
            <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
              現場：{projectName || "（名称未設定）"}
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              router.push(`/projects/${encodeURIComponent(projectId)}/menu`)
            }
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
              職人用PDFはまだありません。
            </div>
          ) : (
            items.map((it) => {
              const url = toNonEmptyString(it.data.url);
              return (
                <button
                  key={it.id}
                  type="button"
                  disabled={!url}
                  onClick={() => {
                    if (!url) return;
                    window.location.assign(url);
                  }}
                  className="rounded-2xl border bg-white p-4 text-left hover:bg-gray-50 disabled:opacity-60
                             dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900/70"
                >
                  <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                    {it.data.fileName || "PDF"}
                  </div>
                  <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                    {it.data.uploadedByEmail ? `by ${it.data.uploadedByEmail}` : ""}
                  </div>
                  {!url && (
                    <div className="mt-2 text-xs font-bold text-red-600">
                      URLがありません
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="mt-3 text-xs font-bold text-gray-500 dark:text-gray-400">
          ※ PDFは標準ビューアで開きます。横向きに回転すると横で見れます。ピンチで拡大縮小できます。
        </div>
      </div>
    </main>
  );
}
