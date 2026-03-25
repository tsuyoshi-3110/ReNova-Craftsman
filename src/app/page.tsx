"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";

export default function Home() {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          router.replace("/login");
          return;
        }

        const snap = await getDoc(doc(db, "craftsmen", user.uid));
        if (!snap.exists()) {
          await signOut(auth);
          router.replace("/login");
          return;
        }

        router.replace("/projects");
      } catch (e) {
        console.error("home auth check error:", e);
        try {
          await signOut(auth);
        } catch {}
        router.replace("/login");
      } finally {
        setChecking(false);
      }
    });

    return () => unsub();
  }, [router, mounted]);

  if (!mounted) return null;
  if (checking) return null;
  return null;
}
