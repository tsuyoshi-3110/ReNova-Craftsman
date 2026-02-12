"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";

export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          router.replace("/login");
          return;
        }

        // ✅ craftsmen/{uid} を確認（無ければ職人サイト利用不可）
        const snap = await getDoc(doc(db, "craftsmen", user.uid));
        if (!snap.exists()) {
          await signOut(auth);
          router.replace("/login");
          return;
        }

        router.replace("/projects");
      } catch (e) {
        console.error("home auth check error:", e);

        // 念のため安全側（ログアウト→ログインへ）
        try {
          await signOut(auth);
        } catch {
          // ignore
        }
        router.replace("/login");
      } finally {
        setChecking(false);
      }
    });

    return () => unsub();
  }, [router]);

  // 判定中は何も描画しない（チラつき防止）
  if (checking) return null;

  return null;
}
