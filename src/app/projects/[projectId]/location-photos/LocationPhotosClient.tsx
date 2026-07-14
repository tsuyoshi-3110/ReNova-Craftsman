"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Eye,
  Loader2,
  MapPin,
  Move,
  Plus,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";

import { auth, db } from "@/lib/firebaseClient";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

type LocationPhotoDocument = {
  id: string;
  name: string;
  fileUrl: string;
  fileType: "pdf" | "image";
  createdAt: Timestamp | null;
};

type LinkedPhoto = {
  photoId: string;
  originalUrl: string;
  renderedUrl?: string;
  shotByName?: string;
};

type SubtitleInfo = { id: string; name: string };
type WorkTypeInfo = { id: string; name: string };
type PhotoItem = {
  id: string;
  originalUrl: string;
  renderedUrl?: string;
  memo?: string;
  shotByName?: string;
};
type PinData = {
  name: string;
  xRatio: number;
  yRatio: number;
  subtitleId?: string;
  subtitleName?: string;
  workTypeId?: string;
  workTypeName?: string;
  memo?: string;
  linkedPhotos?: LinkedPhoto[];
};

type LocationPhotoPin = {
  id: string;
  name: string;
  xRatio: number;
  yRatio: number;
  subtitleId?: string;
  subtitleName?: string;
  workTypeId?: string;
  workTypeName?: string;
  memo?: string;
  linkedPhotos?: LinkedPhoto[];
  createdByUid?: string;
  createdByName?: string;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function safeDecode(v: string | null): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function PdfPageCanvas({
  url,
  onReady,
}: {
  url: string;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        const page = await pdf.getPage(1);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (!cancelled) {
          setLoading(false);
          onReady?.();
        }
      } catch {
        if (!cancelled) {
          setError("PDFの読み込みに失敗しました");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, onReady]);

  if (error) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-red-500">
        {error}
      </div>
    );
  }

  return (
    <>
      {loading && (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`block w-full ${loading ? "hidden" : ""}`}
      />
    </>
  );
}

function PinMarker({
  pin,
  index,
  isMoving,
  color,
  onClick,
}: {
  pin: LocationPhotoPin;
  index: number;
  isMoving?: boolean;
  color?: string;
  onClick: (pin: LocationPhotoPin) => void;
}) {
  const pinColor = isMoving ? "#facc15" : (color ?? "#ef4444");
  return (
    <button
      type="button"
      style={{
        position: "absolute",
        left: `${pin.xRatio * 100}%`,
        top: `${pin.yRatio * 100}%`,
        transform: "translate(-50%, -100%)",
        zIndex: 20,
      }}
      className="flex flex-col items-center"
      onClick={(e) => {
        e.stopPropagation();
        onClick(pin);
      }}
    >
      <div
        style={{ backgroundColor: pinColor }}
        className={[
          "flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-extrabold text-white shadow-lg transition-all",
          isMoving ? "scale-125 animate-pulse" : "",
        ].join(" ")}
      >
        {index + 1}
      </div>
      <div style={{ backgroundColor: pinColor }} className="h-2 w-0.5" />
    </button>
  );
}

