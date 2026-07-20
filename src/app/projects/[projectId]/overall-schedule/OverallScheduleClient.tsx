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

type ChartSizing = {
  labelColumnWidth: number;
  dayColumnMinWidth: number;
  groupHeaderHeight: number;
  rowHeight: number;
  barHeight: number;
  weekHeaderFontPx: number;
  dayHeaderFontPx: number;
  labelFontPx: number;
  colorSwatchSize: number;
};

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

/** 画面へ収める列数（日曜を除いた約2週間） */
const VISIBLE_COLUMN_COUNT = 12;
/** 横向き・広い画面と判断する幅。ここを境に列数を倍にする（＝列幅は半分） */
const WIDE_VIEWPORT_MIN_WIDTH = 700;
/** ズームボタンで変えられる倍率 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;

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
/** 縦方向がズームに追従する割合（1 で横と同じだけ伸びる） */
const VERTICAL_ZOOM_RATIO = 0.5;
/** 行の高さ。列幅とは切り離す（列を細くしても行が高くならないように） */
const ROW_HEIGHT_PX = 16;
/** 日付ヘッダの高さ */
const DAY_HEADER_HEIGHT_PX = 34;
/** チャートの表示高さの上限（この中で縦スクロールする） */
const CHART_MAX_HEIGHT = "72dvh";
/** 全画面表示のときの高さ */
const CHART_FULLSCREEN_HEIGHT = "100dvh";
/** 工区・工種名の列幅 */
const LABEL_COLUMN_MIN_WIDTH = 104;
const LABEL_COLUMN_MAX_WIDTH = 168;
/** 工区・工種名の文字サイズ（列を広げたぶん小さくして文字数を稼ぐ） */
const LABEL_FONT_PX = 11;

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

