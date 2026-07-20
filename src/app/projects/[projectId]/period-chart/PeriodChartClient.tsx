// src/app/projects/[projectId]/period-chart/PeriodChartClient.tsx
"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** 画面へ収める列数（日曜を除いた約2週間） */
const VISIBLE_COLUMN_COUNT = 12;
/** チャート枠の内側の余白ぶん */
const CHART_INSET_PX = 8;
/** 横向き・広い画面と判断する幅。ここを境に列数を倍にする（＝列幅は半分） */
const WIDE_VIEWPORT_MIN_WIDTH = 700;
/** 工区・工種名の列幅 */
const LABEL_COLUMN_MIN_WIDTH = 104;
const LABEL_COLUMN_MAX_WIDTH = 168;
/** 行の高さ。列幅とは切り離す（列を細くしても行が高くならないように） */
const ROW_HEIGHT_PX = 16;
/** 日付ヘッダの高さ */
const DAY_HEADER_HEIGHT_PX = 34;
/** チャートの表示高さの上限（この中で縦スクロールする） */
const CHART_MAX_HEIGHT = "72dvh";
/** 全画面表示のときの高さ */
const CHART_FULLSCREEN_HEIGHT = "100dvh";
/** ズームボタンで変えられる倍率 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;
/** 縦方向がズームに追従する割合（1 で横と同じだけ伸びる） */
const VERTICAL_ZOOM_RATIO = 0.5;

