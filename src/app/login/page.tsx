// src/app/login/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { auth } from "@/lib/firebaseClient";
import { deleteDoc, doc, getDoc } from "firebase/firestore";
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
  const [resetBusy, setResetBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [successText, setSuccessText] = useState<string | null>(null);

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

  async function onDeleteCraftsmanAccount() {
    setErrorText(null);
    setSuccessText(null);

    const user = auth.currentUser;
    if (!user) {
      setErrorText("ログイン情報が取得できませんでした。もう一度ログインしてください。");
      return;
    }

    const ok = window.confirm(
      "作業員アカウントを削除します。作業員プロフィールが削除され、ログアウトします。よろしいですか？",
    );
    if (!ok) return;

    try {
      setDeleteBusy(true);
      await deleteDoc(doc(db, "craftsmen", user.uid));
      await signOut(auth);
      setSuccessText("作業員アカウントを削除しました。");
      router.replace("/login");
    } catch (e) {
      console.error("delete craftsman account error:", e);
      setErrorText("アカウント削除に失敗しました。通信状況をご確認ください。");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function onResetPassword() {
    setErrorText(null);
    setSuccessText(null);

    const normalizedEmail =
      normalizeText(email) || normalizeText(auth.currentUser?.email ?? "");
    if (!normalizedEmail) {
      setErrorText("先にメールアドレスを入力してください。");
      return;
    }

    try {
      setResetBusy(true);
      await sendPasswordResetEmail(auth, normalizedEmail);
      setSuccessText("パスワード再設定メールを送信しました。メールをご確認ください。");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("reset password error:", e);

      if (msg.includes("auth/user-not-found")) {
        setErrorText("このメールのアカウントが見つかりません。メールアドレスをご確認ください。");
        return;
      }

      setErrorText("再設定メールの送信に失敗しました。通信状況をご確認ください。");
    } finally {
      setResetBusy(false);
    }
  }

  const canLogin = useMemo(() => {
    return (
      normalizeText(email).length > 0 && normalizeText(password).length > 0
    );
  }, [email, password]);

  async function onLogin() {
    setErrorText(null);
    setSuccessText(null);
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
      <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-md flex-col justify-center px-4 py-8">
        <div className="mb-8 flex justify-center">
          <Image
            src="/craftsman.png"
            alt="ProcNova Craftsman"
            width={312}
            height={312}
            priority
            className="h-[16.5rem] w-[16.5rem] rounded-3xl object-contain sm:h-[19.5rem] sm:w-[19.5rem]"
          />
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              ログイン
            </h1>

            {authedUid && (
              <button
                type="button"
                onClick={() => void onLogout()}
                disabled={busy || deleteBusy}
                aria-label="ログアウト"
                title="ログアウト"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 active:scale-95 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <LogOut className="h-5 w-5" />
              </button>
            )}
          </div>

          {errorText && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-bold text-red-700">{errorText}</p>
            </div>
          )}

          {successText && (
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3">
              <p className="text-sm font-bold text-green-700">{successText}</p>
            </div>
          )}

          {authedUid && (
            <div className="mt-5 grid gap-3">
              <button
                type="button"
                onClick={() => void onResetPassword()}
                disabled={busy || resetBusy || deleteBusy}
                className="w-full rounded-xl border border-blue-300 bg-blue-50 py-3 text-sm font-extrabold text-blue-700 hover:bg-blue-100 disabled:opacity-60
                           dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/50"
              >
                {resetBusy ? "送信中..." : "パスワードを忘れた方はこちら"}
              </button>
              <p className="text-xs font-bold leading-relaxed text-gray-500 dark:text-gray-400">
                登録メールアドレス宛にパスワード再設定メールを送信します。
              </p>

              <button
                type="button"
                onClick={() => void onDeleteCraftsmanAccount()}
                disabled={busy || resetBusy || deleteBusy}
                className="w-full rounded-xl border border-red-300 bg-red-50 py-3 text-sm font-extrabold text-red-700 hover:bg-red-100 disabled:opacity-60
                           dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
              >
                {deleteBusy ? "削除中..." : "作業員アカウント削除"}
              </button>
              <p className="text-xs font-bold leading-relaxed text-gray-500 dark:text-gray-400">
                ※
                Proclink共通のログイン情報は残し、このアプリの作業員プロフィールを削除します。
              </p>
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
                  style={{ fontSize: 16 }}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy || resetBusy}
                  autoComplete="email"
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
                  style={{ fontSize: 16 }}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  autoComplete="current-password"
                  placeholder="8文字以上推奨"
                />
              </label>

              <button
                type="button"
                onClick={() => void onLogin()}
                disabled={busy || resetBusy || !canLogin || !!authedUid}
                className="mt-2 w-full rounded-xl bg-blue-600 py-3 text-white font-extrabold disabled:opacity-60"
              >
                {busy ? "ログイン中..." : authedUid ? "ログイン済み" : "ログイン"}
              </button>

              <button
                type="button"
                onClick={() => void onResetPassword()}
                disabled={busy || resetBusy || !!authedUid}
                className="block w-full py-3 text-center text-sm font-extrabold text-blue-600 underline underline-offset-2 disabled:opacity-60"
              >
                {resetBusy ? "送信中..." : "パスワードを忘れた方はこちら"}
              </button>

              <Link
                href="/craftsman/register"
                className="block w-full py-3 text-center text-sm font-extrabold text-emerald-700"
              >
                proclinkでアカウントお持ちの方はこちらへ
              </Link>

              <Link
                href="/register"
                className="block w-full py-3 text-center text-sm font-extrabold text-blue-600"
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
