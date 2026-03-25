// src/app/projects/[projectId]/period-chart/PeriodChartClient.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { auth, db } from "@/lib/firebaseClient";
import {
  loadCraftsmanSession,
  saveCraftsmanSession,
} from "@/lib/craftsmanSession";

type CraftsmanProfile = {
  uid?: string;
  name?: string;
  company?: string;
  projectId?: string;
  projectName?: string | null;
  projects?: Array<{ projectId: string; projectName?: string | null }>;
};

type ViewMode = "twoWeeks" | "month";

type PeriodChartSavedRow = {
  label: string;
  color: string;
  offset: number;
  duration: number;
  groupTitle: string;
};

type PeriodChartSavedPayload = {
  v: 1;
  savedAt: string;
  mode: ViewMode;
  month: string;
  startMonday: string;
  saturdayOff: boolean;
  holidayText: string;
  title: string;
  groups: string[];
  rows: PeriodChartSavedRow[];
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPeriodChartSavedRow(v: unknown): v is PeriodChartSavedRow {
  if (!isRecord(v)) return false;
  return (
    typeof v["label"] === "string" &&
    typeof v["color"] === "string" &&
    typeof v["offset"] === "number" &&
    typeof v["duration"] === "number" &&
    typeof v["groupTitle"] === "string"
  );
}

function isPeriodChartSavedPayload(v: unknown): v is PeriodChartSavedPayload {
  if (!isRecord(v)) return false;
  if (v["v"] !== 1) return false;
  if (v["mode"] !== "twoWeeks" && v["mode"] !== "month") return false;
  if (!Array.isArray(v["groups"])) return false;
  if (!Array.isArray(v["rows"])) return false;

  return (
    typeof v["savedAt"] === "string" &&
    typeof v["month"] === "string" &&
    typeof v["startMonday"] === "string" &&
    typeof v["saturdayOff"] === "boolean" &&
    typeof v["holidayText"] === "string" &&
    typeof v["title"] === "string" &&
    v["groups"].every((g) => typeof g === "string") &&
    v["rows"].every((row) => isPeriodChartSavedRow(row))
  );
}

function ymdKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromYmd(ymd: string): Date {
  return new Date(`${ymd}T00:00:00`);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getMonthDays(month: string): Date[] {
  if (!month) return [];
  const [y, m] = month.split("-").map((x) => Number(x));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const result: Date[] = [];
  for (let day = 1; day <= last.getDate(); day += 1) {
    result.push(new Date(first.getFullYear(), first.getMonth(), day));
  }
  return result;
}

function getTwoWeekDays(startMonday: string): Date[] {
  if (!startMonday) return [];
  const start = fromYmd(startMonday);
  return Array.from({ length: 14 }, (_, i) => addDays(start, i));
}

function parseHolidayText(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x !== ""),
  );
}

function weekdayLabel(date: Date): string {
  return ["日", "月", "火", "水", "木", "金", "土"][date.getDay()] ?? "";
}

function isWeekend(date: Date, saturdayOff: boolean): boolean {
  const day = date.getDay();
  if (day === 0) return true;
  if (day === 6 && saturdayOff) return true;
  return false;
}

