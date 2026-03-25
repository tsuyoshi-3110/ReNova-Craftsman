// src/app/login/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth } from "@/lib/firebaseClient";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";

function normalizeText(s: string): string {
  return s.trim();
}

export default function LoginPage() {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [authedUid, setAuthedUid] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthedUid(u ? u.uid : null);

      // 参考：ログイン済みのメールを入力欄に入れておく（空のときだけ）
      if (u?.email && !normalizeText(email)) {
        setEmail(u.email);
      }
    });
    return () => unsub();
    // email は初期セット用途なので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onLogout() {
    try {
      setBusy(true);
      await signOut(auth);
      setErrorText(null);
      router.replace("/login");
    } catch (e) {
      console.error("logout error:", e);
      setErrorText("ログアウトに失敗しました。通信状況をご確認ください。");
    } finally {
      setBusy(false);
    }
  }

  const canLogin = useMemo(() => {
    return (
      normalizeText(email).length > 0 && normalizeText(password).length > 0
    );
  }, [email, password]);

  async function onLogin() {
    setErrorText(null);
    if (!canLogin) {
      setErrorText("メールアドレスとパスワードを入力してください。");
      return;
    }

    try {
      setBusy(true);
      const cred = await signInWithEmailAndPassword(
        auth,
        normalizeText(email),
        normalizeText(password),
      );

      const memSnap = await getDoc(doc(db, "proclinkMember", cred.user.uid));
      const craftSnap = await getDoc(doc(db, "craftsmen", cred.user.uid));

      // ✅ proclinkMember に存在し、かつ craftsmen が未作成なら登録画面へ
      if (memSnap.exists() && !craftSnap.exists()) {
        router.replace("/craftsman/register");
        return;
      }

      // それ以外は通常どおり
      router.replace("/projects");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("auth/invalid-credential") ||
        msg.includes("auth/wrong-password")
      ) {
        setErrorText("メールアドレスまたはパスワードが違います。");
        return;
      }
      if (msg.includes("auth/user-not-found")) {
        setErrorText(
          "このメールのアカウントが見つかりません。新規作成してください。",
        );
        return;
      }
      setErrorText("ログインに失敗しました。通信状況をご確認ください。");
      console.error("login error:", e);
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;
  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              ログイン
            </h1>

            {authedUid && (
              <button
                type="button"
                onClick={() => void onLogout()}
                disabled={busy}
                className="rounded-xl border px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60
                           dark:border-gray-800 dark:text-gray-100 dark:hover:bg-gray-900"
              >
                ログアウト
              </button>
            )}
          </div>

          {errorText && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-bold text-red-700">{errorText}</p>
            </div>
          )}

          {!authedUid && (
            <div className="mt-5 grid gap-3">
              <label className="block">
                <div className="mb-1 text-sm font-bold text-gray-800 dark:text-gray-200">
                  メールアドレス
                </div>
                <input
                  className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  inputMode="email"
                  placeholder="例）aaa@example.com"
                />
              </label>

              <label className="block">
                <div className="mb-1 text-sm font-bold text-gray-800 dark:text-gray-200">
                  パスワード
                </div>
                <input
                  type="password"
                  className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  placeholder="8文字以上推奨"
                />
              </label>

              <button
                type="button"
                onClick={() => void onLogin()}
                disabled={busy || !canLogin || !!authedUid}
                className="mt-2 w-full rounded-xl bg-blue-600 py-2.5 text-white font-extrabold disabled:opacity-60"
              >
                {busy ? "ログイン中..." : authedUid ? "ログイン済み" : "ログイン"}
              </button>

              <Link
                href="/craftsman/register"
                className="mt-3 block w-full text-center text-sm font-extrabold text-emerald-700"
              >
                proclinkでアカウントお持ちの方はこちらへ
              </Link>

              <Link
                href="/register"
                className="mt-2 block w-full text-center text-sm font-extrabold text-blue-600"
              >
                アカウント作成はこちら
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