/** 現在の倍率から1段階ずらす */
function stepZoom(current: number, direction: 1 | -1): number {
  const index = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number]);
  const from = index >= 0 ? index : ZOOM_STEPS.findIndex((v) => v >= current);
  const next = Math.min(
    ZOOM_STEPS.length - 1,
    Math.max(0, (from < 0 ? 1 : from) + direction),
  );
  return ZOOM_STEPS[next];
}

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
  const [chart, setChart] = useState<PeriodChartSavedPayload | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scaledHeight, setScaledHeight] = useState<number | null>(null);
  const chartViewportRef = useRef<HTMLDivElement | null>(null);
  const chartContentRef = useRef<HTMLDivElement | null>(null);
  const didScrollToTodayRef = useRef(false);
  // ズーム前に画面左端に見えていた日付。拡大後も同じ日付を左端に保つために使う
  const zoomAnchorRef = useRef<number | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null);
          setChart(null);
          setLoading(false);
          router.replace("/login");
          return;
        }

        setUser(u);

        const craftsmanSnap = await getDoc(doc(db, "craftsmen", u.uid));
        if (!craftsmanSnap.exists()) {
          setChart(null);
          setLoading(false);
          await signOut(auth);
          router.replace("/login");
          return;
        }

        const p = craftsmanSnap.data() as CraftsmanProfile;

        const pickedProjectId = resolvedProjectId;
        if (!pickedProjectId) {
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

  // 横向きは幅に余裕があるので、収める列数を倍にする（1列の幅は半分になる）
  const visibleColumnCount =
    viewportWidth >= WIDE_VIEWPORT_MIN_WIDTH
      ? VISIBLE_COLUMN_COUNT * 2
      : VISIBLE_COLUMN_COUNT;

  /** 工区・工種名の列幅。狭い画面では日付側に幅を回す */
  const labelColumnWidth = useMemo(() => {
    if (viewportWidth <= 0) return LABEL_COLUMN_MIN_WIDTH;

    const base = Math.max(
      LABEL_COLUMN_MIN_WIDTH,
      Math.min(LABEL_COLUMN_MAX_WIDTH, viewportWidth * 0.34),
    );

    const isWideViewport = viewportWidth >= WIDE_VIEWPORT_MIN_WIDTH;
    return Math.round(isWideViewport ? (base / 2) * 1.5 : base);
  }, [viewportWidth]);

  /**
   * 1日ぶんの列幅。
   * 「画面に収める列数」で画面幅がちょうど埋まる幅にし、残りは横スクロールで見る。
   */
  const dayColumnWidth = useMemo(() => {
    if (viewportWidth <= 0) return 24;

    const usable = viewportWidth - CHART_INSET_PX - labelColumnWidth;
    if (usable <= 0) return 24;

    return Math.max(1, (usable / visibleColumnCount) * zoom);
  }, [labelColumnWidth, viewportWidth, visibleColumnCount, zoom]);

  /** 行の高さ・文字もズームに追従させる（縦は横より控えめに） */
  const verticalSizing = useMemo(() => {
    const verticalZoom = 1 + (zoom - 1) * VERTICAL_ZOOM_RATIO;
    const scaleY = (value: number, min: number, max: number) =>
      Math.round(Math.min(max, Math.max(min, value * verticalZoom)));

    return {
      rowHeight: scaleY(ROW_HEIGHT_PX, 12, 56),
      dayHeaderHeight: scaleY(DAY_HEADER_HEIGHT_PX, 24, 60),
      groupHeaderHeight: scaleY(22, 16, 48),
      labelFontPx: scaleY(11, 9, 20),
      swatchSize: scaleY(10, 8, 18),
    };
  }, [zoom]);

  const chartGridTemplate = useMemo(() => {
    if (!displayDays.length) return `${labelColumnWidth}px`;
    return `${labelColumnWidth}px repeat(${displayDays.length}, ${dayColumnWidth}px)`;
  }, [dayColumnWidth, displayDays.length, labelColumnWidth]);

  const chartMinWidth = useMemo(
    () => `${labelColumnWidth + displayDays.length * dayColumnWidth}px`,
    [dayColumnWidth, displayDays.length, labelColumnWidth],
  );

  /** 今日が何列目か。期間外なら -1 */
  const todayColumnIndex = useMemo(() => {
    const todayKey = ymdKey(new Date());
    return displayDays.findIndex((day) => ymdKey(day) >= todayKey);
  }, [displayDays]);

  // ビューポート幅と、表の高さを測る
  useEffect(() => {
    const viewport = chartViewportRef.current;
    const content = chartContentRef.current;
    if (!viewport || !content) return;

    const update = () => {
      setViewportWidth(viewport.clientWidth);
      setScaledHeight(content.scrollHeight + CHART_INSET_PX);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [chart]);

  // 今日が左端に来るところまで横スクロールする（初回だけ）
  useEffect(() => {
    const viewport = chartViewportRef.current;
    if (!viewport) return;
    if (didScrollToTodayRef.current) return;
    if (todayColumnIndex < 0 || dayColumnWidth <= 0) return;

    viewport.scrollLeft = todayColumnIndex * dayColumnWidth;
    didScrollToTodayRef.current = true;
  }, [todayColumnIndex, dayColumnWidth]);

  /**
   * ズームを1段階変える。
   * 列幅が変わると表は左端を起点に伸縮するので、左端の日付を覚えておいて後で戻す。
   */
  const changeZoom = useCallback(
    (direction: 1 | -1) => {
      const viewport = chartViewportRef.current;

      if (viewport && dayColumnWidth > 0) {
        zoomAnchorRef.current = viewport.scrollLeft / dayColumnWidth;
      }

      setZoom((current) => stepZoom(current, direction));
    },
    [dayColumnWidth],
  );

  // 列幅が変わったら、覚えておいた日付が左端に来るようスクロールし直す
  useEffect(() => {
    const viewport = chartViewportRef.current;
    const anchor = zoomAnchorRef.current;

    if (!viewport || anchor === null || dayColumnWidth <= 0) return;

    zoomAnchorRef.current = null;
    viewport.scrollLeft = anchor * dayColumnWidth;
  }, [dayColumnWidth]);

  // 全画面のあいだはフッターを隠す
  useEffect(() => {
    if (!isFullscreen) return;

    document.body.dataset.chartFullscreen = "1";
    return () => {
      delete document.body.dataset.chartFullscreen;
    };
  }, [isFullscreen]);

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

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div
        className={`mx-auto w-full max-w-7xl ${
          isFullscreen ? "px-0 py-0" : "px-2 py-2"
        }`}
      >
        <div
          className={`bg-white shadow-sm dark:bg-gray-900 ${
            isFullscreen ? "p-0" : "rounded-2xl border p-2 dark:border-gray-800"
          }`}
        >
          {!chart ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
              この現場には期間工程表データがありません。
            </div>
          ) : (
            <>
              <div className="relative rounded-xl border dark:border-gray-800">
                {/* ズームと全画面はチャートに重ねて置く（縦の領域を使わない） */}
                <div
                  className="absolute bottom-3 right-3 z-50 flex items-center gap-1 rounded-full border border-gray-300/80 bg-white/90 px-1 py-1 shadow-lg backdrop-blur dark:border-gray-600/80 dark:bg-gray-900/90"
                >
                  <button
                    type="button"
                    onClick={() => changeZoom(-1)}
                    disabled={zoom <= ZOOM_STEPS[0]}
                    aria-label="縮小"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-base font-extrabold leading-none text-gray-700 disabled:opacity-30 dark:text-gray-200"
                  >
                    −
                  </button>

                  <span className="min-w-[2.4rem] text-center text-[11px] font-extrabold tabular-nums text-gray-600 dark:text-gray-300">
                    {Math.round(zoom * 100)}%
                  </span>

                  <button
                    type="button"
                    onClick={() => changeZoom(1)}
                    disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                    aria-label="拡大"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-base font-extrabold leading-none text-gray-700 disabled:opacity-30 dark:text-gray-200"
                  >
                    ＋
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsFullscreen((v) => !v)}
                    aria-pressed={isFullscreen}
                    aria-label={isFullscreen ? "全画面を終了" : "全画面表示"}
                    className="ml-0.5 flex h-7 items-center rounded-full px-2 text-[11px] font-extrabold leading-none text-gray-700 dark:text-gray-200"
                  >
                    {isFullscreen ? "戻す" : "全画面"}
                  </button>
                </div>

                <div
                  ref={chartViewportRef}
                  className="relative overflow-auto p-1"
                  style={{
                    maxHeight: isFullscreen
                      ? CHART_FULLSCREEN_HEIGHT
                      : CHART_MAX_HEIGHT,
                    height: isFullscreen ? undefined : (scaledHeight ?? undefined),
                    touchAction: "pan-x pan-y",
                  }}
                >
                <div
                  ref={chartContentRef}
                  className="relative"
                  style={{
                    width: `max(${chartMinWidth}, 100%)`,
                    minWidth: chartMinWidth,
                  }}
                >
                <div
                  className="sticky top-0 z-30 grid min-w-full border-b bg-gray-50 dark:border-gray-800 dark:bg-gray-950"
                  style={{
                    gridTemplateColumns: chartGridTemplate,
                    minWidth: chartMinWidth,
                  }}
                >
                  <div
                    className="sticky left-0 z-20 flex items-center border-r bg-gray-50 px-1.5 py-1 font-extrabold dark:border-gray-800 dark:bg-gray-950"
                    style={{
                      minHeight: verticalSizing.dayHeaderHeight,
                      fontSize: verticalSizing.labelFontPx,
                    }}
                  >
                    工区 / 工種
                  </div>
                  {displayDays.map((day) => {
                    const key = ymdKey(day);
                    const off = holidaySet.has(key);
                    const mondayBorder = day.getDay() === 1 ? "border-l-2 border-l-gray-400 dark:border-l-gray-500" : "";

                    return (
                      <div
                        key={key}
                        className={`border-r px-0.5 py-1 text-center leading-none dark:border-gray-800 ${mondayBorder} ${
                          off
                            ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200"
                            : "text-gray-700 dark:text-gray-200"
                        }`}
                        style={{
                          minHeight: verticalSizing.dayHeaderHeight,
                          fontSize: 10,
                        }}
                      >
                        {/* 列が細いので「日」と曜日1文字だけ */}
                        <div className="font-bold leading-none overflow-hidden whitespace-nowrap">
                          {day.getDate()}
                        </div>
                        <div
                          className="leading-none overflow-hidden whitespace-nowrap"
                          style={{ fontSize: 9 }}
                        >
                          {weekdayLabel(day)}
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
                    <div
                      className="flex items-center border-b bg-gray-100 py-px font-extrabold leading-none text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100"
                      style={{
                        minHeight: verticalSizing.groupHeaderHeight,
                        fontSize: verticalSizing.labelFontPx,
                      }}
                    >
                      {/*
                        この行は全幅のブロックなので、箱に sticky を付けても
                        中の文字は左端に置かれたまま流れてしまう。文字側を固定する。
                      */}
                      <span className="sticky left-0 z-10 bg-gray-100 px-1.5 dark:bg-gray-900">
                        {group}
                      </span>
                    </div>

                    {rows.length === 0 ? (
                      <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                        工種はありません
                      </div>
                    ) : (
                      rows.map((row, rowIndex) => (
                        <div
                          key={`${group}-${row.label}-${rowIndex}`}
                          className="grid"
                          style={{
                            gridTemplateColumns: chartGridTemplate,
                            gridAutoRows: `${verticalSizing.rowHeight}px`,
                            minWidth: chartMinWidth,
                          }}
                        >
                          <div
                            className="sticky left-0 z-10 flex min-w-0 items-center border-r bg-white px-1.5 py-px font-bold text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                            style={{ fontSize: verticalSizing.labelFontPx }}
                          >
                            <div className="flex w-full min-w-0 items-center gap-1.5">
                              <span
                                className="inline-block shrink-0 rounded-sm"
                                style={{
                                  backgroundColor: row.color,
                                  height: verticalSizing.swatchSize,
                                  width: verticalSizing.swatchSize,
                                }}
                              />
                              <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-none">
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
                                    className={`h-full w-full ${
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
                                      marginLeft: prevVisibleActive ? -1 : 0,
                                      marginRight: nextVisibleActive ? -1 : 0,
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
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
