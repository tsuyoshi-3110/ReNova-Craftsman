// src/app/projects/[projectId]/menu/MenuClient.tsx
"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarRange,
  ChevronRight,
  FileText,
  HardHat,
  MapPin,
  MessageCircle,
  Users,
  type LucideIcon,
} from "lucide-react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import {
  loadCraftsmanSession,
  saveCraftsmanSession,
} from "@/lib/craftsmanSession";

type CraftsmanProfile = {
  uid?: string;
  name?: string;
  company?: string;

  // 旧：1現場運用
  projectId?: string;
  projectName?: string | null;

  // 新：複数現場（今後はこちらを優先）
  projects?: Array<{ projectId: string; projectName?: string | null }>;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function toMillis(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (
    typeof v === "object" &&
    v !== null &&
    "seconds" in v &&
    typeof (v as { seconds: unknown }).seconds === "number"
  ) {
    const seconds = (v as { seconds: number }).seconds;
    const nanoseconds =
      "nanoseconds" in v &&
      typeof (v as { nanoseconds?: unknown }).nanoseconds === "number"
        ? ((v as { nanoseconds: number }).nanoseconds ?? 0)
        : 0;
    return seconds * 1000 + Math.floor(nanoseconds / 1000000);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return 0;
}

type MenuAccent = "sky" | "indigo" | "amber" | "emerald" | "violet" | "slate";

type MenuItem = {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  accent: MenuAccent;
  badge?: number;
  onClick: () => void;
};

/** アイコンの下地。彩度を抑えて、現場で見ても目が疲れない濃さにする */
const ACCENT_STYLES: Record<MenuAccent, string> = {
  sky: "bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300",
  indigo:
    "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300",
  emerald:
    "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300",
  violet:
    "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export default function MenuClient({
  initialProjectId,
}: {
  initialProjectId?: string;
}) {
  const router = useRouter();

  const session = useMemo(() => loadCraftsmanSession(), []);

  // ✅ projectId は「URL params（initialProjectId）」を最優先。次に session。
  const resolvedProjectId = useMemo(() => {
    return (
      toNonEmptyString(initialProjectId) || toNonEmptyString(session?.projectId)
    );
  }, [initialProjectId, session]);

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [, setProfile] = useState<CraftsmanProfile | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [projectName, setProjectName] = useState<string | null>(null);
  const [hasPeriodChart, setHasPeriodChart] = useState(false);
  const [hasOverallSchedule, setHasOverallSchedule] = useState(false);
  const [hasLocationPhotos, setHasLocationPhotos] = useState(false);
  const [chatLastReadAtMillis, setChatLastReadAtMillis] = useState(0);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const checkOverallScheduleExists = useCallback(
    async (nextProjectId: string) => {
      const safeProjectId = toNonEmptyString(nextProjectId);
      if (!safeProjectId) {
        setHasOverallSchedule(false);
        return;
      }

      try {
        const overallSnap = await getDoc(
          doc(db, "projects", safeProjectId, "scheduleData", "overall"),
        );

        if (!overallSnap.exists()) {
          setHasOverallSchedule(false);
          return;
        }

        const data = overallSnap.data() as { shared?: unknown };
        setHasOverallSchedule(data.shared === true);
      } catch (e) {
        console.warn("overall schedule check error:", e);
        setHasOverallSchedule(false);
      }
    },
    [],
  );

  const checkPeriodChartExists = useCallback(async (nextProjectId: string) => {
    const safeProjectId = toNonEmptyString(nextProjectId);
    if (!safeProjectId) {
      setHasPeriodChart(false);
      return;
    }

    try {
      const periodSnap = await getDoc(
        doc(db, "projects", safeProjectId, "scheduleData", "periodChart"),
      );

      if (!periodSnap.exists()) {
        setHasPeriodChart(false);
        return;
      }

      const data = periodSnap.data() as { shared?: unknown };
      setHasPeriodChart(data.shared === true);
    } catch (e) {
      console.warn("periodChart check error:", e);
      setHasPeriodChart(false);
    }
  }, []);

  const checkLocationPhotosShared = useCallback(async (nextProjectId: string) => {
    const safeProjectId = toNonEmptyString(nextProjectId);
    if (!safeProjectId) { setHasLocationPhotos(false); return; }
    try {
      const snap = await getDoc(
        doc(db, "projects", safeProjectId, "locationPhotoDocumentsConfig", "share"),
      );
      setHasLocationPhotos(snap.exists() && snap.data()?.shared === true);
    } catch (e) {
      console.warn("locationPhotos share check error:", e);
      setHasLocationPhotos(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null);
          setProfile(null);
          setHasPeriodChart(false);
          setHasOverallSchedule(false);
          setHasLocationPhotos(false);
          setChatLastReadAtMillis(0);
          setChatUnreadCount(0);
          setLoading(false);
          router.replace("/login");
          return;
        }

        setUser(u);

        const ref = doc(db, "craftsmen", u.uid);
        const snap = await getDoc(ref);

        if (!snap.exists()) {
          setProfile(null);
          setHasPeriodChart(false);
          setHasOverallSchedule(false);
          setHasLocationPhotos(false);
          setChatLastReadAtMillis(0);
          setChatUnreadCount(0);
          setLoading(false);
          await signOut(auth);
          router.replace("/login");
          return;
        }

        const p = snap.data() as CraftsmanProfile;
        setProfile(p);

        const pickedProjectId = resolvedProjectId;

        if (!pickedProjectId) {
          setProjectId("");
          setProjectName(null);
          setHasPeriodChart(false);
          setHasOverallSchedule(false);
          setHasLocationPhotos(false);
          setChatLastReadAtMillis(0);
          setChatUnreadCount(0);
          setLoading(false);
          router.replace("/projects");
          return;
        }

        let pickedProjectName: string | null = session?.projectName ?? null;

        if (!pickedProjectName) {
          const legacyId = toNonEmptyString(p.projectId);
          if (legacyId && legacyId === pickedProjectId) {
            pickedProjectName = (p.projectName ?? null) as string | null;
          }

          const list = Array.isArray(p.projects)
            ? p.projects
                .map((x) => ({
                  projectId: toNonEmptyString(x.projectId),
                  projectName: x.projectName ?? null,
                }))
                .filter((x) => x.projectId)
            : [];

          const hit = list.find((x) => x.projectId === pickedProjectId);
          if (hit?.projectName) pickedProjectName = hit.projectName;
        }

        // それでも分からなければ、工事一覧と同じ場所（myProjects）から読む。
        // 一覧はここから名前を出しているが、メニューへ遷移するときに
        // 名前を渡していないため、セッションにも profile にも無いことがある。
        if (!pickedProjectName) {
          try {
            const mySnap = await getDoc(
              doc(db, "users", u.uid, "myProjects", pickedProjectId),
            );
            if (mySnap.exists()) {
              const my = mySnap.data() as Record<string, unknown>;
              pickedProjectName =
                toNonEmptyString(my.projectName) ||
                toNonEmptyString(my.name) ||
                null;
            }
          } catch (e) {
            console.log("myProjects name load failed:", e);
          }
        }

        setProjectId(pickedProjectId);
        setProjectName(pickedProjectName);
        setHasPeriodChart(false);
        setHasOverallSchedule(false);
        setHasLocationPhotos(false);

        saveCraftsmanSession({
          projectId: pickedProjectId,
          projectName: pickedProjectName ?? null,
        });

        setLoading(false);

        void Promise.all([
          checkPeriodChartExists(pickedProjectId),
          checkOverallScheduleExists(pickedProjectId),
          checkLocationPhotosShared(pickedProjectId),
        ]);
      } catch (e) {
        console.error("menu load error:", e);
        setUser(null);
        setProfile(null);
        setHasPeriodChart(false);
        setHasOverallSchedule(false);
        setHasLocationPhotos(false);
        setChatLastReadAtMillis(0);
        setChatUnreadCount(0);
        setLoading(false);
        router.replace("/login");
      }
    });

    return () => unsub();
  }, [
    router,
    resolvedProjectId,
    session,
    checkPeriodChartExists,
    checkOverallScheduleExists,
    checkLocationPhotosShared,
  ]);

  useEffect(() => {
    const uid = toNonEmptyString(user?.uid);
    if (!projectId || !uid) return;

    const ref = doc(
      db,
      "projects",
      projectId,
      "chatRooms",
      "main",
      "readStates",
      uid,
    );
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setChatLastReadAtMillis(0);
          return;
        }

        const data = snap.data() as {
          lastReadAt?: unknown;
        };
        setChatLastReadAtMillis(toMillis(data.lastReadAt));
      },
      (err) => {
        console.warn("menu readState onSnapshot error:", err);
        setChatLastReadAtMillis(0);
      },
    );

    return () => unsub();
  }, [projectId, user?.uid]);

  useEffect(() => {
    const uid = toNonEmptyString(user?.uid);
    if (!projectId || !uid) return;

    const colRef = collection(
      db,
      "projects",
      projectId,
      "chatRooms",
      "main",
      "messages",
    );
    const qy = query(colRef, orderBy("createdAt", "asc"));

    const unsub = onSnapshot(
      qy,
      (snap) => {
        let unread = 0;

        snap.forEach((d) => {
          const data = d.data() as {
            senderUid?: unknown;
            createdAt?: unknown;
          };
          const senderUid = toNonEmptyString(data.senderUid);
          const createdAtMillis = toMillis(data.createdAt);

          if (
            senderUid &&
            senderUid !== uid &&
            createdAtMillis > chatLastReadAtMillis
          ) {
            unread += 1;
          }
        });

        setChatUnreadCount(unread);
      },
      (err) => {
        console.warn("menu messages onSnapshot error:", err);
        setChatUnreadCount(0);
      },
    );

    return () => unsub();
  }, [projectId, user?.uid, chatLastReadAtMillis]);

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

  const menuItems: MenuItem[] = [
    ...(hasOverallSchedule
      ? [
          {
            key: "overall",
            title: "全体工程表",
            description: "工事全体の流れを確認",
            icon: CalendarRange,
            accent: "sky" as const,
            onClick: () =>
              router.push(
                `/projects/${encodeURIComponent(projectId)}/overall-schedule`,
              ),
          },
        ]
      : []),
    ...(hasPeriodChart
      ? [
          {
            key: "period",
            title: "期間工程表",
            description: "今月・今週の予定を確認",
            icon: CalendarDays,
            accent: "indigo" as const,
            onClick: () =>
              router.push(
                `/projects/${encodeURIComponent(projectId)}/period-chart`,
              ),
          },
        ]
      : []),
    {
      key: "board",
      title: "掲示板",
      description: "作業員用のPDFを確認",
      icon: FileText,
      accent: "amber" as const,
      onClick: () =>
        router.push(`/projects/${encodeURIComponent(projectId)}/board`),
    },
    ...(hasLocationPhotos
      ? [
          {
            key: "location-photos",
            title: "箇所写真管理",
            description: "図面上のピン情報を確認",
            icon: MapPin,
            accent: "emerald" as const,
            onClick: () =>
              router.push(
                `/projects/${encodeURIComponent(projectId)}/location-photos`,
              ),
          },
        ]
      : []),
    {
      key: "chat",
      title: "現場グループチャット",
      description: "画像・動画も共有して報告",
      icon: MessageCircle,
      accent: "violet" as const,
      badge: chatUnreadCount,
      onClick: () =>
        router.push(`/projects/${encodeURIComponent(projectId)}/chat`),
    },
    {
      key: "managers",
      title: "管理者一覧",
      description: "管理者へ個別にDMできます",
      icon: Users,
      accent: "slate" as const,
      onClick: () =>
        router.push(`/projects/${encodeURIComponent(projectId)}/managers`),
    },
    {
      key: "craftsmen",
      title: "作業員一覧",
      description: "同じ現場の作業員へ個別にDMできます",
      icon: HardHat,
      accent: "amber" as const,
      onClick: () =>
        router.push(`/projects/${encodeURIComponent(projectId)}/craftsmen`),
    },
  ];

  return (
    <main className="min-h-dvh bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-950 dark:to-gray-900">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-6">
        {/* 今どの工事を見ているか。ここから切り替えもできる */}
        <button
          type="button"
          onClick={() => router.push("/projects")}
          className="flex w-full items-center justify-between gap-2 rounded-2xl bg-white px-4 py-3 text-left shadow-sm ring-1 ring-gray-200/80 transition hover:shadow-md active:scale-[0.99] dark:bg-gray-900 dark:ring-gray-800"
        >
          <span className="min-w-0">
            <span className="block text-[10px] font-bold text-gray-500 dark:text-gray-400">
              現在の工事
            </span>
            <span className="block truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              {projectName || "（未選択）"}
            </span>
          </span>
          <span className="shrink-0 text-[11px] font-extrabold text-sky-700 dark:text-sky-300">
            切り替え
          </span>
        </button>

        <div className="mt-4 grid gap-2.5">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const accent = ACCENT_STYLES[item.accent];

            return (
              <button
                key={item.key}
                type="button"
                onClick={item.onClick}
                className="group flex w-full items-center gap-3 rounded-2xl bg-white p-3.5 text-left shadow-sm ring-1 ring-gray-200/80 transition hover:shadow-md active:scale-[0.99] dark:bg-gray-900 dark:ring-gray-800"
              >
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accent}`}
                >
                  <Icon className="h-5 w-5" />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-extrabold text-gray-900 dark:text-gray-100">
                      {item.title}
                    </span>
                    {item.badge && item.badge > 0 ? (
                      <span className="shrink-0 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-extrabold leading-none text-white">
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
                    {item.description}
                  </span>
                </span>

                <ChevronRight className="h-5 w-5 shrink-0 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-400 dark:text-gray-600" />
              </button>
            );
          })}
        </div>
      </div>
    </main>
  );
}
