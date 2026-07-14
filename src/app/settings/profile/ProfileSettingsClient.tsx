// src/app/settings/profile/ProfileSettingsClient.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  onAuthStateChanged,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

import { AsYouType } from "libphonenumber-js";
import { auth, db } from "@/lib/firebaseClient";
import { expandWorkTypesToSubtitleNames } from "@/lib/workItemNames";
import CraftsmanNavBar from "@/components/CraftsmanNavBar";

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

// workType 文字列（"防水 / シーリング" など）を候補配列に分解
function splitWorkTypes(v: string): string[] {
  return v
    .split(/[/、,・]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 職人の工種は工事に依存しないグローバルな属性のため、固定リストから複数選択する
const WORK_TYPE_OPTIONS = [
  "足場",
  "下地補修",
  "シーリング",
  "塗装",
  "防水",
  "長尺シート",
  "美装",
  "その他",
] as const;

export default function ProfileSettingsClient() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [selectedWorkTypes, setSelectedWorkTypes] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [savedText, setSavedText] = useState<string | null>(null);

  const canSave = useMemo(() => {
    const p = normalizePhoneForSave(phone);
    return (
      !!toNonEmptyString(name) &&
      !!toNonEmptyString(address) &&
      p.length >= 10 &&
      p.length <= 11 &&
      !!toNonEmptyString(company) &&
      selectedWorkTypes.length > 0
    );
  }, [name, address, phone, company, selectedWorkTypes]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null);
          setLoading(false);
          router.replace("/login");
          return;
        }

        setUser(u);

        const snap = await getDoc(doc(db, "craftsmen", u.uid));
        if (!snap.exists()) {
          setLoading(false);
          router.replace("/register");
          return;
        }

        const p = snap.data() as Record<string, unknown>;
        setName(toNonEmptyString(p.name));
        setAddress(toNonEmptyString(p.address));
        setPhone(formatPhoneJP(toNonEmptyString(p.phone)));
        setCompany(toNonEmptyString(p.company));

        // 保存済みの工種のうち固定リストに一致するものを事前選択
        const saved = splitWorkTypes(toNonEmptyString(p.workType));
        setSelectedWorkTypes(
          WORK_TYPE_OPTIONS.filter((nm) => saved.includes(nm)),
        );

        setLoading(false);
      } catch (e) {
        console.error("profile load error:", e);
        setErrorText("プロフィールの取得に失敗しました。");
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  async function handleSave() {
    if (!user) return;

    setErrorText(null);
    setSavedText(null);

    const n = toNonEmptyString(name);
    const a = toNonEmptyString(address);
    const p = normalizePhoneForSave(phone);
    const c = toNonEmptyString(company);
    const w = selectedWorkTypes.join(" / ");

    if (!n || !a || p.length < 10 || p.length > 11 || !c || !w) {
      setErrorText("未入力の項目があります。");
      return;
    }

    try {
      setBusy(true);

      await setDoc(
        doc(db, "craftsmen", user.uid),
        {
          name: n,
          address: a,
          phone: p, // ✅ 数字のみで保存
          company: c,
          workType: w,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      await updateProfile(user, { displayName: n });

      // 参加中の全工事の members に workItemNames を自動同期
      // （proclink の「取り扱い工事」設定と同じ保存先・同じ形式）
      // 参加工事は保存時に users/{uid}/myProjects から直接取得する
      try {
        const mpSnap = await getDocs(
          collection(db, "users", user.uid, "myProjects"),
        );
        const projectIds = mpSnap.docs
          .filter((d) => d.data()?.revoked !== true)
          .map((d) => d.id);

        await Promise.all(
          projectIds.map(async (pid) => {
            try {
              // 存在する場合のみ更新（削除済みメンバーを復活させないため）
              const memberRef = doc(db, "projects", pid, "members", user.uid);
              const memberSnap = await getDoc(memberRef);
              if (!memberSnap.exists()) return;

              // 工事の subtitle 名に展開して保存
              // （proclink の工種一覧は subtitle 名との完全一致でフィルタするため）
              const names = await expandWorkTypesToSubtitleNames(
                db,
                pid,
                selectedWorkTypes,
              );

              await setDoc(
                memberRef,
                {
                  workItemNames: names,
                  // backward compatibility (single string)
                  workItemName: names[0] ?? "",
                  updatedAt: serverTimestamp(),
                },
                { merge: true },
              );
            } catch (e) {
              console.warn(`workItemNames sync error (${pid}):`, e);
            }
          }),
        );
      } catch (e) {
        console.warn("workItemNames sync (myProjects) error:", e);
      }

      setSavedText("プロフィールを保存しました。");
    } catch (e) {
      console.error("profile save error:", e);
      setErrorText("保存に失敗しました。通信状況をご確認ください。");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-md px-4 py-10">
          <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
              読み込み中...
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!user) return null;

  return (
    <main className="min-h-dvh bg-gray-50 pb-24 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
                プロフィール設定
              </div>
              <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                {toNonEmptyString(user.email) || ""}
              </div>
            </div>
          </div>

          {errorText && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700">{errorText}</p>
            </div>
          )}

          {savedText && (
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3">
              <p className="text-sm font-semibold text-green-700">
                {savedText}
              </p>
            </div>
          )}

          <div className="mt-6 grid gap-3">
            <Field label="名前">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                style={{ fontSize: 16 }}
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                disabled={busy}
                placeholder="例）山田 太郎"
              />
            </Field>

            <Field label="住所">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                style={{ fontSize: 16 }}
                value={address}
                onChange={(ev) => setAddress(ev.target.value)}
                disabled={busy}
                placeholder="例）大阪府〇〇市..."
              />
            </Field>

            <Field label="電話番号">
              <input
                className="w-full rounded-xl border px-3 py-2 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
                style={{ fontSize: 16 }}
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
                style={{ fontSize: 16 }}
                value={company}
                onChange={(ev) => setCompany(ev.target.value)}
                disabled={busy}
                placeholder="例）TS工業"
              />
            </Field>

            <Field label="工種">
              <div className="flex flex-wrap gap-2">
                {WORK_TYPE_OPTIONS.map((nm) => {
                  const selected = selectedWorkTypes.includes(nm);
                  return (
                    <button
                      key={nm}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setSelectedWorkTypes((prev) =>
                          prev.includes(nm)
                            ? prev.filter((v) => v !== nm)
                            : [...prev, nm],
                        )
                      }
                      className={
                        selected
                          ? "rounded-xl border border-blue-600 bg-blue-600 px-3 py-2 text-sm font-extrabold text-white disabled:opacity-60"
                          : "rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
                      }
                    >
                      {nm}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                ※ 複数選択できます（選択中:{" "}
                {selectedWorkTypes.length > 0
                  ? selectedWorkTypes.join(" / ")
                  : "-"}
                ）
              </div>
            </Field>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || !canSave}
              className="mt-2 w-full rounded-xl bg-blue-600 py-3 text-white font-extrabold disabled:opacity-60"
            >
              {busy ? "保存中..." : "保存する"}
            </button>
          </div>
        </div>
      </div>

      <CraftsmanNavBar />
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
