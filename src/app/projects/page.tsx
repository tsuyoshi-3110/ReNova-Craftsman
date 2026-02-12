"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type DocumentData,
} from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";

type MyProjectRow = {
  id: string; // = projectId（または sourceProjectId）
  name: string;
  role: "owner" | "member";
  ownerUid: string;
};

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  return "";
}

function normalizeCode(input: string): string {
  return input.replace(/\s+/g, "").trim().toUpperCase();
}

type ShareCodeDoc = {
  projectId?: string;
  projectName?: string;
  enabled?: boolean;
  ownerUid?: string;
};

type ProjectMeta = {
  name?: string;
  ownerUid?: string;
};

type CraftsmanProfile = {
  name?: string;
  company?: string;
  phone?: string;
  address?: string;
  workType?: string;
};

export default function ProjectsPage() {
  const router = useRouter();

  const [uid, setUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MyProjectRow[]>([]);
  const [errorText, setErrorText] = useState<string>("");

  const [joinCodeRaw, setJoinCodeRaw] = useState<string>("");
  const [joinBusy, setJoinBusy] = useState<boolean>(false);
  const [joinInfo, setJoinInfo] = useState<string>("");
  const [joinOpen, setJoinOpen] = useState<boolean>(false);

  async function loadProjects(myUid: string) {
    const ref = collection(db, "users", myUid, "myProjects");
    const q = query(ref, orderBy("createdAt", "desc"));
    const snap = await getDocs(q);

    const rows: MyProjectRow[] = snap.docs.map((d) => {
      const data = d.data() as DocumentData;
      const projectId = d.id;
      return {
        id: projectId,
        name: toStr(data.projectName) || toStr(data.name) || "(名称未設定)",
        role: data.role === "member" ? "member" : "owner",
        ownerUid: toStr(data.ownerUid),
      };
    });

    setItems(rows);
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setErrorText("");
      if (!u) {
        setUid(null);
        setItems([]);
        setLoading(false);
        router.replace("/login");
        return;
      }

      setUid(u.uid);

      try {
        setLoading(true);
        await loadProjects(u.uid);
      } catch {
        setErrorText("工事一覧の取得に失敗しました。");
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  async function handleJoinByShareCode() {
    const myUid = uid;
    if (!myUid) return;

    setErrorText("");
    setJoinInfo("");

    const code = normalizeCode(joinCodeRaw);
    if (!code) {
      setErrorText("シェアコードを入力してください。");
      return;
    }

    setJoinBusy(true);

    try {
      // 1) shareCodes/{code}
      const scRef = doc(db, "shareCodes", code);
      const scSnap = await getDoc(scRef);
      if (!scSnap.exists()) {
        setErrorText("シェアコードが見つかりません。");
        return;
      }

      const sc = scSnap.data() as ShareCodeDoc;
      if (sc.enabled === false) {
        setErrorText("このシェアコードは無効です。");
        return;
      }

      const projectId = toStr(sc.projectId);
      if (!projectId) {
        setErrorText("シェアコードの設定が不完全です（projectIdなし）。");
        return;
      }

      // 2) project name / ownerUid を補完
      let projectName = toStr(sc.projectName);
      let ownerUid = toStr(sc.ownerUid);

      const pRef = doc(db, "projects", projectId);
      const pSnap = await getDoc(pRef);
      if (pSnap.exists()) {
        const p = pSnap.data() as ProjectMeta;
        if (!projectName) projectName = toStr(p.name);
        if (!ownerUid) ownerUid = toStr(p.ownerUid);
      }

      // 3) 自分のプロフィール（membersに同梱する用）
      const cRef = doc(db, "craftsmen", myUid);
      const cSnap = await getDoc(cRef);
      const cp = cSnap.exists() ? (cSnap.data() as CraftsmanProfile) : null;
      const displayName =
        toStr(cp?.name) || (auth.currentUser?.displayName ?? "") || "職人";

      // 4) users/{uid}/myProjects/{projectId}
      await setDoc(
        doc(db, "users", myUid, "myProjects", projectId),
        {
          projectId,
          projectName: projectName || null,
          role: "member",
          ownerUid: ownerUid || null,
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          joinedAt: serverTimestamp(),
        },
        { merge: true },
      );

      // 5) projects/{projectId}/members/{uid}
      await setDoc(
        doc(db, "projects", projectId, "members", myUid),
        {
          uid: myUid,
          role: "craftsman",
          displayName,
          company: cp?.company ?? "",
          phone: cp?.phone ?? "",
          address: cp?.address ?? "",
          workType: cp?.workType ?? "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      setJoinInfo(`参加しました：${projectName || projectId}`);
      setJoinCodeRaw("");
      setJoinOpen(false);

      // refresh list
      await loadProjects(myUid);
    } catch (e) {
      console.log("join by share code error:", e);
      setErrorText("参加処理に失敗しました。");
    } finally {
      setJoinBusy(false);
    }
  }

  const hasItems = useMemo(() => items.length > 0, [items.length]);

  if (loading) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-md px-4 py-10 text-sm font-bold text-gray-700 dark:text-gray-200">
          読み込み中...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
          工事一覧
        </div>
        <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
          ログイン: {uid ?? "-"}
        </div>

        <div className="mt-6 grid gap-3">
          {!hasItems ? (
            <div className="rounded-2xl border bg-white p-4 text-sm font-bold text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
              参加中の工事がありません。
            </div>
          ) : (
            items.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  router.push(`/menu?projectId=${encodeURIComponent(p.id)}`)
                }
                className="rounded-2xl border bg-white px-4 py-4 text-left hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900"
              >
                <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                  {p.name}
                </div>
                <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                  role: {p.role} / projectId: {p.id}
                </div>
              </button>
            ))
          )}
        </div>

        {errorText && !joinOpen && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">{errorText}</p>
          </div>
        )}
      </div>

      {/* Floating action button */}
      <button
        type="button"
        onClick={() => {
          setErrorText("");
          setJoinInfo("");
          setJoinOpen(true);
        }}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gray-900 text-white shadow-lg hover:opacity-90
                   dark:bg-white dark:text-gray-900"
        aria-label="工事に参加"
      >
        <span className="text-3xl leading-none">+</span>
      </button>

      {/* Join modal */}
      {joinOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50">
          <div className="flex items-start justify-center p-3 pt-6 sm:items-center sm:p-4">
            <div className="w-[90vw] max-w-md max-h-[calc(100svh-3rem)] overflow-y-auto rounded-2xl border bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl dark:border-gray-800 dark:bg-gray-950">
              <div className="relative">
                <div className="pl-12">
                  <div className="text-base font-extrabold text-gray-900 dark:text-gray-100">
                    シェアコードで工事に参加
                  </div>
                  <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                    管理者から受け取ったシェアコードを入力してください。
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setJoinOpen(false)}
                  aria-label="閉じる"
                  className="absolute left-0 top-0 rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                             dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
                >
                  ×
                </button>
              </div>

              <div className="mt-4 flex gap-2">
                <input
                  className="w-full rounded-xl border px-3 py-2 text-base font-bold text-gray-900 placeholder:text-gray-400
                             dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                  value={joinCodeRaw}
                  onChange={(ev) => setJoinCodeRaw(ev.target.value)}
                  disabled={joinBusy}
                  placeholder="例）B4WMSG"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => void handleJoinByShareCode()}
                  disabled={joinBusy}
                  className="shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-50
                             dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
                >
                  参加
                </button>
              </div>

              {errorText && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
                  <p className="text-sm font-semibold text-red-700">
                    {errorText}
                  </p>
                </div>
              )}

              {joinInfo && (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <p className="text-sm font-extrabold text-emerald-700">
                    {joinInfo}
                  </p>
                </div>
              )}

              <div className="mt-4 text-right">
                <button
                  type="button"
                  onClick={() => setJoinOpen(false)}
                  disabled={joinBusy}
                  className="rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-50
                             dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
