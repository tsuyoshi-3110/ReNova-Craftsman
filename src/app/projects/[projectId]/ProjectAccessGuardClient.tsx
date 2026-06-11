"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";

type Props = {
  projectId: string;
};

export default function ProjectAccessGuardClient({ projectId }: Props) {
  const router = useRouter();
  const redirectedRef = useRef(false);

  useEffect(() => {
    let unsubProject: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, (u) => {
      if (unsubProject) {
        unsubProject();
        unsubProject = null;
      }

      if (!u) {
        if (redirectedRef.current) return;
        redirectedRef.current = true;
        router.replace("/login");
        return;
      }

      const myProjectRef = doc(db, "users", u.uid, "myProjects", projectId);
      unsubProject = onSnapshot(myProjectRef, (snap) => {
        if (redirectedRef.current) return;
        if (!snap.exists()) return;

        const data = snap.data() as { revoked?: unknown };
        if (data.revoked === true) {
          redirectedRef.current = true;
          router.replace("/projects");
        }
      });
    });

    return () => {
      if (unsubProject) {
        unsubProject();
        unsubProject = null;
      }
      unsubAuth();
    };
  }, [projectId, router]);

  return null;
}
