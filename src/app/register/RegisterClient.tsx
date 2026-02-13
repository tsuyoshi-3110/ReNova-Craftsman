"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
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
  // 先頭の + だけ許可、それ以外は数字のみ
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  const cleaned = hasPlus ? `+${digitsOnly}` : digitsOnly;

  if (!cleaned) return "";

  try {
    // AsYouType().input() の戻り値は「入力途中でも自然な表示」になり、テンプレ(x)を返さない
    return new AsYouType("JP").input(cleaned);
  } catch {
    // フォーマット失敗時は数字(+任意)だけ返す
    return cleaned;
  }
}

// 保存用：数字のみ（09012345678）
function normalizePhoneForSave(input: string): string {
  const digits = input.replace(/[^\d]/g, "").trim();
  // +81(日本)の形で入力された場合を 0 始まりに寄せる（例: +819012345678 -> 09012345678）
  if (digits.startsWith("81") && digits.length === 12) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

export default function RegisterClient() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  // phone は「表示用」を state に持つ（入力中フォーマット）
  const [phone, setPhone] = useState("");

  const [company, setCompany] = useState("");
  const [workType, setWorkType] = useState("");

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
      // 10-11桁想定（携帯/固定どちらでも）
      p.length >= 10 &&
      p.length <= 11 &&
      !!toNonEmptyString(company) &&
      !!toNonEmptyString(workType)
    );
  }, [name, address, phone, company, workType]);

  const canCreateAuth = useMemo(() => {
    return (
      canSubmitProfile &&
      !!toNonEmptyString(email) &&
      !!toNonEmptyString(password)
    );
  }, [canSubmitProfile, email, password]);

  // ✅ ログイン済みでも即 /menu に飛ばさない。
  // craftsmen/{uid} が「存在する」時だけ /menu
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setAuthedUid(null);
          return;
        }

        setAuthedUid(u.uid);

        const snap = await getDoc(doc(db, "craftsmen", u.uid));
        if (snap.exists()) {
          if (!redirectedRef.current) {
            redirectedRef.current = true;
            router.replace("/menu");
          }
        }
        // existsしないなら：登録画面に残してプロフィール保存させる
      } catch (e) {
        // 読めない（ルール/権限）時も、ここで /menu に飛ばすとループになるので残す
        console.error("craftsmen check error:", e);
        setAuthedUid(u ? u.uid : null);
      }
    });

    return () => unsub();
  }, [router]);

  async function saveProfileOnly(args: { uid: string; usedEmail: string }) {
    const n = toNonEmptyString(name);
    const a = toNonEmptyString(address);

    // ✅ 保存時は数字だけに統一
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
        phone: p, // ✅ 数字のみで保存
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

      // ✅ 既にログイン済み（Authはあるが craftsmen が無いケース）
      // → プロフィールだけ保存
      if (current) {
        const usedEmail =
          toNonEmptyString(current.email) || toNonEmptyString(email);

        await updateProfile(current, { displayName: toNonEmptyString(name) });

        await saveProfileOnly({
          uid: current.uid,
          usedEmail,
        });

        router.replace("/menu");
        return;
      }

      // ✅ 未ログイン → Auth 作成 → craftsmen 保存
      if (!canCreateAuth) {
        setErrorText("未入力の項目があります。");
        return;
      }

      const e = toNonEmptyString(email);
      const pass = toNonEmptyString(password);

      const cred = await createUserWithEmailAndPassword(auth, e, pass);

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

      if (msg.includes("auth/email-already-in-use")) {
        setErrorText("このメールは既に使われています。ログインしてください。");
        return;
      }
      if (msg.includes("auth/weak-password")) {
        setErrorText("パスワードが弱すぎます。");
        return;
      }
      if (msg.includes("auth/invalid-email")) {
        setErrorText("メールアドレスの形式が正しくありません。");
        return;
      }

      setErrorText("処理に失敗しました。通信状況をご確認ください。");
      console.error("register/save error:", e);
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
                アカウント作成
              </div>
              <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                まずプロフィールを登録し、ログイン後に工事一覧から参加します
              </div>
            </div>
          </div>

          {errorText && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700">{errorText}</p>
            </div>
          )}

          {/* ✅ 常に縦並び（1列） */}
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
                  // blur で一度きれいに整形（入力途中の崩れを戻す）
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

            {/* ✅ 未ログイン時だけ表示 */}
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
                    placeholder="8文字以上推奨"
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}

            <button
              type="button"
              onClick={() => void handleRegisterOrSave()}
              disabled={
                busy || (!authedUid ? !canCreateAuth : !canSubmitProfile)
              }
              className="mt-2 w-full rounded-xl bg-blue-600 py-2.5 text-white font-extrabold disabled:opacity-60"
            >
              {busy
                ? "処理中..."
                : authedUid
                  ? "プロフィール保存"
                  : "アカウント作成"}
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
