"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";

type MemberRole = "manager" | "craftsman" | "resident" | "proclink";
type Role = "owner" | "member";

type ProjectMemberDoc = {
  uid?: string;

  // 一般的な権限ロール（編集可否など用）
  role?: Role;

  // ドメインロール（ReNova: manager/ craftsman/ resident）
  memberRole?: MemberRole;

  // 表示用
  name?: string;
  displayName?: string;

  // プロフィール
  company?: string;
  phone?: string;
  address?: string;
  email?: string;

  // timestamps
  createdAt?: unknown;
  updatedAt?: unknown;
  joinedAt?: unknown;
};

type Item = { id: string; data: ProjectMemberDoc };

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function makeRoomKey(a: string, b: string): string {
  return [a, b].sort().join("__");
}

function countUnreadForMe(
  rows: Array<{ id: string; data: Record<string, unknown> }>,
  myUid: string,
): number {
  return rows.filter((row) => {
    const data = row.data;
    const toUid = toNonEmptyString(data.toUid);
    const senderUid = toNonEmptyString(data.senderUid);
    const readBy = Array.isArray(data.readBy)
      ? data.readBy.filter((v): v is string => typeof v === "string")
      : [];

    return (
      !!myUid &&
      toUid === myUid &&
      senderUid !== myUid &&
      !readBy.includes(myUid)
    );
  }).length;
}

export default function ManagersClient(props: { initialProjectId: string }) {
  const router = useRouter();

  const projectId = useMemo(
    () => toNonEmptyString(props.initialProjectId),
    [props.initialProjectId],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [unreadByUid, setUnreadByUid] = useState<Record<string, number>>({});

  // auth guard
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) router.replace("/login");
    });
    return () => unsub();
  }, [router]);

  // load managers
  useEffect(() => {
    if (!projectId) {
      router.replace("/projects");
      return;
    }

    let mounted = true;

    (async () => {
      try {
        setBusy(true);
        setErrorText(null);

        // ✅ ReNova: projects/{projectId}/members から memberRole == "manager" を取得
        const colRef = collection(db, "projects", projectId, "members");
        const qy = query(colRef, where("memberRole", "==", "manager"));
        const snap = await getDocs(qy);

        const rows: Item[] = snap.docs.map((d) => ({
          id: d.id,
          data: d.data() as ProjectMemberDoc,
        }));

        if (!mounted) return;
        setItems(rows);
      } catch (e) {
        console.log("managers list error:", e);
        if (!mounted) return;
        setErrorText("管督員一覧の取得に失敗しました。");
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

  useEffect(() => {
    if (!projectId) return;

    const myUid = auth.currentUser?.uid ?? "";
    if (!myUid) {
      setUnreadByUid({});
      return;
    }
    if (items.length === 0) {
      setUnreadByUid({});
      return;
    }

    const unsubscribers: Array<() => void> = [];

    items.forEach((it) => {
      const peerUid = toNonEmptyString(it.data.uid) || it.id;
      if (!peerUid || peerUid === myUid) return;

      const roomKey = makeRoomKey(myUid, peerUid);
      const colRef = collection(
        db,
        "projects",
        projectId,
        "dmRooms",
        roomKey,
        "messages",
      );
      const qy = query(colRef, orderBy("createdAt", "asc"), limit(300));

      const unsub = onSnapshot(
        qy,
        (snap) => {
          const rows: Array<{ id: string; data: Record<string, unknown> }> = [];
          snap.forEach((d) =>
            rows.push({ id: d.id, data: d.data() as Record<string, unknown> }),
          );

          const unread = countUnreadForMe(rows, myUid);
          setUnreadByUid((prev) => {
            if ((prev[peerUid] ?? 0) === unread) return prev;
            return { ...prev, [peerUid]: unread };
          });
        },
        (err) => {
          console.log("managers unread snapshot error:", err);
        },
      );

      unsubscribers.push(unsub);
    });

    return () => {
      unsubscribers.forEach((fn) => fn());
    };
  }, [items, projectId]);

  if (loading) return null;

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              管督員一覧
            </div>
            <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
              現場ID：{projectId}
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
              この現場の管督員が見つかりません。
            </div>
          ) : (
            items.map((it) => {
              const display =
                toNonEmptyString(it.data.name) ||
                toNonEmptyString(it.data.displayName) ||
                "監督";

              const company = toNonEmptyString(it.data.company);
              const phone = toNonEmptyString(it.data.phone);
              const targetUid = toNonEmptyString(it.data.uid) || it.id;
              const unreadCount = unreadByUid[targetUid] ?? 0;

              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() =>
                    router.push(`/dm/${encodeURIComponent(it.id)}`)
                  }
                  className="rounded-2xl border bg-white p-4 text-left hover:bg-gray-50
                             dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900/70"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                      {display}
                    </div>
                    {unreadCount > 0 && (
                      <div className="inline-flex min-w-6 items-center justify-center rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-extrabold text-white">
                        {unreadCount}
                      </div>
                    )}
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