export default function PeriodChartClient({
  initialProjectId,
}: {
  initialProjectId?: string;
}) {
  const router = useRouter();
  const session = useMemo(() => loadCraftsmanSession(), []);

  const resolvedProjectId = useMemo(() => {
    return (
      toNonEmptyString(initialProjectId) || toNonEmptyString(session?.projectId)
    );
  }, [initialProjectId, session]);

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<CraftsmanProfile | null>(null);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState<string | null>(null);
  const [chart, setChart] = useState<PeriodChartSavedPayload | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null);
          setProfile(null);
          setChart(null);
          setLoading(false);
          router.replace("/login");
          return;
        }

        setUser(u);

        const craftsmanSnap = await getDoc(doc(db, "craftsmen", u.uid));
        if (!craftsmanSnap.exists()) {
          setProfile(null);
          setChart(null);
          setLoading(false);
          await signOut(auth);
          router.replace("/login");
          return;
        }

        const p = craftsmanSnap.data() as CraftsmanProfile;
        setProfile(p);

        const pickedProjectId = resolvedProjectId;
        if (!pickedProjectId) {
          setProjectId("");
          setProjectName(null);
          setChart(null);
          setLoading(false);
          router.replace("/projects");
          return;
        }

        let pickedProjectName: string | null = session?.projectName ?? null;

        if (!pickedProjectName) {
          const legacyId = toNonEmptyString(p.projectId);
          if (legacyId && legacyId === pickedProjectId) {
            pickedProjectName = p.projectName ?? null;
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

        setProjectId(pickedProjectId);
        setProjectName(pickedProjectName);

        saveCraftsmanSession({
          projectId: pickedProjectId,
          projectName: pickedProjectName ?? null,
        });

        const periodSnap = await getDoc(
          doc(db, "projects", pickedProjectId, "scheduleData", "periodChart"),
        );

        if (!periodSnap.exists()) {
          setChart(null);
          setLoading(false);
          return;
        }

        const data = periodSnap.data() as unknown;
        if (!isPeriodChartSavedPayload(data)) {
          setChart(null);
          setLoading(false);
          return;
        }

        setChart(data);
        setLoading(false);
      } catch (e) {
        console.error("period chart load error:", e);
        setUser(null);
        setProfile(null);
        setChart(null);
        setLoading(false);
        router.replace("/login");
      }
    });

    return () => unsub();
  }, [router, resolvedProjectId, session]);

  const days = useMemo(() => {
    if (!chart) return [];
    return chart.mode === "twoWeeks"
      ? getTwoWeekDays(chart.startMonday)
      : getMonthDays(chart.month);
  }, [chart]);

  const displayDays = useMemo(() => {
    if (!chart) return [] as Date[];
    return days.filter((day) => day.getDay() !== 0);
  }, [chart, days]);

  const holidaySet = useMemo(() => {
    if (!chart) return new Set<string>();
    return parseHolidayText(chart.holidayText);
  }, [chart]);

  const activeDayIndexByYmd = useMemo(() => {
    const map = new Map<string, number>();
    displayDays.forEach((day, index) => {
      map.set(ymdKey(day), index);
    });
    return map;
  }, [displayDays]);

  const rowsByGroup = useMemo(() => {
    if (!chart) return [];
    return chart.groups.map((group) => ({
      group,
      rows: chart.rows.filter((r) => r.groupTitle === group),
    }));
  }, [chart]);

  const chartGridTemplate = useMemo(() => {
    if (!displayDays.length) return "88px";
    const labelWidth = chart?.mode === "month" ? 88 : 116;
    return `${labelWidth}px repeat(${displayDays.length}, minmax(0, 1fr))`;
  }, [chart?.mode, displayDays.length]);

  const rowHeightClass = "h-2 sm:h-2.5";

  if (loading) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-6xl px-4 py-6">
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

  const name =
    toNonEmptyString(profile?.name) ||
    toNonEmptyString(user.displayName) ||
    "職人";
  const company = toNonEmptyString(profile?.company);

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="rounded-2xl border bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {!chart ? (
            <div className="mt-6 rounded-2xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
              この現場には区間工程表データがありません。
            </div>
          ) : (
            <>
              <div className="overflow-x-hidden rounded-2xl border dark:border-gray-800">
                <div
                  className="grid w-full border-b bg-gray-50 dark:border-gray-800 dark:bg-gray-950"
                  style={{
                    gridTemplateColumns: chartGridTemplate,
                  }}
                >
                  <div className="border-r px-2 py-1 text-[10px] font-extrabold sm:px-2 sm:py-1.5 sm:text-xs dark:border-gray-800 flex items-center">
                    工区 / 工種
                  </div>
                  {displayDays.map((day) => {
                    const key = ymdKey(day);
                    const off = holidaySet.has(key);
                    const mondayBorder = day.getDay() === 1 ? "border-l-2 border-l-gray-400 dark:border-l-gray-500" : "";

                    return (
                      <div
                        key={key}
                        className={`border-r px-0.5 py-0.5 text-center text-[9px] leading-none sm:px-0.5 sm:py-1 sm:text-[10px] dark:border-gray-800 ${mondayBorder} ${
                          off
                            ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200"
                            : "text-gray-700 dark:text-gray-200"
                        }`}
                      >
                        <div className="font-bold leading-none">{key.slice(5)}</div>
                        <div className="leading-none">{weekdayLabel(day)}</div>
                      </div>
                    );
                  })}
                </div>

                {rowsByGroup.map(({ group, rows }) => (
                  <div
                    key={group}
                    className="border-b last:border-b-0 dark:border-gray-800"
                  >
                    <div className="border-b bg-gray-100 px-2 py-[1px] text-[10px] font-extrabold text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100 leading-none">
                      {group}
                    </div>

                    {rows.length === 0 ? (
                      <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                        工種はありません
                      </div>
                    ) : (
                      rows.map((row, rowIndex) => (
                        <div
                          key={`${group}-${row.label}-${rowIndex}`}
                          className="grid w-full"
                          style={{
                            gridTemplateColumns: chartGridTemplate,
                            gridAutoRows: "14px",
                          }}
                        >
                          <div className="border-r px-2 py-[1px] text-[9px] font-bold text-gray-900 sm:px-2 sm:py-[1px] sm:text-[10px] dark:border-gray-800 dark:text-gray-100 flex items-center">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="inline-block h-2 w-2 rounded-sm sm:h-2.5 sm:w-2.5"
                                style={{ backgroundColor: row.color }}
                              />
                              <span className="break-words leading-none">
                                {row.label}
                              </span>
                            </div>
                          </div>

                          {displayDays.map((day, dayIndex) => {
                            const key = ymdKey(day);
                            const off = holidaySet.has(key);
                            const mondayBorder = day.getDay() === 1 ? "border-l-2 border-l-gray-400 dark:border-l-gray-500" : "";

                            const activeIndex = activeDayIndexByYmd.get(key);
                            const active =
                              activeIndex !== undefined &&
                              activeIndex >= row.offset &&
                              activeIndex < row.offset + row.duration;

                            const prevDay =
                              dayIndex > 0 ? displayDays[dayIndex - 1] : null;
                            const nextDay =
                              dayIndex < displayDays.length - 1
                                ? displayDays[dayIndex + 1]
                                : null;
                            const prevKey = prevDay ? ymdKey(prevDay) : "";
                            const nextKey = nextDay ? ymdKey(nextDay) : "";
                            const prevActiveIndex = prevDay
                              ? activeDayIndexByYmd.get(prevKey)
                              : undefined;
                            const nextActiveIndex = nextDay
                              ? activeDayIndexByYmd.get(nextKey)
                              : undefined;
                            const prevActive =
                              prevActiveIndex !== undefined &&
                              prevActiveIndex >= row.offset &&
                              prevActiveIndex < row.offset + row.duration;
                            const nextActive =
                              nextActiveIndex !== undefined &&
                              nextActiveIndex >= row.offset &&
                              nextActiveIndex < row.offset + row.duration;
                            const prevVisibleActive = prevActive && !holidaySet.has(prevKey);
                            const nextVisibleActive = nextActive && !holidaySet.has(nextKey);
                            const visibleActive = active && !off;
                            const barStart = visibleActive && !prevVisibleActive;
                            const barEnd = visibleActive && !nextVisibleActive;

                            return (
                              <div
                                key={`${group}-${row.label}-${key}`}
                                className={`border-r border-t px-0 py-0 dark:border-gray-800 flex items-center ${mondayBorder} ${
                                  off
                                    ? "bg-rose-50/70 dark:bg-rose-950/20"
                                    : "bg-white dark:bg-gray-950"
                                }`}
                              >
                                {visibleActive ? (
                                  <div
                                    className={`w-full ${rowHeightClass} ${
                                      barStart && barEnd
                                        ? "rounded-md"
                                        : barStart
                                          ? "rounded-l-md"
                                          : barEnd
                                            ? "rounded-r-md"
                                            : ""
                                    }`}
                                    style={{
                                      backgroundColor: row.color,
                                      marginLeft: prevVisibleActive ? -1 : 1,
                                      marginRight: nextVisibleActive ? -1 : 1,
                                      marginTop: "auto",
                                      marginBottom: "auto",
                                    }}
                                    title={`${row.label} / ${key}`}
                                  />
                                ) : (
                                  <div className="h-full w-full" />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