function PinFormModal({
  projectId,
  position,
  onSave,
  onClose,
}: {
  projectId: string;
  position: { xRatio: number; yRatio: number };
  onSave: (data: PinData) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [subtitles, setSubtitles] = useState<SubtitleInfo[]>([]);
  const [workTypes, setWorkTypes] = useState<WorkTypeInfo[]>([]);
  const [selectedSubId, setSelectedSubId] = useState("");
  const [selectedWtId, setSelectedWtId] = useState("");
  const [subLoading, setSubLoading] = useState(true);
  const [wtLoading, setWtLoading] = useState(false);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // 工種一覧取得
  useEffect(() => {
    getDocs(
      query(
        collection(db, "projects", projectId, "subtitles"),
        orderBy("order", "asc"),
      ),
    )
      .then((snap) => {
        setSubtitles(
          snap.docs.map((d) => ({
            id: d.id,
            name: String(d.data().name ?? d.id),
          })),
        );
        setSubLoading(false);
      })
      .catch(() => setSubLoading(false));
  }, [projectId]);

  // 工区一覧取得
  useEffect(() => {
    if (!selectedSubId) {
      setWorkTypes([]);
      setSelectedWtId("");
      setPhotos([]);
      setSelectedPhotoIds([]);
      return;
    }
    setWtLoading(true);
    getDocs(
      query(
        collection(db, "projects", projectId, "subtitles", selectedSubId, "workTypes"),
        orderBy("order", "asc"),
      ),
    )
      .then((snap) => {
        setWorkTypes(snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) })));
        setSelectedWtId("");
        setPhotos([]);
        setSelectedPhotoIds([]);
        setWtLoading(false);
      })
      .catch(() => setWtLoading(false));
  }, [projectId, selectedSubId]);

  // 写真一覧取得
  useEffect(() => {
    if (!selectedSubId || !selectedWtId) {
      setPhotos([]);
      setSelectedPhotoIds([]);
      return;
    }
    setPhotosLoading(true);
    getDocs(
      query(
        collection(db, "projects", projectId, "subtitles", selectedSubId, "workTypes", selectedWtId, "photos"),
        orderBy("shotAt", "desc"),
        limit(80),
      ),
    )
      .then((snap) => {
        const nextPhotos = snap.docs
          .map((d) => {
            const data = d.data();
            const url = String(data.originalUrl ?? data.renderedUrl ?? "");
            if (!url) return null;
            const kokuban = data.kokuban as Record<string, unknown> | undefined;
            const m = kokuban?.memo ? String(kokuban.memo) : undefined;
            const shotByName =
              (typeof data.shotByDisplayName === "string" && data.shotByDisplayName.trim()) ||
              (typeof data.shotByEmail === "string" && data.shotByEmail.trim()) ||
              undefined;
            return { id: d.id, originalUrl: url, renderedUrl: data.renderedUrl ? String(data.renderedUrl) : undefined, memo: m, shotByName };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);
        setPhotos(nextPhotos);
        setSelectedPhotoIds([]);
        setPhotosLoading(false);
      })
      .catch(() => setPhotosLoading(false));
  }, [projectId, selectedSubId, selectedWtId]);

  const togglePhoto = (photoId: string) => {
    setSelectedPhotoIds((prev) =>
      prev.includes(photoId) ? prev.filter((id) => id !== photoId) : [...prev, photoId],
    );
  };

  const handleSave = () => {
    const sub = subtitles.find((s) => s.id === selectedSubId);
    const wt = workTypes.find((w) => w.id === selectedWtId);
    const linked: LinkedPhoto[] = selectedPhotoIds.flatMap((pid) => {
      const p = photos.find((ph) => ph.id === pid);
      if (!p) return [];
      const item: LinkedPhoto = { photoId: p.id, originalUrl: p.originalUrl };
      if (p.renderedUrl) item.renderedUrl = p.renderedUrl;
      if (p.shotByName) item.shotByName = p.shotByName;
      return [item];
    });
    onSave({
      name: name.trim() || "（名称未設定）",
      xRatio: position.xRatio,
      yRatio: position.yRatio,
      subtitleId: sub?.id,
      subtitleName: sub?.name,
      workTypeId: wt?.id,
      workTypeName: wt?.name,
      memo: memo.trim() || undefined,
      linkedPhotos: linked.length > 0 ? linked : undefined,
    });
  };

  const lightboxIndex = lightboxUrl ? photos.findIndex((p) => p.originalUrl === lightboxUrl) : -1;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
        onClick={onClose}
      >
        <div
          className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-2xl dark:bg-gray-900 sm:rounded-3xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between px-5 pt-5">
            <h2 className="text-base font-extrabold text-gray-900 dark:text-gray-100">ピンを追加</h2>
            <button type="button" onClick={onClose}>
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 pb-1 pt-4">
            <div className="space-y-3">
              {/* ピン名 */}
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-700 dark:text-gray-300">ピン名</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例：北面外壁 3F"
                  autoFocus
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                />
              </div>

              {/* 工種 */}
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-700 dark:text-gray-300">工種</label>
                {subLoading ? (
                  <div className="text-xs text-gray-400">読み込み中…</div>
                ) : (
                  <select
                    value={selectedSubId}
                    onChange={(e) => setSelectedSubId(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  >
                    <option value="">未設定</option>
                    {subtitles.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* 工区 */}
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-700 dark:text-gray-300">工区</label>
                {wtLoading ? (
                  <div className="text-xs text-gray-400">読み込み中…</div>
                ) : (
                  <select
                    value={selectedWtId}
                    onChange={(e) => setSelectedWtId(e.target.value)}
                    disabled={!selectedSubId || workTypes.length === 0}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  >
                    <option value="">未設定</option>
                    {workTypes.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* 写真一覧（工区選択後） */}
              {selectedWtId && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-bold text-gray-700 dark:text-gray-300">写真を選択</label>
                    {selectedPhotoIds.length > 0 && (
                      <span className="text-xs font-bold text-blue-600">{selectedPhotoIds.length}枚選択中</span>
                    )}
                  </div>
                  {photosLoading ? (
                    <div className="flex h-24 items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                    </div>
                  ) : photos.length === 0 ? (
                    <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-5 text-center text-xs text-gray-400 dark:border-gray-700 dark:bg-gray-800">
                      この工区の写真はまだありません
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {photos.map((photo) => {
                        const selected = selectedPhotoIds.includes(photo.id);
                        return (
                          <div key={photo.id} className="flex flex-col">
                            <div
                              className={[
                                "group relative aspect-square cursor-pointer overflow-hidden rounded-xl border-2 transition-all",
                                selected ? "border-blue-500 ring-2 ring-blue-400/40" : "border-transparent",
                              ].join(" ")}
                              onClick={() => togglePhoto(photo.id)}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={photo.originalUrl} alt="" className="h-full w-full object-cover" />
                              {selected && (
                                <div className="absolute inset-0 flex items-center justify-center bg-blue-500/20 group-hover:hidden">
                                  <CheckCircle2 className="h-6 w-6 text-white drop-shadow" />
                                </div>
                              )}
                              <div className="absolute inset-0 hidden flex-col items-center justify-center gap-2 bg-black/50 group-hover:flex">
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setLightboxUrl(photo.originalUrl); }}
                                  className="rounded-full bg-white/20 p-2 hover:bg-white/40"
                                  title="拡大"
                                >
                                  <ZoomIn className="h-5 w-5 text-white" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); togglePhoto(photo.id); }}
                                  className="rounded-full bg-white/20 p-2 hover:bg-white/40"
                                  title={selected ? "選択解除" : "選択"}
                                >
                                  {selected ? <CheckCircle2 className="h-5 w-5 text-white" /> : <Circle className="h-5 w-5 text-white" />}
                                </button>
                              </div>
                            </div>
                            <div className="mt-0.5 h-4 overflow-hidden">
                              <p className="truncate text-center text-[10px] text-gray-500 dark:text-gray-400">{photo.memo ?? ""}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="mt-1 text-[10px] text-gray-400">タップ/クリックで選択・PCはホバーで操作</p>
                </div>
              )}

              {/* メモ */}
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-700 dark:text-gray-300">メモ</label>
                <textarea
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  rows={2}
                  placeholder="任意のメモ"
                  className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                />
              </div>
            </div>
          </div>

          <div className="shrink-0 px-5 pb-5 pt-3">
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-extrabold text-gray-700 dark:border-gray-700 dark:text-gray-300"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="flex-1 rounded-xl bg-gray-900 py-3 text-sm font-extrabold text-white dark:bg-gray-100 dark:text-gray-900"
              >
                {selectedPhotoIds.length > 0 ? `保存（写真${selectedPhotoIds.length}枚）` : "保存"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90"
          onClick={() => setLightboxUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt=""
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white"
            onClick={() => setLightboxUrl(null)}
          >
            <X className="h-5 w-5" />
          </button>
          {lightboxIndex > 0 && (
            <button
              type="button"
              className="absolute left-4 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-black/50 text-white"
              onClick={(e) => { e.stopPropagation(); setLightboxUrl(photos[lightboxIndex - 1].originalUrl); }}
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {lightboxIndex < photos.length - 1 && (
            <button
              type="button"
              className="absolute right-4 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-black/50 text-white"
              onClick={(e) => { e.stopPropagation(); setLightboxUrl(photos[lightboxIndex + 1].originalUrl); }}
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </div>
      )}
    </>
  );
}

function PinDetailModal({
  pin,
  currentUid,
  onDelete,
  onClose,
}: {
  pin: LocationPhotoPin;
  currentUid: string;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const linked = pin.linkedPhotos ?? [];

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
        onClick={onClose}
      >
        <div
          className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-2xl dark:bg-gray-900 sm:rounded-3xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between px-5 pt-5">
            <div className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-red-500" />
              <h2 className="text-base font-extrabold text-gray-900 dark:text-gray-100">
                {pin.name}
              </h2>
            </div>
            <button type="button" onClick={onClose}>
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-2.5 text-sm">
              {pin.subtitleName && (
                <div className="flex gap-3">
                  <span className="w-12 shrink-0 text-xs font-bold text-gray-500">
                    工種
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {pin.subtitleName}
                  </span>
                </div>
              )}
              {pin.workTypeName && (
                <div className="flex gap-3">
                  <span className="w-12 shrink-0 text-xs font-bold text-gray-500">
                    工区
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {pin.workTypeName}
                  </span>
                </div>
              )}
              {pin.memo && (
                <div className="flex gap-3">
                  <span className="w-12 shrink-0 text-xs font-bold text-gray-500">
                    メモ
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {pin.memo}
                  </span>
                </div>
              )}
              {pin.createdByName && (
                <div className="flex gap-3">
                  <span className="w-12 shrink-0 text-xs font-bold text-gray-500">
                    追加者
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {pin.createdByName}
                  </span>
                </div>
              )}
              {!pin.subtitleName &&
                !pin.workTypeName &&
                !pin.memo &&
                !pin.createdByName &&
                linked.length === 0 && (
                  <p className="text-xs text-gray-400">詳細情報はありません</p>
                )}
            </div>

            {linked.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-bold text-gray-700 dark:text-gray-300">
                  リンク済み写真（{linked.length}枚）
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {linked.map((photo, idx) => (
                    <div key={photo.photoId} className="flex flex-col">
                      <button
                        type="button"
                        className="relative aspect-square overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700"
                        onClick={() => setLightboxIndex(idx)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={photo.originalUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      </button>
                      {photo.shotByName && (
                        <p className="mt-0.5 truncate text-center text-[10px] text-gray-500 dark:text-gray-400">
                          {photo.shotByName}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-3 px-5 pb-5 pt-2">
            {currentUid && pin.createdByUid === currentUid && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("このピンを削除しますか？")) {
                    onDelete(pin.id);
                    onClose();
                  }
                }}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-red-200 px-4 py-3 text-sm font-extrabold text-red-500 dark:border-red-900 dark:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
                削除
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl bg-gray-900 py-3 text-sm font-extrabold text-white dark:bg-gray-100 dark:text-gray-900"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>

      {lightboxIndex !== null && linked[lightboxIndex] && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90"
          onClick={() => setLightboxIndex(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={linked[lightboxIndex].originalUrl}
            alt=""
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white"
            onClick={() => setLightboxIndex(null)}
          >
            <X className="h-5 w-5" />
          </button>
          {lightboxIndex > 0 && (
            <button
              type="button"
              className="absolute left-4 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-black/50 text-white"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(lightboxIndex - 1);
              }}
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {lightboxIndex < linked.length - 1 && (
            <button
              type="button"
              className="absolute right-4 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-black/50 text-white"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(lightboxIndex + 1);
              }}
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </div>
      )}
    </>
  );
}

export default function LocationPhotosClient({
  initialProjectId,
}: {
  initialProjectId: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  const projectId = useMemo(
    () => toNonEmptyString(initialProjectId),
    [initialProjectId],
  );

  const session = useMemo(
    () => (typeof window === "undefined" ? null : loadCraftsmanSession()),
    [],
  );

  const [ready, setReady] = useState(false);
  const [currentUid, setCurrentUid] = useState("");
  const [currentDisplayName, setCurrentDisplayName] = useState("");
  const [docsLoading, setDocsLoading] = useState(true);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [rawDocs, setRawDocs] = useState<LocationPhotoDocument[]>([]);
  const [docs, setDocs] = useState<LocationPhotoDocument[]>([]);
  const [savedOrder, setSavedOrder] = useState<string[] | null>(null);
  const [pins, setPins] = useState<LocationPhotoPin[]>([]);
  const [projectName, setProjectName] = useState<string>(
    safeDecode(sp.get("projectName")),
  );
  const [selectedDoc, setSelectedDoc] = useState<LocationPhotoDocument | null>(
    null,
  );
  const [selectedPin, setSelectedPin] = useState<LocationPhotoPin | null>(null);
  const [view, setView] = useState<"list" | "viewer">("list");
  const [contentReady, setContentReady] = useState(false);
  const [mode, setMode] = useState<"read" | "add" | "move">("read");
  const [pendingPos, setPendingPos] = useState<{ xRatio: number; yRatio: number } | null>(null);
  const [movingPin, setMovingPin] = useState<LocationPhotoPin | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        router.replace("/login");
        return;
      }
      setCurrentUid(u.uid);
      setCurrentDisplayName(u.displayName ?? u.email ?? "");
      setReady(true);
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!ready || !projectId) return;
    if (projectName) return;

    const fromSession =
      session?.projectId === projectId
        ? toNonEmptyString(session?.projectName)
        : "";
    if (fromSession) {
      setProjectName(fromSession);
      return;
    }

    let mounted = true;
    (async () => {
      try {
        const snap = await getDoc(doc(db, "projects", projectId));
        if (!mounted || !snap.exists()) return;
        const d = snap.data() as {
          name?: unknown;
          title?: unknown;
          projectName?: unknown;
        };
        const picked =
          toNonEmptyString(d.name) ||
          toNonEmptyString(d.title) ||
          toNonEmptyString(d.projectName);
        if (picked) setProjectName(picked);
      } catch {
        // ignore
      }
    })();

    return () => {
      mounted = false;
    };
  }, [projectId, projectName, ready, session]);

  useEffect(() => {
    if (!ready || !projectId) return;
    let alive = true;

    (async () => {
      try {
        const snap = await getDoc(
          doc(
            db,
            "projects",
            projectId,
            "locationPhotoDocumentsConfig",
            "order",
          ),
        );
        if (!alive || !snap.exists()) return;
        const data = snap.data() as { ids?: string[] };
        setSavedOrder(Array.isArray(data.ids) ? data.ids : null);
      } catch {
        // ignore
      }
    })();

    return () => {
      alive = false;
    };
  }, [projectId, ready]);

  useEffect(() => {
    if (!ready || !projectId) return;

    const q = query(
      collection(db, "projects", projectId, "locationPhotoDocuments"),
      orderBy("createdAt", "desc"),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setRawDocs(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<LocationPhotoDocument, "id">),
          })),
        );
        setDocsLoading(false);
      },
      () => setDocsLoading(false),
    );

    return () => unsub();
  }, [projectId, ready]);

  useEffect(() => {
    if (savedOrder === null) {
      setDocs(rawDocs);
      return;
    }
    const map = new Map(rawDocs.map((d) => [d.id, d]));
    const ordered: LocationPhotoDocument[] = [];
    for (const id of savedOrder) {
      const d = map.get(id);
      if (d) ordered.push(d);
    }
    for (const d of rawDocs) {
      if (!savedOrder.includes(d.id)) ordered.push(d);
    }
    setDocs(ordered);
  }, [rawDocs, savedOrder]);

  useEffect(() => {
    if (!projectId || !selectedDoc) {
      setPins([]);
      return;
    }

    setPinsLoading(true);
    const q = query(
      collection(
        db,
        "projects",
        projectId,
        "locationPhotoDocuments",
        selectedDoc.id,
        "pins",
      ),
      orderBy("createdAt", "asc"),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setPins(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<LocationPhotoPin, "id">),
          })),
        );
        setPinsLoading(false);
      },
      () => setPinsLoading(false),
    );

    return () => unsub();
  }, [projectId, selectedDoc]);

  const handleSavePin = useCallback(
    async (data: PinData) => {
      if (!projectId || !selectedDoc || !currentUid) return;
      const now = Timestamp.now();
      const pinPayload: Record<string, unknown> = {
        name: data.name,
        xRatio: data.xRatio,
        yRatio: data.yRatio,
        createdByUid: currentUid,
        createdByName: currentDisplayName,
        createdAt: now,
        updatedAt: now,
      };
      if (data.subtitleId) pinPayload.subtitleId = data.subtitleId;
      if (data.subtitleName) pinPayload.subtitleName = data.subtitleName;
      if (data.workTypeId) pinPayload.workTypeId = data.workTypeId;
      if (data.workTypeName) pinPayload.workTypeName = data.workTypeName;
      if (data.memo) pinPayload.memo = data.memo;
      if (data.linkedPhotos && data.linkedPhotos.length > 0) {
        pinPayload.linkedPhotos = data.linkedPhotos.map((photo) => {
          const linked: Record<string, string> = { photoId: photo.photoId, originalUrl: photo.originalUrl };
          if (photo.renderedUrl) linked.renderedUrl = photo.renderedUrl;
          if (photo.shotByName) linked.shotByName = photo.shotByName;
          return linked;
        });
      }
      try {
        await addDoc(
          collection(db, "projects", projectId, "locationPhotoDocuments", selectedDoc.id, "pins"),
          pinPayload,
        );
        setPendingPos(null);
        setMode("read");
      } catch (err) {
        console.error("ピンの保存に失敗しました:", err);
        alert("ピンの保存に失敗しました。もう一度お試しください。");
      }
    },
    [projectId, selectedDoc, currentUid, currentDisplayName],
  );

  const handleDeletePin = useCallback(
    async (pinId: string) => {
      if (!projectId || !selectedDoc) return;
      try {
        await deleteDoc(
          doc(db, "projects", projectId, "locationPhotoDocuments", selectedDoc.id, "pins", pinId),
        );
      } catch (err) {
        console.error("ピンの削除に失敗しました:", err);
        alert("ピンの削除に失敗しました。");
      }
    },
    [projectId, selectedDoc],
  );

  const handleMovePin = useCallback(
    async (pinId: string, xRatio: number, yRatio: number) => {
      if (!projectId || !selectedDoc) return;
      try {
        await updateDoc(
          doc(db, "projects", projectId, "locationPhotoDocuments", selectedDoc.id, "pins", pinId),
          { xRatio, yRatio, updatedAt: Timestamp.now() },
        );
        setMovingPin(null);
      } catch (err) {
        console.error("ピンの移動に失敗しました:", err);
        alert("ピンの移動に失敗しました。");
      }
    },
    [projectId, selectedDoc],
  );

  const openViewer = useCallback((docItem: LocationPhotoDocument) => {
    setSelectedDoc(docItem);
    setSelectedPin(null);
    setContentReady(docItem.fileType === "image");
    setMode("read");
    setPendingPos(null);
    setMovingPin(null);
    setView("viewer");
  }, []);

  if (!projectId) return null;
  if (!ready) return null;

  if (view === "list") {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-md px-4 py-8">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-xl font-extrabold text-gray-900 dark:text-gray-100">
                箇所写真管理
              </h1>
              <p className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                現場：{projectName || "（名称未設定）"}
              </p>
              <p className="mt-1 text-[11px] font-bold text-blue-700 dark:text-blue-300">
                閲覧専用
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                router.push(`/projects/${encodeURIComponent(projectId)}/menu`)
              }
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border bg-white text-gray-900 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
              aria-label="戻る"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5">
            {docsLoading ? (
              <div className="flex items-center justify-center py-14">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : docs.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                共有された図面・画像はまだありません
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {docs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="overflow-hidden rounded-2xl border border-gray-200 bg-white text-left hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-900/70"
                    onClick={() => openViewer(d)}
                  >
                    <div className="aspect-square bg-gray-100 dark:bg-gray-800">
                      {d.fileType === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={d.fileUrl}
                          alt={d.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-extrabold text-red-600">
                          PDF
                        </div>
                      )}
                    </div>
                    <div className="border-t border-gray-100 px-2 py-1.5 dark:border-gray-800">
                      <p className="truncate text-xs font-extrabold text-gray-900 dark:text-gray-100">
                        {d.name}
                      </p>
                      <p className="mt-0.5 text-[10px] text-gray-500">
                        {d.fileType === "pdf" ? "PDF（1ページ目表示）" : "画像"}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-gray-950">
      <div className="flex items-center gap-3 bg-gray-900 px-4 py-3">
        <button
          type="button"
          onClick={() => {
            setView("list");
            setSelectedDoc(null);
            setSelectedPin(null);
            setMode("read");
            setPendingPos(null);
            setMovingPin(null);
          }}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gray-800 text-gray-100"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm font-extrabold text-gray-100">
          {selectedDoc?.name}
        </p>
        {contentReady && (
          <div className="flex shrink-0 gap-1 rounded-xl bg-gray-800 p-1">
            {(
              [
                { key: "read", label: "読み取り", Icon: Eye },
                { key: "add",  label: "ピン",     Icon: Plus },
                { key: "move", label: "移動",     Icon: Move },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => { setMode(key); setMovingPin(null); setPendingPos(null); }}
                className={[
                  "flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-extrabold transition-colors",
                  mode === key
                    ? "bg-blue-500 text-white"
                    : "text-gray-400 hover:text-gray-200",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className="relative w-full"
        style={{
          cursor: mode !== "read" && contentReady ? "crosshair" : "default",
        }}
        onClick={(e) => {
          if (mode === "read" || !contentReady || selectedPin) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const xRatio = (e.clientX - rect.left) / rect.width;
          const yRatio = (e.clientY - rect.top) / rect.height;
          if (mode === "move" && movingPin) {
            void handleMovePin(movingPin.id, xRatio, yRatio);
          } else if (mode === "add" && !pendingPos) {
            setPendingPos({ xRatio, yRatio });
          }
        }}
      >
        {selectedDoc?.fileType === "pdf" ? (
          <PdfPageCanvas
            url={selectedDoc.fileUrl}
            onReady={() => setContentReady(true)}
          />
        ) : selectedDoc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={selectedDoc.fileUrl}
            alt={selectedDoc.name}
            className="block w-full"
            onLoad={() => setContentReady(true)}
            draggable={false}
          />
        ) : null}

        {!pinsLoading &&
          contentReady &&
          pins.map((pin, idx) => (
            <PinMarker
              key={pin.id}
              pin={pin}
              index={idx}
              isMoving={movingPin?.id === pin.id}
              onClick={(p) => {
                if (mode === "move" && p.createdByUid === currentUid) {
                  setMovingPin((prev) => (prev?.id === p.id ? null : p));
                } else {
                  setSelectedPin(p);
                }
              }}
            />
          ))}

      </div>

      {/* ピン一覧（下部スクロールバー） */}
      {!pinsLoading && pins.length > 0 && (
        <div className="bg-gray-900 px-4 py-3">
          <p className="mb-2 text-xs font-bold text-gray-400">
            ピン一覧（{pins.length}件）
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {pins.map((pin, idx) => (
              <button
                key={pin.id}
                type="button"
                onClick={() => setSelectedPin(pin)}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gray-800 px-3 py-1.5 text-xs font-bold text-gray-100 hover:bg-gray-700"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[9px] font-extrabold text-white">
                  {idx + 1}
                </span>
                {pin.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedPin && (
        <PinDetailModal
          pin={selectedPin}
          currentUid={currentUid}
          onDelete={handleDeletePin}
          onClose={() => setSelectedPin(null)}
        />
      )}

      {pendingPos && (
        <PinFormModal
          projectId={projectId}
          position={pendingPos}
          onSave={(data) => void handleSavePin(data)}
          onClose={() => { setPendingPos(null); setMode("read"); }}
        />
      )}

    </main>
  );
}
