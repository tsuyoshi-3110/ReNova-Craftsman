// src/app/login/page.tsx
"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebaseClient";

function normalizeText(s: string): string {
  return s.trim();
}

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const canLogin = useMemo(() => {
    return normalizeText(email).length > 0 && normalizeText(password).length > 0;
  }, [email, password]);

  async function onLogin() {
    setErrorText(null);
    if (!canLogin) {
      setErrorText("メールアドレスとパスワードを入力してください。");
      return;
    }

    try {
      setBusy(true);
      await signInWithEmailAndPassword(auth, normalizeText(email), normalizeText(password));
      router.replace("/menu");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("auth/invalid-credential") || msg.includes("auth/wrong-password")) {
        setErrorText("メールアドレスまたはパスワードが違います。");
        return;
      }
      if (msg.includes("auth/user-not-found")) {
        setErrorText("このメールのアカウントが見つかりません。新規作成してください。");
        return;
      }
      setErrorText("ログインに失敗しました。通信状況をご確認ください。");
      console.error("login error:", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              ログイン
            </h1>
            <Link href="/register" className="text-sm font-extrabold text-blue-600">
              新規作成へ
            </Link>
          </div>

          {errorText && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-bold text-red-700">{errorText}</p>
            </div>
          )}

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
              disabled={busy || !canLogin}
              className="mt-2 w-full rounded-xl bg-blue-600 py-2.5 text-white font-extrabold disabled:opacity-60"
            >
              {busy ? "ログイン中..." : "ログイン"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
