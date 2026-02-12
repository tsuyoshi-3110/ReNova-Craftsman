"use client";

import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import { loadChatProfile, type ChatProfile } from "@/lib/chatProfile";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export default function ChatGatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectIdFromQuery = searchParams.get("projectId");

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

        const profile: ChatProfile | null = await loadChatProfile(db, u.uid);
        if (!profile) {
          if (!mounted) return;
          setErrorText("プロフィール/現場情報が見つかりません。管理者に確認してください。");
          setBusy(false);
          return;
        }

        const session = loadCraftsmanSession();
        const projectId =
          toNonEmptyString(projectIdFromQuery) ||
          toNonEmptyString(session?.projectId) ||
          toNonEmptyString(profile.projectId);

        const projectName =
          (session?.projectName ?? null) ||
          (profile.projectName ?? null);

        if (!projectId) {
          if (!mounted) return;
          setErrorText("現場IDが指定されていません。");
          setBusy(false);
          return;
        }

        // 1現場=1ルーム（main）を作成/更新（無ければ作る）
        const roomId = "main";
        await setDoc(
          doc(db, "projects", projectId, "chatRooms", roomId),
          {
            id: roomId,
            type: "project",
            name: "現場チャット",
            projectId,
            projectName,
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
          },
          { merge: true },
        );

        if (!mounted) return;
        router.replace(`/chat/${roomId}?projectId=${encodeURIComponent(projectId)}`);
      } catch (e) {
        console.log("chat gate error:", e);
        if (!mounted) return;
        setErrorText("チャットの開始に失敗しました。");
        setBusy(false);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [router]);

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
              onClick={() => {
                const pid = toNonEmptyString(projectIdFromQuery) || toNonEmptyString(loadCraftsmanSession()?.projectId);
                router.push(pid ? `/menu?projectId=${encodeURIComponent(pid)}` : "/menu");
              }}
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
