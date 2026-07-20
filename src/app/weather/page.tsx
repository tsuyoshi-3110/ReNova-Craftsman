"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud,
  CloudRain,
  CloudSun,
  MapPin,
  RefreshCw,
  Snowflake,
  Sun,
  Umbrella,
  Wind,
  Zap,
} from "lucide-react";

type WeatherCurrent = {
  time: string;
  temperature: number;
  weatherCode: number;
  weatherLabel: string;
  windSpeed: number;
} | null;

type WeatherHourly = {
  time: string;
  temperature: number | null;
  precipitationProbability: number | null;
  precipitation: number | null;
  weatherCode: number;
  weatherLabel: string;
  windSpeed: number | null;
};

type WeatherDaily = {
  date: string;
  weatherCode: number;
  weatherLabel: string;
  temperatureMax: number | null;
  temperatureMin: number | null;
  precipitationProbabilityMax: number | null;
  precipitationSum: number | null;
  windSpeedMax: number | null;
};

type WeatherResponse = {
  location: {
    latitude: number;
    longitude: number;
  };
  current: WeatherCurrent;
  todayHourly: WeatherHourly[];
  daily: WeatherDaily[];
  error?: string;
};

type NearbyInfoItem = {
  key: string;
  title: string;
  hint: string;
  query: string;
};

type AddressComponent = {
  long_name: string;
  types: string[];
};

type GeocodingResponse = {
  status: string;
  results: Array<{
    formatted_address?: string;
    address_components?: AddressComponent[];
  }>;
};

function buildAddressUpToChome(components: AddressComponent[]): string {
  const get = (type: string) =>
    components.find((c) => c.types.includes(type))?.long_name ?? "";

  const prefecture = get("administrative_area_level_1");
  const city = get("locality");
  const ward = get("sublocality_level_1");
  const district = get("sublocality_level_2");
  const chome = get("sublocality_level_3");

  return [prefecture, city, ward, district, chome].filter(Boolean).join("");
}

function buildGoogleMapsSearchUrl(
  query: string,
  latitude: number,
  longitude: number,
): string {
  const lat = latitude.toFixed(6);
  const lng = longitude.toFixed(6);
  const encodedQuery = encodeURIComponent(query);
  // パス形式の search + @lat,lng,zoom を使うと、現在地近傍にフォーカスしやすい。
  return `https://www.google.com/maps/search/${encodedQuery}/@${lat},${lng},16z?hl=ja`;
}

function formatDateJa(dateText: string): string {
  const d = new Date(`${dateText}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return dateText;

  const weekday = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${weekday}）`;
}

function formatDateTimeJa(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const month = d.getMonth() + 1;
  const date = d.getDate();
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${date} ${hour}:${minute}`;
}

function valueOrDash(value: number | null | undefined, suffix = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value}${suffix}`;
}

function getCurrentPositionAsync(
  options: PositionOptions,
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function getGeolocationErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = Number((error as { code: unknown }).code);
  return Number.isFinite(code) ? code : null;
}

function getLocationErrorMessage(error: unknown): string {
  const code = getGeolocationErrorCode(error);

  if (code !== null) {
    if (code === 1) {
      return "位置情報の利用が許可されていません。Safariのサイト設定または端末の位置情報設定で許可してください。";
    }

    if (code === 2) {
      return "現在地を取得できませんでした。電波状況を確認して、もう一度お試しください。";
    }

    if (code === 3) {
      return "現在地の取得がタイムアウトしました。電波の良い場所で、もう一度お試しください。";
    }
  }

  return "現在地を取得できませんでした。位置情報の許可設定をご確認ください。";
}

function WeatherIcon({
  code,
  className = "h-5 w-5",
}: {
  code: number;
  className?: string;
}) {
  if (code === 0 || code === 1) {
    return <Sun className={className} />;
  }

  if (code === 2) {
    return <CloudSun className={className} />;
  }

  if (code === 3 || code === 45 || code === 48) {
    return <Cloud className={className} />;
  }

  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) {
    return <CloudRain className={className} />;
  }

  if ([71, 73, 75].includes(code)) {
    return <Snowflake className={className} />;
  }

  if ([95, 96, 99].includes(code)) {
    return <Zap className={className} />;
  }

  return <CloudSun className={className} />;
}

