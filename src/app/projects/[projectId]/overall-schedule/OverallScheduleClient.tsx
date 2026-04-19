"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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

type OverallSavedRow = {
  groupTitle: string;
  label: string;
  color: string;
  startYmd: string;
  endYmd: string;
};

type OverallSavedPayload = {
  v: 1;
  savedAt: string;
  saturdayOff: boolean;
  holidayText: string;
  title: string;
  rows: OverallSavedRow[];
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isOverallSavedRow(v: unknown): v is OverallSavedRow {
  if (!isRecord(v)) return false;
  return (
    typeof v["groupTitle"] === "string" &&
    typeof v["label"] === "string" &&
    typeof v["color"] === "string" &&
    typeof v["startYmd"] === "string" &&
    typeof v["endYmd"] === "string"
  );
}

function isOverallSavedPayload(v: unknown): v is OverallSavedPayload {
  if (!isRecord(v)) return false;
  if (v["v"] !== 1) return false;
  if (!Array.isArray(v["rows"])) return false;

  return (
    typeof v["savedAt"] === "string" &&
    typeof v["saturdayOff"] === "boolean" &&
    typeof v["holidayText"] === "string" &&
    typeof v["title"] === "string" &&
    v["rows"].every((row) => isOverallSavedRow(row))
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

function formatMonthDay(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatWeekday(date: Date): string {
  return ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
}

const CHART_INSET_PX = 10;

function parseHolidayText(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)),
  );
}

function displayOverallLabel(label: string, groupTitle: string): string {
  const trimmedLabel = label.trim();
  const trimmedGroup = groupTitle.trim();

  if (!trimmedGroup) return trimmedLabel;

  const prefix = `${trimmedGroup}-`;
  if (trimmedLabel.startsWith(prefix)) {
    return trimmedLabel.slice(prefix.length).trim();
  }

  return trimmedLabel;
}

function getDisplayDays(rows: OverallSavedRow[]): Date[] {
  if (rows.length === 0) return [];

  let minYmd = rows[0].startYmd;
  let maxYmd = rows[0].endYmd;

  for (const row of rows) {
    if (row.startYmd < minYmd) minYmd = row.startYmd;
    if (row.endYmd > maxYmd) maxYmd = row.endYmd;
  }

  const start = fromYmd(minYmd);
  const end = fromYmd(maxYmd);
  const out: Date[] = [];

  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (day.getDay() !== 0) out.push(day); // ReNova と合わせて日曜だけ除外
  }

  return out;
}

