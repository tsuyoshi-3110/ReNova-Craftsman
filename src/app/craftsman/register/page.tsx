"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

import { AsYouType } from "libphonenumber-js";
import { auth, db } from "@/lib/firebaseClient";

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

// 表示用：入力を整形（日本としてフォーマット）
function formatPhoneJP(input: string): string {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  const cleaned = hasPlus ? `+${digitsOnly}` : digitsOnly;

  if (!cleaned) return "";

  try {
    return new AsYouType("JP").input(cleaned);
  } catch {
    return cleaned;
  }
}

// 保存用：数字のみ（09012345678）
function normalizePhoneForSave(input: string): string {
  const digits = input.replace(/[^\d]/g, "").trim();
  if (digits.startsWith("81") && digits.length === 12) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

export default function CraftsmanRegisterPage() {

  const router = useRouter();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  // phone は「表示用」を state に持つ（入力中フォーマット）
  const [phone, setPhone] = useState("");

  const [company, setCompany] = useState("");
  const [workType, setWorkType] = useState("");

  // ✅ 入力欄はそのまま使う（未ログイン時にこれでログインする）
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // ✅ いまログイン済みか（= 既存ユーザーで craftsmen 未作成の可能性）
  const [authedUid, setAuthedUid] = useState<string | null>(null);

  // ✅ StrictMode等で二重に走ってもループしないガード
  const redirectedRef = useRef(false);

  const canSubmitProfile = useMemo(() => {
    const p = normalizePhoneForSave(phone);
    return (
      !!toNonEmptyString(name) &&
      !!toNonEmptyString(address) &&
      p.length >= 10 &&
      p.length <= 11 &&
      !!toNonEmptyString(company) &&
      !!toNonEmptyString(workType)
    );
  }, [name, address, phone, company, workType]);

  // ✅ 未ログイン時に「Proclinkのメール/パスでログイン」するために必要
  const canLogin = useMemo(() => {
    return !!toNonEmptyString(email) && !!toNonEmptyString(password);
  }, [email, password]);

  // ✅ ログイン済みでも即遷移しない。craftsmen/{uid} が存在する時だけ遷移。
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setAuthedUid(null);
          return;
        }

        setAuthedUid(u.uid);

        // 入力欄のメールに、現在ログイン中の email を入れておく（見た目維持のため）
        if (!toNonEmptyString(email) && toNonEmptyString(u.email)) {
          setEmail(u.email ?? "");
        }
        if (!toNonEmptyString(name) && toNonEmptyString(u.displayName)) {
          setName(u.displayName ?? "");
        }

        const snap = await getDoc(doc(db, "craftsmen", u.uid));
        if (snap.exists()) {
          if (!redirectedRef.current) {
            redirectedRef.current = true;
            router.replace("/projects");
          }
        }
        // craftsmen が無い場合：ここに残して保存させる
      } catch (e) {
        console.error("craftsmen check error:", e);
        setAuthedUid(u ? u.uid : null);
      }
    });

    return () => unsub();
    // email/name の初期セット用途なので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function saveProfileOnly(args: { uid: string; usedEmail: string }) {
    const n = toNonEmptyString(name);
    const a = toNonEmptyString(address);
    const p = normalizePhoneForSave(phone);
    const c = toNonEmptyString(company);
    const w = toNonEmptyString(workType);

    if (!n || !a || p.length < 10 || p.length > 11 || !c || !w) {
      throw new Error("PROFILE_INCOMPLETE");
    }

    await setDoc(
      doc(db, "craftsmen", args.uid),
      {
        uid: args.uid,
        role: "member",
        memberRole: "craftsman",
        name: n,
        address: a,
        phone: p,
        company: c,
        workType: w,
        email: args.usedEmail,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  async function handleRegisterOrSave() {
    setErrorText(null);

    try {
      setBusy(true);

      const current = auth.currentUser;

      // ✅ 既にログイン済み → プロフィールだけ保存
      if (current) {
        const usedEmail =
          toNonEmptyString(current.email) || toNonEmptyString(email);

        await updateProfile(current, { displayName: toNonEmptyString(name) });

        await saveProfileOnly({
          uid: current.uid,
          usedEmail,
        });

        router.replace("/projects");
        return;
      }

      // ✅ 未ログイン → Proclinkのメール/パスでログイン → craftsmen 保存
      if (!canLogin) {
        setErrorText("メールアドレスとパスワードを入力してください。");
        return;
      }
      if (!canSubmitProfile) {
        setErrorText("未入力の項目があります。");
        return;
      }

      const e = toNonEmptyString(email);
      const pass = toNonEmptyString(password);

      const cred = await signInWithEmailAndPassword(auth, e, pass);

      await updateProfile(cred.user, { displayName: toNonEmptyString(name) });

      await saveProfileOnly({
        uid: cred.user.uid,
        usedEmail: e,
      });

      router.replace("/projects");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      if (msg === "PROFILE_INCOMPLETE") {
        setErrorText("未入力の項目があります。");
        return;
      }

      // ✅ ここは「ログイン失敗」系に寄せる（新規作成はしない）
      if (
        msg.includes("auth/invalid-credential") ||
        msg.includes("auth/wrong-password")
      ) {
        setErrorText("メールアドレスまたはパスワードが違います。");
        return;
      }
      if (msg.includes("auth/user-not-found")) {
        setErrorText(
          "このメールのアカウントが見つかりません。Proclink側で作成済みか確認してください。",
        );
        return;
      }
      if (msg.includes("auth/invalid-email")) {
        setErrorText("メールアドレスの形式が正しくありません。");
        return;
      }

      setErrorText("処理に失敗しました。通信状況をご確認ください。");
      console.error("craftsman register/save error:", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
                職人プロフィール登録
              </div>
              <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                proclinkのアカウントをお持ちの方は、ここで職人情報を登録してください
              </div>
            </div>
          </div>

          {errorText && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700">{errorText}</p>
            </div>
          )}

          <div className="mt-6 grid gap-3">
            <Field label="名前">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                disabled={busy}
                placeholder="例）山田 太郎"
              />
            </Field>

            <Field label="住所">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                value={address}
                onChange={(ev) => setAddress(ev.target.value)}
                disabled={busy}
                placeholder="例）大阪府〇〇市..."
              />
            </Field>

            <Field label="電話番号">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                value={phone}
                onChange={(ev) => {
                  const raw = ev.target.value;
                  setPhone(formatPhoneJP(raw));
                }}
                onBlur={() => {
                  setPhone((prev) => formatPhoneJP(prev));
                }}
                disabled={busy}
                placeholder="例）090-1234-5678"
                inputMode="tel"
                autoComplete="tel"
              />
              <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                ※ 保存時は数字のみ（{normalizePhoneForSave(phone) || "-"}）
              </div>
            </Field>

            <Field label="所属会社名">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                value={company}
                onChange={(ev) => setCompany(ev.target.value)}
                disabled={busy}
                placeholder="例）TS工業"
              />
            </Field>

            <Field label="工種">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                value={workType}
                onChange={(ev) => setWorkType(ev.target.value)}
                disabled={busy}
                placeholder="例）防水 / シーリング / 下地補修..."
              />
            </Field>

            {/* ✅ 入力欄は「同じ」：未ログイン時だけ表示（見た目維持） */}
            {!authedUid && (
              <>
                <Field label="メールアドレス">
                  <input
                    className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                    value={email}
                    onChange={(ev) => setEmail(ev.target.value)}
                    disabled={busy}
                    placeholder="例）aaa@example.com"
                    inputMode="email"
                    autoComplete="email"
                  />
                </Field>

                <Field label="パスワード">
                  <input
                    type="password"
                    className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    disabled={busy}
                    placeholder="proclinkと同じパスワード"
                    autoComplete="current-password"
                  />
                </Field>
              </>
            )}

            <button
              type="button"
              onClick={() => void handleRegisterOrSave()}
              disabled={
                busy ||
                (authedUid ? !canSubmitProfile : !canSubmitProfile || !canLogin)
              }
              className="mt-2 w-full rounded-xl bg-blue-600 py-2.5 text-white font-extrabold disabled:opacity-60"
            >
              {busy
                ? "処理中..."
                : authedUid
                  ? "プロフィール保存"
                  : "ログインして保存"}
            </button>

            <button
              type="button"
              onClick={() => router.push("/login")}
              disabled={busy}
              className="w-full rounded-xl border bg-white py-2.5 font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60
                         dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
            >
              ログイン画面に戻る
            </button>

            {authedUid && (
              <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                ※
                すでにログイン済みのため、ここではプロフィール情報のみ保存します。
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-sm font-extrabold text-gray-800 dark:text-gray-200">
        {label}
      </div>
      {children}
    </div>
  );
}