function WeatherBadge({ code, label }: { code: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-extrabold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
      <WeatherIcon code={code} className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

export default function WeatherPage() {
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationLabel, setLocationLabel] = useState("現在地");
  const [currentAddress, setCurrentAddress] = useState<string | null>(null);
  const [isWeeklyOpen, setIsWeeklyOpen] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [prioritizeOpenNow, setPrioritizeOpenNow] = useState(true);

  const fetchWeather = useCallback(
    async (latitude: number, longitude: number, label = "指定地点") => {
      try {
        setLoading(true);
        setError(null);
        setLocationLabel(label);

        const params = new URLSearchParams({
          latitude: String(latitude),
          longitude: String(longitude),
        });

        const res = await fetch(`/api/weather?${params.toString()}`);
        const data = (await res.json()) as WeatherResponse;

        if (!res.ok) {
          throw new Error(data.error || "現在地情報の取得に失敗しました");
        }

        setWeather(data);
      } catch (e: unknown) {
        setWeather(null);
        setError(
          e instanceof Error ? e.message : "現在地情報の取得に失敗しました",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const fetchCurrentAddress = useCallback(
    async (latitude: number, longitude: number) => {
      try {
        const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
          setCurrentAddress(null);
          return;
        }

        const params = new URLSearchParams({
          latlng: `${latitude},${longitude}`,
          language: "ja",
          key: apiKey,
        });

        const res = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
        );
        if (!res.ok) {
          setCurrentAddress(null);
          return;
        }

        const data = (await res.json()) as GeocodingResponse;
        if (data.status !== "OK" || !data.results[0]) {
          setCurrentAddress(null);
          return;
        }

        const components = data.results[0].address_components ?? [];
        const chomeAddress = buildAddressUpToChome(components);
        if (chomeAddress) {
          setCurrentAddress(`${chomeAddress}付近`);
          return;
        }

        // フォールバック: formatted_address から "日本、" を除去して使用
        const fallback = data.results[0].formatted_address?.replace(/^日本、/, "") ?? null;
        setCurrentAddress(fallback ? `${fallback}付近` : null);
      } catch {
        setCurrentAddress(null);
      }
    },
    [],
  );

  const loadCurrentLocation = useCallback(async () => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return;
    }

    if (!window.isSecureContext) {
      setLoading(false);
      setWeather(null);
      setCurrentAddress(null);
      setError("位置情報はHTTPS接続でのみ利用できます。");
      return;
    }

    if (!navigator.geolocation) {
      setLoading(false);
      setWeather(null);
      setCurrentAddress(null);
      setError("このブラウザでは現在地取得が利用できません。");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const position = await getCurrentPositionAsync({
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 1000 * 60 * 5,
      }).catch((primaryError: unknown) => {
        if (getGeolocationErrorCode(primaryError) === 1) {
          throw primaryError;
        }

        return getCurrentPositionAsync({
          enableHighAccuracy: true,
          timeout: 25000,
          maximumAge: 0,
        });
      });

      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      setGpsCoords({ lat, lng });
      void fetchCurrentAddress(lat, lng);
      await fetchWeather(lat, lng, "現在地");
    } catch (e: unknown) {
      setLoading(false);
      setWeather(null);
      setCurrentAddress(null);
      setError(getLocationErrorMessage(e));
    }
  }, [fetchCurrentAddress, fetchWeather]);

  useEffect(() => {
    void loadCurrentLocation();
  }, [loadCurrentLocation]);

  const todayRainProbability = useMemo(() => {
    if (!weather?.todayHourly?.length) return null;
    const values = weather.todayHourly
      .map((x) => x.precipitationProbability)
      .filter((x): x is number => typeof x === "number");
    if (values.length === 0) return null;
    return Math.max(...values);
  }, [weather]);

  const nearbyInfoItems = useMemo<NearbyInfoItem[]>(() => {
    return [
      {
        key: "emergency-hospital",
        title: "救急病院",
        hint: "夜間・救急対応の医療機関",
        query: "救急病院",
      },
      {
        key: "electric-company",
        title: "電気会社",
        hint: "停電・トラブル時の相談先",
        query: "電力会社 営業所",
      },
      {
        key: "water-service",
        title: "水道",
        hint: "漏水・断水時の相談先",
        query: "水道局",
      },
      {
        key: "gas-company",
        title: "ガス",
        hint: "ガス漏れ・供給トラブル時の相談先",
        query: "ガス会社",
      },
      {
        key: "konan",
        title: "コーナン",
        hint: "資材・工具の調達",
        query: "コーナン",
      },
      {
        key: "parking",
        title: "駐車場",
        hint: "コインパーキング・月極候補",
        query: "近くのコインパーキング",
      },
      {
        key: "convenience-store",
        title: "コンビニエンスストア",
        hint: "飲み物・軽食・日用品の調達",
        query: "近くのコンビニ",
      },
      {
        key: "restaurant",
        title: "レストラン",
        hint: "周辺の飲食店を検索",
        query: "近くのレストラン",
      },
    ];
  }, []);

  const buildNearbyQuery = useCallback(
    (baseQuery: string) => {
      if (!prioritizeOpenNow) return baseQuery;
      return `${baseQuery} 営業中`;
    },
    [prioritizeOpenNow],
  );

  return (
    <main className="min-h-dvh bg-gray-50 px-4 py-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-extrabold text-gray-600 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-800">
              <MapPin className="h-4 w-4" />
              Open-Meteo 現在地情報
            </div>
            <h1 className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
              現在地情報
            </h1>
            {currentAddress ? (
              <p className="mt-2 text-sm font-bold text-gray-700 dark:text-gray-200">
                現在地: {currentAddress}
              </p>
            ) : null}
            <p className="mt-3 text-xs font-extrabold text-gray-500 dark:text-gray-400">
              現在地の天気・周辺情報
            </p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              本日の時間別天気と週間天気を確認できます。
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void loadCurrentLocation();
              }}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-extrabold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
              現在地を更新
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {loading && !weather ? (
          <div className="mt-8 flex items-center gap-3 rounded-3xl border border-gray-200 bg-white p-5 text-sm font-extrabold text-gray-600 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            現在地情報を取得中...
          </div>
        ) : null}

        {weather ? (
          <div className="mt-6 space-y-6">
            <section className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-sm font-bold text-gray-500 dark:text-gray-400">
                    {locationLabel}
                  </div>
                  <h2 className="mt-1 text-xl font-extrabold">
                    本日の詳細天気
                  </h2>
                  {weather.current ? (
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      更新時刻: {formatDateTimeJa(weather.current.time)}
                    </div>
                  ) : null}
                </div>

                {weather.current ? (
                  <div className="grid gap-3 sm:grid-cols-4 md:min-w-130">
                    <div className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-950">
                      <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                        現在気温
                      </div>
                      <div className="mt-1 text-2xl font-extrabold">
                        {weather.current.temperature}℃
                      </div>
                    </div>
                    <div className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-950">
                      <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                        天気
                      </div>
                      <div className="mt-2">
                        <WeatherBadge
                          code={weather.current.weatherCode}
                          label={weather.current.weatherLabel}
                        />
                      </div>
                    </div>
                    <div className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-950">
                      <div className="flex items-center gap-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                        <Wind className="h-3.5 w-3.5" />
                        風速
                      </div>
                      <div className="mt-1 text-lg font-extrabold">
                        {weather.current.windSpeed} km/h
                      </div>
                    </div>
                    <div className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-950">
                      <div className="flex items-center gap-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                        <Umbrella className="h-3.5 w-3.5" />
                        本日最大降水確率
                      </div>
                      <div className="mt-1 text-lg font-extrabold">
                        {valueOrDash(todayRainProbability, "%")}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-5 overflow-x-auto pb-2">
                <div className="flex min-w-max gap-3">
                  {weather.todayHourly.map((hour) => (
                    <div
                      key={hour.time}
                      className="w-36 rounded-2xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950"
                    >
                      <div className="text-sm font-extrabold">{hour.time}</div>
                      <div className="mt-2">
                        <WeatherBadge
                          code={hour.weatherCode}
                          label={hour.weatherLabel}
                        />
                      </div>
                      <div className="mt-3 space-y-1 text-xs text-gray-600 dark:text-gray-300">
                        <div>気温: {valueOrDash(hour.temperature, "℃")}</div>
                        <div>
                          降水確率:{" "}
                          {valueOrDash(hour.precipitationProbability, "%")}
                        </div>
                        <div>
                          降水量: {valueOrDash(hour.precipitation, "mm")}
                        </div>
                        <div>風速: {valueOrDash(hour.windSpeed, "km/h")}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsWeeklyOpen((v) => !v)}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 touch-none select-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-900"
                  aria-expanded={isWeeklyOpen}
                  title={isWeeklyOpen ? "折り畳み" : "展開"}
                  aria-label={isWeeklyOpen ? "折り畳み" : "展開"}
                >
                  {isWeeklyOpen ? "▼" : "▶"}
                </button>
                <div>
                  <h2 className="text-xl font-extrabold">週間天気</h2>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    7日間の天気・気温・降水・風を確認できます。
                  </p>
                </div>
              </div>

              {isWeeklyOpen ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {weather.daily.map((day) => (
                    <div
                      key={day.date}
                      className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-extrabold">
                            {formatDateJa(day.date)}
                          </div>
                          <div className="mt-2">
                            <WeatherBadge
                              code={day.weatherCode}
                              label={day.weatherLabel}
                            />
                          </div>
                        </div>
                        <WeatherIcon
                          code={day.weatherCode}
                          className="h-6 w-6 text-gray-400"
                        />
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                        <div className="rounded-2xl bg-gray-50 p-2 dark:bg-gray-950">
                          <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                            最高
                          </div>
                          <div className="font-extrabold">
                            {valueOrDash(day.temperatureMax, "℃")}
                          </div>
                        </div>
                        <div className="rounded-2xl bg-gray-50 p-2 dark:bg-gray-950">
                          <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                            最低
                          </div>
                          <div className="font-extrabold">
                            {valueOrDash(day.temperatureMin, "℃")}
                          </div>
                        </div>
                        <div className="rounded-2xl bg-gray-50 p-2 dark:bg-gray-950">
                          <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                            最大降水確率
                          </div>
                          <div className="font-extrabold">
                            {valueOrDash(day.precipitationProbabilityMax, "%")}
                          </div>
                        </div>
                        <div className="rounded-2xl bg-gray-50 p-2 dark:bg-gray-950">
                          <div className="text-xs font-bold text-gray-500 dark:text-gray-400">
                            降水量
                          </div>
                          <div className="font-extrabold">
                            {valueOrDash(day.precipitationSum, "mm")}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 rounded-2xl bg-gray-50 p-2 text-sm dark:bg-gray-950">
                        <div className="flex items-center gap-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                          <Wind className="h-3.5 w-3.5" />
                          最大風速
                        </div>
                        <div className="mt-1 font-extrabold">
                          {valueOrDash(day.windSpeedMax, "km/h")}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {weather.daily.map((day) => (
                    <div
                      key={day.date}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-200"
                      aria-label={`${formatDateJa(day.date)} ${day.weatherLabel}`}
                      title={`${formatDateJa(day.date)} ${day.weatherLabel}`}
                    >
                      <WeatherIcon
                        code={day.weatherCode}
                        className="h-4.5 w-4.5"
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-xl font-extrabold">
                    周辺の緊急・生活スポット
                  </h2>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    Googleマップ検索で現在地周辺の情報をすぐ確認できます。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPrioritizeOpenNow((v) => !v)}
                  className={`rounded-xl border px-3 py-2 text-xs font-extrabold transition-colors ${
                    prioritizeOpenNow
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200"
                      : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                  }`}
                  aria-pressed={prioritizeOpenNow}
                >
                  {prioritizeOpenNow
                    ? "営業時間中を優先: ON"
                    : "営業時間中を優先: OFF"}
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {nearbyInfoItems.map((item) => (
                  <a
                    key={item.key}
                    href={buildGoogleMapsSearchUrl(
                      buildNearbyQuery(item.query),
                      gpsCoords?.lat ?? weather.location.latitude,
                      gpsCoords?.lng ?? weather.location.longitude,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="group block rounded-3xl border border-gray-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800"
                    aria-label={`${item.title}をGoogleマップで開く`}
                  >
                    <div className="text-base font-extrabold">{item.title}</div>
                    <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                      {item.hint}
                    </div>
                  </a>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
