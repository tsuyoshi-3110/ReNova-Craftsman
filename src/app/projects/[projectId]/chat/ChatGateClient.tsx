// src/app/projects/[projectId]/chat/ChatGateClient.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";

type ChatRole = "manager" | "craftsman" | "resident" | "proclink";

type ProjectMemberDoc = {
  uid?: string;
  role?: "owner" | "member";
  memberRole?: ChatRole;

  name?: string;
  displayName?: string;
  email?: string;

  company?: string;
  phone?: string;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

async function getMemberDocByUid(projectId: string, uid: string) {
  // 1) ドキュメントID=uid の場合（あなたのスクショはこれ）
  const ref1 = doc(db, "projects", projectId, "members", uid);
  const snap1 = await getDoc(ref1);
  if (snap1.exists()) return snap1.data() as ProjectMemberDoc;

  // 2) もし docId が uid じゃない運用もあり得るので fallback（uid フィールド検索）
  const col = collection(db, "projects", projectId, "members");
  const qy = query(col, where("uid", "==", uid));
  const qs = await getDocs(qy);
  if (!qs.empty) return qs.docs[0].data() as ProjectMemberDoc;

  return null;
}

export default function ChatGateClient(props: { initialProjectId: string }) {
  const router = useRouter();

  const projectId = useMemo(
    () => toNonEmptyString(props.initialProjectId),
    [props.initialProjectId],
  );

  const [busy, setBusy] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          if (!mounted) return;
          router.replace("/login");
          return;
        }

        if (!projectId) {
          if (!mounted) return;
          setErrorText("現場IDが指定されていません。");
          setBusy(false);
          return;
        }

        // ✅ ここが重要：profile は craftsmen じゃなくて projects/{projectId}/members から取る
        const mem = await getMemberDocByUid(projectId, u.uid);
        if (!mem) {
          if (!mounted) return;
          setErrorText(
            "この現場のメンバー情報が見つかりません。管理者に確認してください。",
          );
          setBusy(false);
          return;
        }

        const roomId = "main";

        // room を用意
        await setDoc(
          doc(db, "projects", projectId, "chatRooms", roomId),
          {
            id: roomId,
            type: "project",
            name: "現場チャット",
            projectId,
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
          },
          { merge: true },
        );

        // ✅ ここでルームに入る
        if (!mounted) return;
        router.replace(
          `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(roomId)}`,
        );
      } catch (e) {
        console.log("chat gate error:", e);
        if (!mounted) return;
        setErrorText("チャットの開始に失敗しました。");
        setBusy(false);
      } finally {
        if (!mounted) return;
        setBusy(false);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [projectId, router]);

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
            現場チャット
          </div>

          {errorText ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700">{errorText}</p>
            </div>
          ) : (
            <div className="mt-4 text-sm font-bold text-gray-700 dark:text-gray-200">
              {busy ? "入室中..." : "準備完了"}
            </div>
          )}

          <div className="mt-6">
            <button
              type="button"
              onClick={() =>
                router.push(`/projects/${encodeURIComponent(projectId)}/menu`)
              }
              className="w-full rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                         dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
            >
              メニューへ戻る
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