export default function OverallScheduleClient({
  initialProjectId,
}: {
  initialProjectId?: string;
}) {
  const router = useRouter();
  const session = useMemo(() => loadCraftsmanSession(), []);
  const chartViewportRef = useRef<HTMLDivElement | null>(null);
  const chartContentRef = useRef<HTMLDivElement | null>(null);

  const resolvedProjectId = useMemo(() => {
    return (
      toNonEmptyString(initialProjectId) || toNonEmptyString(session?.projectId)
    );
  }, [initialProjectId, session]);

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [overall, setOverall] = useState<OverallSavedPayload | null>(null);
  const [chartScale, setChartScale] = useState(1);
  const [scaledHeight, setScaledHeight] = useState<number | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null);
          setOverall(null);
          setLoading(false);
          router.replace("/login");
          return;
        }

        setUser(u);

        const craftsmanSnap = await getDoc(doc(db, "craftsmen", u.uid));
        if (!craftsmanSnap.exists()) {
          setOverall(null);
          setLoading(false);
          await signOut(auth);
          router.replace("/login");
          return;
        }

        const p = craftsmanSnap.data() as CraftsmanProfile;

        const pickedProjectId = resolvedProjectId;
        if (!pickedProjectId) {
          setOverall(null);
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

        saveCraftsmanSession({
          projectId: pickedProjectId,
          projectName: pickedProjectName ?? null,
        });

        const overallSnap = await getDoc(
          doc(db, "projects", pickedProjectId, "scheduleData", "overall"),
        );

        if (!overallSnap.exists()) {
          setOverall(null);
          setLoading(false);
          return;
        }

        const data = overallSnap.data() as unknown;
        if (!isOverallSavedPayload(data)) {
          setOverall(null);
          setLoading(false);
          return;
        }

        setOverall(data);
        setLoading(false);
      } catch (e) {
        console.error("overall schedule load error:", e);
        setUser(null);
        setOverall(null);
        setLoading(false);
        router.replace("/login");
      }
    });

    return () => unsub();
  }, [router, resolvedProjectId, session]);

  const displayDays = useMemo(() => {
    if (!overall) return [];
    return getDisplayDays(overall.rows);
  }, [overall]);

  const holidaySet = useMemo(() => {
    if (!overall) return new Set<string>();
    return parseHolidayText(overall.holidayText);
  }, [overall]);

  const rowsByGroup = useMemo(() => {
    if (!overall) return [];
    const groups = Array.from(
      new Set(overall.rows.map((r) => r.groupTitle.trim()).filter(Boolean)),
    );

    return groups.map((group) => ({
      group,
      rows: overall.rows.filter((r) => r.groupTitle.trim() === group),
    }));
  }, [overall]);

  const chartGridTemplate = useMemo(() => {
    if (!displayDays.length) return "112px";
    return `112px repeat(${displayDays.length}, minmax(28px, 1fr))`;
  }, [displayDays.length]);

  const chartMinWidth = useMemo(() => {
    return `${112 + displayDays.length * 28}px`;
  }, [displayDays.length]);

  const dayHeaderTextClass = useMemo(() => {
    if (displayDays.length >= 45) {
      return "text-[7px] sm:text-[8px]";
    }
    if (displayDays.length >= 35) {
      return "text-[8px] sm:text-[9px]";
    }
    if (displayDays.length >= 25) {
      return "text-[9px] sm:text-[10px]";
    }
    return "text-[10px] sm:text-[11px]";
  }, [displayDays.length]);

  const weekSegments = useMemo(() => {
    const segments: Array<{
      startIndex: number;
      span: number;
      startDate: Date;
      endDate: Date;
      startKey: string;
      endKey: string;
      hasHoliday: boolean;
    }> = [];

    if (displayDays.length === 0) return segments;

    let startIndex = 0;

    while (startIndex < displayDays.length) {
      let endIndex = startIndex;

      while (
        endIndex + 1 < displayDays.length &&
        displayDays[endIndex + 1].getDay() !== 1
      ) {
        endIndex += 1;
      }

      const startDay = displayDays[startIndex];
      const endDay = displayDays[endIndex];
      const weekDays = displayDays.slice(startIndex, endIndex + 1);

      segments.push({
        startIndex,
        span: endIndex - startIndex + 1,
        startDate: startDay,
        endDate: endDay,
        startKey: ymdKey(startDay),
        endKey: ymdKey(endDay),
        hasHoliday: weekDays.some((d) => holidaySet.has(ymdKey(d))),
      });

      startIndex = endIndex + 1;
    }

    return segments;
  }, [displayDays, holidaySet]);

  useEffect(() => {
    const viewport = chartViewportRef.current;
    const content = chartContentRef.current;

    if (!viewport || !content) return;

    const updateScale = () => {
      const viewportWidth = viewport.clientWidth;
      const usableViewportWidth = Math.max(0, viewportWidth - CHART_INSET_PX);
      const contentWidth = content.scrollWidth;
      const nextScale =
        usableViewportWidth > 0 && contentWidth > 0
          ? Math.min(1, (usableViewportWidth - 0.5) / contentWidth)
          : 1;

      setChartScale(nextScale);
      setScaledHeight(content.scrollHeight * nextScale + CHART_INSET_PX);
    };

    updateScale();

    const resizeObserver = new ResizeObserver(() => {
      updateScale();
    });

    resizeObserver.observe(viewport);
    resizeObserver.observe(content);

    return () => {
      resizeObserver.disconnect();
    };
  }, [chartMinWidth, overall, rowsByGroup.length, weekSegments.length]);

  if (loading) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-7xl px-2 py-2">
          <div className="rounded-2xl border bg-white p-2 shadow-sm dark:border-gray-800 dark:bg-gray-900">
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
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-7xl px-2 py-2">
        <div className="rounded-2xl border bg-white p-2 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {!overall ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
              この現場には全体工程表データがありません。
            </div>
          ) : (
            <div className="rounded-xl border dark:border-gray-800">
              <div
                ref={chartViewportRef}
                className="relative overflow-hidden p-1"
                style={{ height: scaledHeight ?? undefined }}
              >
                <div
                  ref={chartContentRef}
                  className="absolute left-1 top-1"
                  style={{
                    width: chartMinWidth,
                    transform: `scale(${chartScale})`,
                    transformOrigin: "top left",
                  }}
                >
                  <div
                    className="grid min-w-full border-b bg-gray-100 dark:border-gray-800 dark:bg-gray-900"
                    style={{
                      gridTemplateColumns: chartGridTemplate,
                      minWidth: chartMinWidth,
                    }}
                  >
                    <div className="sticky left-0 z-20 border-r bg-gray-100 px-1.5 py-1 text-[10px] font-extrabold sm:px-1.5 sm:py-1.5 sm:text-xs dark:border-gray-800 dark:bg-gray-900 flex items-center">
                      工区 / 工種
                    </div>

                    {weekSegments.map((seg) => (
                      <div
                        key={`${seg.startIndex}-${seg.span}`}
                        className={`border-r px-1 py-0.5 text-center leading-none dark:border-gray-800 ${dayHeaderTextClass} ${
                          seg.hasHoliday
                            ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200"
                            : "text-gray-700 dark:text-gray-200"
                        }`}
                        style={{
                          gridColumn: `${seg.startIndex + 2} / span ${seg.span}`,
                        }}
                      >
                        <div className="hidden lg:block font-bold leading-none whitespace-nowrap overflow-hidden text-ellipsis">
                          {formatMonthDay(seg.startDate)} (
                          {formatWeekday(seg.startDate)}) -{" "}
                          {formatMonthDay(seg.endDate)} (
                          {formatWeekday(seg.endDate)})
                        </div>
                        <div className="lg:hidden font-bold leading-none whitespace-nowrap overflow-hidden text-ellipsis">
                          {formatWeekday(seg.startDate)} {seg.startKey.slice(5)}
                        </div>
                        <div className="lg:hidden font-bold leading-none whitespace-nowrap overflow-hidden text-ellipsis">
                          {formatWeekday(seg.endDate)} {seg.endKey.slice(5)}
                        </div>
                      </div>
                    ))}

                    <div className="sticky left-0 z-20 hidden border-r border-t bg-gray-50 px-1.5 py-1 text-[10px] font-bold text-gray-600 lg:flex items-center dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                      日付
                    </div>

                    {displayDays.map((day) => {
                      const key = ymdKey(day);
                      const off = holidaySet.has(key);
                      const mondayBorder =
                        day.getDay() === 1
                          ? "border-l-2 border-l-gray-400 dark:border-l-gray-500"
                          : "";

                      return (
                        <div
                          key={`header-day-${key}`}
                          className={`hidden border-r border-t px-0.5 py-1 text-center text-[10px] leading-none lg:block dark:border-gray-800 ${mondayBorder} ${
                            off
                              ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200"
                              : "bg-gray-50 text-gray-700 dark:bg-gray-950 dark:text-gray-200"
                          }`}
                        >
                          <div className="font-bold whitespace-nowrap">
                            {formatMonthDay(day)}
                          </div>
                          <div className="mt-0.5 text-[9px]">
                            {formatWeekday(day)}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {rowsByGroup.map(({ group, rows }) => (
                    <div
                      key={group}
                      className="border-b last:border-b-0 dark:border-gray-800"
                    >
                      <div className="sticky left-0 z-10 border-b bg-gray-100 px-1.5 py-px text-[10px] font-extrabold text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100 leading-none">
                        {group}
                      </div>

                      {rows.map((row, rowIndex) => (
                        <div
                          key={`${group}-${row.label}-${rowIndex}`}
                          className="grid min-w-full"
                          style={{
                            gridTemplateColumns: chartGridTemplate,
                            gridAutoRows: "14px",
                            minWidth: chartMinWidth,
                          }}
                        >
                          <div className="sticky left-0 z-10 border-r bg-white px-1.5 py-px text-[9px] font-bold text-gray-900 sm:px-1.5 sm:py-px sm:text-[10px] dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100 flex items-center min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0 w-full">
                              <span
                                className="inline-block h-2 w-2 rounded-sm sm:h-2.5 sm:w-2.5 shrink-0"
                                style={{ backgroundColor: row.color }}
                              />
                              <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-none">
                                {displayOverallLabel(row.label, row.groupTitle)}
                              </span>
                            </div>
                          </div>

                          {displayDays.map((day, dayIndex) => {
                            const key = ymdKey(day);
                            const off = holidaySet.has(key);
                            const mondayBorder =
                              day.getDay() === 1
                                ? "border-l-2 border-l-gray-400 dark:border-l-gray-500"
                                : "";

                            const active =
                              key >= row.startYmd && key <= row.endYmd;
                            const prevDay =
                              dayIndex > 0 ? displayDays[dayIndex - 1] : null;
                            const nextDay =
                              dayIndex < displayDays.length - 1
                                ? displayDays[dayIndex + 1]
                                : null;

                            const prevActive =
                              prevDay !== null &&
                              ymdKey(prevDay) >= row.startYmd &&
                              ymdKey(prevDay) <= row.endYmd &&
                              !holidaySet.has(ymdKey(prevDay));

                            const nextActive =
                              nextDay !== null &&
                              ymdKey(nextDay) >= row.startYmd &&
                              ymdKey(nextDay) <= row.endYmd &&
                              !holidaySet.has(ymdKey(nextDay));

                            const visibleActive = active && !off;
                            const barStart = visibleActive && !prevActive;
                            const barEnd = visibleActive && !nextActive;

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
                                    className={`w-full h-2 sm:h-2.5 ${
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
                                      marginLeft: prevActive ? -1 : 1,
                                      marginRight: nextActive ? -1 : 1,
                                      marginTop: "auto",
                                      marginBottom: "auto",
                                    }}
                                    title={`${displayOverallLabel(row.label, row.groupTitle)} / ${key}`}
                                  />
                                ) : (
                                  <div className="h-full w-full" />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
