// src/lib/workItemNames.ts
// 職人のグローバル工種（"足場" など）を、工事ごとの subtitle 名に展開する。
//
// proclink の工種一覧は members.workItemNames と subtitle 名の完全一致
// （NFKC 正規化 + 「工事」接尾辞の揺れのみ吸収）でフィルタするため、
// "足場" のままでは "足場組立" / "足場解体" に一致せず全件非表示になる。
// そのため書き込み時に部分一致で実際の subtitle 名へ展開して保存する。

import { collection, getDocs, type Firestore } from "firebase/firestore";

function normalizeName(v: unknown): string {
  return String(v ?? "")
    .trim()
    .normalize("NFKC");
}

export async function expandWorkTypesToSubtitleNames(
  db: Firestore,
  projectId: string,
  workTypes: string[],
): Promise<string[]> {
  const wanted = workTypes.map(normalizeName).filter(Boolean);
  if (wanted.length === 0) return [];

  try {
    const snap = await getDocs(
      collection(db, "projects", projectId, "subtitles"),
    );
    const subtitleNames = snap.docs
      .map((d) => {
        const raw = d.data() as Record<string, unknown>;
        return normalizeName(raw.name ?? raw.title);
      })
      .filter(Boolean);

    // subtitles 未設定の工事はそのまま（proclink 側も制限なし扱いにならないが、
    // 少なくとも renova の一覧表示には使える）
    if (subtitleNames.length === 0) return wanted;

    const matched = subtitleNames.filter((sn) =>
      wanted.some((wt) => sn.includes(wt) || wt.includes(sn)),
    );

    // 1件も一致しない場合は元の工種名を保存（proclink では非表示になるが、
    // その工事に職人の工種に対応する subtitle が無いという事実を反映）
    return matched.length > 0 ? Array.from(new Set(matched)) : wanted;
  } catch {
    // subtitles が読めない場合は元の工種名をそのまま使う
    return wanted;
  }
}