function resolveChartSizing(dayCount: number): ChartSizing {
  const dayColumnMinWidth =
    dayCount <= 14
      ? 58
      : dayCount <= 21
        ? 50
        : dayCount <= 35
          ? 40
          : dayCount <= 50
            ? 32
            : 28;

  const rowHeight = dayColumnMinWidth;
  const barHeight = rowHeight;

  return {
    labelColumnWidth: dayCount <= 21 ? 144 : dayCount <= 40 ? 128 : 112,
    dayColumnMinWidth,
    groupHeaderHeight: Math.max(24, Math.round(dayColumnMinWidth * 0.48)),
    rowHeight,
    barHeight,
    weekHeaderFontPx:
      dayCount <= 21 ? 13 : dayCount <= 35 ? 12 : dayCount <= 50 ? 11 : 10,
    dayHeaderFontPx:
      dayCount <= 21 ? 13 : dayCount <= 35 ? 12 : dayCount <= 50 ? 11 : 10,
    labelFontPx:
      dayColumnMinWidth >= 50 ? 15 : dayColumnMinWidth >= 40 ? 14 : 12,
    colorSwatchSize: dayColumnMinWidth >= 40 ? 13 : 11,
  };
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
  const [scaledHeight, setScaledHeight] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  // 拡大倍率。ボタンで段階的に変える
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // ズーム前に画面左端に見えていた日付。拡大後も同じ日付を左端に保つために使う
  const zoomAnchorRef = useRef<number | null>(null);
  const didScrollToTodayRef = useRef(false);

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

  /** 工期全体の日付（日曜を除く） */
  const allDays = useMemo(() => {
    if (!overall) return [];
    return getDisplayDays(overall.rows);
  }, [overall]);

  // 表は全期間のまま。拡大／縮小で見せ方を変える
  const visibleDays = allDays;

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

  // 横向きは幅に余裕があるので、収める列数を倍にする（1列の幅は半分になる）
  const visibleColumnCount =
    viewportWidth >= WIDE_VIEWPORT_MIN_WIDTH
      ? VISIBLE_COLUMN_COUNT * 2
      : VISIBLE_COLUMN_COUNT;

  // 文字サイズなどは「画面に収める列数」を基準に決める。
  // ただし行の高さは列幅と連動させない（列を細くすると行が高くなってしまうため）。
  const chartSizing = useMemo(() => {
    const base = resolveChartSizing(
      Math.min(visibleDays.length, visibleColumnCount),
    );

    // 行の高さ・文字もピンチに追従させる。
    // 縦の伸びは横より控えめにする（縦に伸びすぎると一度に見える工種が減るため）
    const verticalZoom = 1 + (zoom - 1) * VERTICAL_ZOOM_RATIO;
    const scaleY = (value: number, min: number, max: number) =>
      Math.round(Math.min(max, Math.max(min, value * verticalZoom)));

    return {
      ...base,
      rowHeight: scaleY(ROW_HEIGHT_PX, 12, 56),
      barHeight: scaleY(ROW_HEIGHT_PX, 12, 56),
      groupHeaderHeight: scaleY(22, 16, 48),
      labelFontPx: scaleY(LABEL_FONT_PX, 9, 20),
      colorSwatchSize: scaleY(10, 8, 18),
    };
  }, [zoom, visibleDays.length, visibleColumnCount]);

  /**
   * 1日ぶんの列幅。
   * 「画面に収める列数」で画面幅がちょうど埋まる幅にし、残りは横スクロールで見る。
   */
  /** 日付ヘッダの高さもピンチに追従させる */
  const dayHeaderHeight = useMemo(
    () =>
      Math.round(
        Math.min(
          60,
          Math.max(
            24,
            DAY_HEADER_HEIGHT_PX * (1 + (zoom - 1) * VERTICAL_ZOOM_RATIO),
          ),
        ),
      ),
    [zoom],
  );

  /** 工区・工種名の列幅。狭い画面では日付側に幅を回す */
  const labelColumnWidth = useMemo(() => {
    if (viewportWidth <= 0) return chartSizing.labelColumnWidth;

    const base = Math.max(
      LABEL_COLUMN_MIN_WIDTH,
      Math.min(LABEL_COLUMN_MAX_WIDTH, viewportWidth * 0.34),
    );

    // 横向きは日付側に幅を回せるので名前の列を細くするが、
    // 半分では工種名が入りきらなかったため 1.5 倍に戻す（= 縦の 0.75 倍）
    const isWideViewport = viewportWidth >= WIDE_VIEWPORT_MIN_WIDTH;
    return Math.round(isWideViewport ? (base / 2) * 1.5 : base);
  }, [chartSizing.labelColumnWidth, viewportWidth]);

  /**
   * 1日ぶんの列幅。1か月ぶんで画面幅がちょうど埋まる幅にする。
   * ここで最小幅に丸めると26列が入りきらず、1週間ぶんしか見えなくなる。
   */
  const dayColumnWidth = useMemo(() => {
    if (viewportWidth <= 0) return chartSizing.dayColumnMinWidth;

    const usable = viewportWidth - CHART_INSET_PX - labelColumnWidth;
    if (usable <= 0) return chartSizing.dayColumnMinWidth;

    return Math.max(1, (usable / visibleColumnCount) * zoom);
  }, [
    chartSizing.dayColumnMinWidth,
    labelColumnWidth,
    zoom,
    viewportWidth,
    visibleColumnCount,
  ]);

  const chartGridTemplate = useMemo(() => {
    if (!visibleDays.length) return `${labelColumnWidth}px`;
    return `${labelColumnWidth}px repeat(${visibleDays.length}, ${dayColumnWidth}px)`;
  }, [labelColumnWidth, dayColumnWidth, visibleDays.length]);

  const chartMinWidth = useMemo(() => {
    return `${labelColumnWidth + visibleDays.length * dayColumnWidth}px`;
  }, [labelColumnWidth, dayColumnWidth, visibleDays.length]);

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

    if (visibleDays.length === 0) return segments;

    let startIndex = 0;

    while (startIndex < visibleDays.length) {
      let endIndex = startIndex;

      while (
        endIndex + 1 < visibleDays.length &&
        visibleDays[endIndex + 1].getDay() !== 1
      ) {
        endIndex += 1;
      }

      const startDay = visibleDays[startIndex];
      const endDay = visibleDays[endIndex];
      const weekDays = visibleDays.slice(startIndex, endIndex + 1);

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
  }, [visibleDays, holidaySet]);

  // 全画面のあいだはフッターを隠す。フッターは共通レイアウト側にあるため、
  // body の属性を目印にして CSS で消す
  useEffect(() => {
    if (!isFullscreen) return;

    document.body.dataset.chartFullscreen = "1";
    return () => {
      delete document.body.dataset.chartFullscreen;
    };
  }, [isFullscreen]);

  /**
   * ズームを1段階変える。
   * 列幅が変わると表は左端（工期の開始日）を起点に伸縮するので、
   * そのままだと見ていた日付が横にずれる。左端の日付を覚えておいて後で戻す。
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

  /** 今日が全期間の何列目か。工期外なら -1 */
  const todayColumnIndex = useMemo(() => {
    const todayKey = ymdKey(new Date());
    return visibleDays.findIndex((day) => ymdKey(day) >= todayKey);
  }, [visibleDays]);

  // 今日が左端に来るところまで横スクロールする。
  // 初回だけ。ピンチのたびに実行すると、操作するそばから位置が戻ってしまう。
  useEffect(() => {
    const viewport = chartViewportRef.current;
    if (!viewport) return;
    if (didScrollToTodayRef.current) return;
    if (todayColumnIndex < 0 || dayColumnWidth <= 0) return;

    viewport.scrollLeft = todayColumnIndex * dayColumnWidth;
    didScrollToTodayRef.current = true;
  }, [todayColumnIndex, dayColumnWidth]);

  useEffect(() => {
    const viewport = chartViewportRef.current;
    const content = chartContentRef.current;

    if (!viewport || !content) return;

    const updateScale = () => {
      const nextViewportWidth = viewport.clientWidth;
      setViewportWidth(nextViewportWidth);

      // 縮小はしない。列幅を実寸で決め、入りきらない分は横スクロールで見る。
      // transform で縮めると、左端に固定した工区名の列が正しく効かない。
      setScaledHeight(content.scrollHeight + CHART_INSET_PX);
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
  }, [
    chartMinWidth,
    chartSizing,
    overall,
    rowsByGroup.length,
    weekSegments.length,
  ]);

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
    <main className="overall-print-root min-h-dvh bg-gray-50 print:bg-white dark:bg-gray-950">
      <div
        className={`mx-auto w-full max-w-7xl print:max-w-none print:px-0 print:py-0 ${
          isFullscreen ? "px-0 py-0" : "px-2 py-2"
        }`}
      >
        <div
          className={`bg-white shadow-sm print:border-0 print:p-0 print:shadow-none dark:bg-gray-900 ${
            isFullscreen
              ? "p-0"
              : "rounded-2xl border p-2 dark:border-gray-800"
          }`}
        >
          {!overall ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
              この現場には全体工程表データがありません。
            </div>
          ) : (
            <div className="relative rounded-xl border print:rounded-none print:border-0 dark:border-gray-800">
              {/*
                ズームは行として置かず、チャートに重ねて浮かせる。
                表示領域が狭いので、操作系で縦を使わない。
              */}
              <div
                className="absolute bottom-3 right-3 z-50 flex items-center gap-1 rounded-full border border-gray-300/80 bg-white/90 px-1 py-1 shadow-lg backdrop-blur print:hidden dark:border-gray-600/80 dark:bg-gray-900/90"
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
                className="overall-print-chart-viewport relative overflow-auto p-1"
                style={{
                  // 日付行を上に固定するため、縦スクロールもこの中で行う。
                  // ページ側でスクロールさせると、上に貼り付ける基準が無くなる。
                  maxHeight: isFullscreen
                    ? CHART_FULLSCREEN_HEIGHT
                    : CHART_MAX_HEIGHT,
                  // 全画面では高さを固定しない。固定すると、表が短いときに
                  // 下へ大きな空白ができ、長いときは下端が切れてしまう。
                  height: isFullscreen ? undefined : (scaledHeight ?? undefined),
                  touchAction: "pan-x pan-y",
                }}
              >
                <div
                  ref={chartContentRef}
                  className="overall-print-chart-content relative"
                  style={{
                    width: `max(${chartMinWidth}, 100%)`,
                    minWidth: chartMinWidth,
                  }}
                >
                  <div
                    className="sticky top-0 z-30 grid min-w-full border-b bg-gray-100 dark:border-gray-800 dark:bg-gray-900"
                    style={{
                      gridTemplateColumns: chartGridTemplate,
                      minWidth: chartMinWidth,
                    }}
                  >
                    <div
                      className="sticky left-0 z-20 flex items-center border-r bg-gray-100 px-1.5 py-1 font-extrabold sm:px-1.5 sm:py-1.5 dark:border-gray-800 dark:bg-gray-900"
                      style={{
                        minHeight: chartSizing.groupHeaderHeight,
                        fontSize: chartSizing.labelFontPx,
                      }}
                    >
                      工区 / 工種
                    </div>

                    {weekSegments.map((seg) => (
                      <div
                        key={`${seg.startIndex}-${seg.span}`}
                        className={`border-r px-1 py-0.5 text-center leading-none dark:border-gray-800 ${
                          seg.hasHoliday
                            ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200"
                            : "text-gray-700 dark:text-gray-200"
                        }`}
                        style={{
                          gridColumn: `${seg.startIndex + 2} / span ${seg.span}`,
                          minHeight: chartSizing.groupHeaderHeight,
                          fontSize: chartSizing.weekHeaderFontPx,
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

                    <div
                      className="sticky left-0 z-20 flex items-center border-r border-t bg-gray-50 px-1.5 py-1 font-bold text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300"
                      style={{
                        minHeight: dayHeaderHeight,
                        fontSize: chartSizing.dayHeaderFontPx,
                      }}
                    >
                      日付
                    </div>

                    {visibleDays.map((day) => {
                      const key = ymdKey(day);
                      const off = holidaySet.has(key);
                      const mondayBorder =
                        day.getDay() === 1
                          ? "border-l-2 border-l-gray-400 dark:border-l-gray-500"
                          : "";

                      return (
                        <div
                          key={`header-day-${key}`}
                          className={`border-r border-t px-0.5 py-1 text-center leading-none dark:border-gray-800 ${mondayBorder} ${
                            off
                              ? "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200"
                              : "bg-gray-50 text-gray-700 dark:bg-gray-950 dark:text-gray-200"
                          }`}
                          style={{
                            minHeight: dayHeaderHeight,
                            fontSize: 10,
                          }}
                        >
                          {/* 列が細いので「日」と曜日1文字だけ。月は上の週ヘッダに出ている */}
                          <div className="font-bold whitespace-nowrap overflow-hidden">
                            {day.getDate()}
                          </div>
                          <div
                            className="mt-0.5 whitespace-nowrap overflow-hidden"
                            style={{ fontSize: 9 }}
                          >
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
                      <div
                        className="flex items-center border-b bg-gray-100 py-px font-extrabold leading-none text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100"
                        style={{
                          minHeight: chartSizing.groupHeaderHeight,
                          fontSize: chartSizing.labelFontPx,
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

                      {rows.map((row, rowIndex) => (
                        <div
                          key={`${group}-${row.label}-${rowIndex}`}
                          className="grid min-w-full"
                          style={{
                            gridTemplateColumns: chartGridTemplate,
                            gridAutoRows: `${chartSizing.rowHeight}px`,
                            minWidth: chartMinWidth,
                          }}
                        >
                          <div
                            className="sticky left-0 z-10 flex min-w-0 items-center border-r bg-white px-1.5 py-px font-bold text-gray-900 sm:px-1.5 sm:py-px dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100"
                            style={{ fontSize: chartSizing.labelFontPx }}
                          >
                            <div className="flex items-center gap-1.5 min-w-0 w-full">
                              <span
                                className="inline-block shrink-0 rounded-sm"
                                style={{
                                  backgroundColor: row.color,
                                  height: chartSizing.colorSwatchSize,
                                  width: chartSizing.colorSwatchSize,
                                }}
                              />
                              <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-none">
                                {displayOverallLabel(row.label, row.groupTitle)}
                              </span>
                            </div>
                          </div>

                          {visibleDays.map((day, dayIndex) => {
                            const key = ymdKey(day);
                            const off = holidaySet.has(key);
                            const mondayBorder =
                              day.getDay() === 1
                                ? "border-l-2 border-l-gray-400 dark:border-l-gray-500"
                                : "";

                            const active =
                              key >= row.startYmd && key <= row.endYmd;
                            const prevDay =
                              dayIndex > 0 ? visibleDays[dayIndex - 1] : null;
                            const nextDay =
                              dayIndex < visibleDays.length - 1
                                ? visibleDays[dayIndex + 1]
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
                                    className={`w-full ${
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
                                      height: chartSizing.barHeight,
                                      marginLeft: prevActive ? -1 : 0,
                                      marginRight: nextActive ? -1 : 0,
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
