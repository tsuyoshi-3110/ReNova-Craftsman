"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import {
  loadChatProfile,
  type ChatProfile,
  type ChatRole,
} from "@/lib/chatProfile";

type ChatMessage = {
  text?: string;
  senderUid?: string;
  senderName?: string;
  senderRole?: ChatRole;
  createdAt?: unknown;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function mapMsg(d: QueryDocumentSnapshot<DocumentData>): {
  id: string;
  data: ChatMessage;
} {
  return { id: d.id, data: d.data() as ChatMessage };
}

export default function ChatRoomPage() {
  const router = useRouter();
  const params = useParams<{ roomId: string }>();
  const roomId = toNonEmptyString(params?.roomId) || "main";

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ChatProfile | null>(null);

  const [errorText, setErrorText] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Array<{ id: string; data: ChatMessage }>>(
    [],
  );

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const projectId = useMemo(
    () => toNonEmptyString(profile?.projectId),
    [profile?.projectId],
  );

  // 1) Auth → プロファイル（craftsmen or renovaMembers）
  useEffect(() => {
    let mounted = true;

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          if (!mounted) return;
          router.replace("/login");
          return;
        }

        const p = await loadChatProfile(db, u.uid);
        if (!mounted) return;

        if (!p) {
          setProfile(null);
          setErrorText("プロフィール/現場情報が見つかりません。");
          setLoading(false);
          return;
        }

        setProfile(p);
        setLoading(false);
      } catch (e) {
        console.log("chat profile error:", e);
        if (!mounted) return;
        setProfile(null);
        setErrorText("プロフィール取得に失敗しました。");
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [router]);

  // 2) messages を購読（projectId が確定してから）
  useEffect(() => {
    if (!projectId) return;

    setErrorText(null);

    const colRef = collection(
      db,
      "projects",
      projectId,
      "chatRooms",
      roomId,
      "messages",
    );
    const qy = query(colRef, orderBy("createdAt", "asc"), limit(300));

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: Array<{ id: string; data: ChatMessage }> = [];
        snap.forEach((d) => rows.push(mapMsg(d)));
        setMsgs(rows);
      },
      (err) => {
        console.log("chat onSnapshot error:", err);
        setErrorText("チャットの取得に失敗しました。");
      },
    );

    return () => unsub();
  }, [projectId, roomId]);

  // 3) スクロール制御（下に追従したい時だけ追従）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    if (!stickToBottomRef.current) return;

    // 新着で最下部へ
    el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;

    // 下端から少し上までを「下追従」とみなす
    const threshold = 40;
    const atBottom =
      el.scrollHeight - (el.scrollTop + el.clientHeight) < threshold;
    stickToBottomRef.current = atBottom;
  }

  async function send() {
    if (!profile) return;

    const t = toNonEmptyString(text);
    if (!t) return;

    if (!projectId) return;

    try {
      setSending(true);

      const colRef = collection(
        db,
        "projects",
        projectId,
        "chatRooms",
        roomId,
        "messages",
      );

      await addDoc(colRef, {
        text: t,
        senderUid: profile.uid,
        senderName: profile.name,
        senderRole: profile.role,
        createdAt: serverTimestamp(),
      });

      setText("");
      stickToBottomRef.current = true;
    } catch (e) {
      console.log("send message error:", e);
      setErrorText("送信に失敗しました。通信状況をご確認ください。");
    } finally {
      setSending(false);
    }
  }

  if (loading) return null;
  if (!profile) return null;

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      {/* ヘッダ */}
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-950/80">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              現場チャット
            </div>
            <div className="truncate text-xs font-bold text-gray-500 dark:text-gray-400">
              現場：{profile.projectName || "（名称未設定）"} / {profile.name}（
              {profile.role === "manager" ? "監督" : "職人"}）
            </div>
          </div>

          <button
            type="button"
            onClick={() => router.push("/menu")}
            className="shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                       dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
          >
            戻る
          </button>
        </div>
      </div>

      {/* 本文 */}
      <div className="mx-auto w-full max-w-2xl px-3 py-3">
        {errorText && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">{errorText}</p>
          </div>
        )}

        <div className="rounded-2xl border bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
          {/* メッセージ一覧 */}
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="h-[calc(100dvh-210px)] overflow-y-auto px-3 py-3"
          >
            {msgs.length === 0 ? (
              <div className="rounded-xl border bg-white p-4 text-sm font-bold text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                まだメッセージがありません。
              </div>
            ) : (
              <div className="grid gap-2">
                {msgs.map((m) => {
                  const mine = m.data.senderUid === profile.uid;
                  const sender = toNonEmptyString(m.data.senderName) || "不明";
                  const body = toNonEmptyString(m.data.text) || "";
                  const badge =
                    m.data.senderRole === "manager" ? "監督" : "職人";

                  return (
                    <div
                      key={m.id}
                      className={
                        mine ? "flex justify-end" : "flex justify-start"
                      }
                    >
                      <div
                        className={[
                          "max-w-[90%] rounded-2xl border px-3 py-2",
                          mine
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800",
                        ].join(" ")}
                      >
                        {!mine && (
                          <div className="mb-1 text-[11px] font-extrabold opacity-80">
                            {sender}（{badge}）
                          </div>
                        )}
                        <div className="whitespace-pre-wrap text-sm font-bold leading-relaxed">
                          {body}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 送信欄 */}
          <div className="border-t bg-white px-3 py-3 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-end gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="メッセージを入力..."
                rows={2}
                className="w-full resize-none rounded-xl border px-3 py-2 font-bold text-gray-900
             focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                style={{ fontSize: 16 }}
                disabled={sending}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || !toNonEmptyString(text)}
                className="shrink-0 rounded-xl bg-blue-600 px-4 py-2 text-sm font-extrabold text-white disabled:opacity-60"
              >
                送信
              </button>
            </div>
            <div className="mt-2 text-[11px] font-bold text-gray-500 dark:text-gray-400">
              ※
              画像/動画は次のステップで追加できます（まずはテキストで安定させる）
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
