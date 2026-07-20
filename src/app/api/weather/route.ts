import { NextResponse } from "next/server";

export const runtime = "nodejs";

type OpenMeteoResponse = {
  latitude: number;
  longitude: number;
  current_weather?: {
    time: string;
    temperature: number;
    weathercode: number;
    windspeed: number;
  };
  hourly?: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weather_code: number[];
    wind_speed_10m: number[];
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    precipitation_sum: number[];
    wind_speed_10m_max: number[];
  };
};

function weatherCodeToLabel(code: number): string {
  if (code === 0) return "快晴";
  if (code === 1) return "晴れ";
  if (code === 2) return "一部曇り";
  if (code === 3) return "曇り";
  if (code === 45 || code === 48) return "霧";
  if ([51, 53, 55].includes(code)) return "霧雨";
  if ([56, 57].includes(code)) return "着氷性の霧雨";
  if ([61, 63, 65].includes(code)) return "雨";
  if ([66, 67].includes(code)) return "着氷性の雨";
  if ([71, 73, 75].includes(code)) return "雪";
  if (code === 77) return "雪粒";
  if ([80, 81, 82].includes(code)) return "にわか雨";
  if ([85, 86].includes(code)) return "にわか雪";
  if (code === 95) return "雷雨";
  if ([96, 99].includes(code)) return "ひょうを伴う雷雨";
  return "";
}

function toNumber(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatWeatherSummary(args: {
  current: {
    weatherLabel: string;
    temperature: number | null;
    windSpeed: number | null;
  } | null;
  daily: Array<{
    date: string;
    weatherLabel: string;
    temperatureMax: number | null;
    temperatureMin: number | null;
    precipitationProbabilityMax: number | null;
    precipitationSum: number | null;
    windSpeedMax: number | null;
  }>;
}): string {
  const today = args.daily[0];
  const tomorrow = args.daily[1];

  const lines: string[] = [];

  if (args.current) {
    const parts = [
      args.current.weatherLabel ? `現在の天気は${args.current.weatherLabel}` : "",
      typeof args.current.temperature === "number"
        ? `気温は${args.current.temperature}℃`
        : "",
      typeof args.current.windSpeed === "number"
        ? `風速は${args.current.windSpeed}km/h`
        : "",
    ].filter((part) => part.length > 0);

    if (parts.length > 0) {
      lines.push(`${parts.join("、")}です。`);
    }
  }

  if (today) {
    const parts = [
      today.weatherLabel ? `天気は${today.weatherLabel}` : "",
      typeof today.temperatureMax === "number"
        ? `最高気温は${today.temperatureMax}℃`
        : "",
      typeof today.temperatureMin === "number"
        ? `最低気温は${today.temperatureMin}℃`
        : "",
      typeof today.precipitationProbabilityMax === "number"
        ? `降水確率は最大${today.precipitationProbabilityMax}%`
        : "",
      typeof today.precipitationSum === "number"
        ? `降水量は${today.precipitationSum}mm`
        : "",
    ].filter((part) => part.length > 0);

    if (parts.length > 0) {
      lines.push(`今日（${today.date}）は、${parts.join("、")}です。`);
    }
  }

  if (tomorrow) {
    const parts = [
      tomorrow.weatherLabel ? `天気は${tomorrow.weatherLabel}` : "",
      typeof tomorrow.temperatureMax === "number"
        ? `最高気温は${tomorrow.temperatureMax}℃`
        : "",
      typeof tomorrow.temperatureMin === "number"
        ? `最低気温は${tomorrow.temperatureMin}℃`
        : "",
      typeof tomorrow.precipitationProbabilityMax === "number"
        ? `降水確率は最大${tomorrow.precipitationProbabilityMax}%`
        : "",
      typeof tomorrow.precipitationSum === "number"
        ? `降水量は${tomorrow.precipitationSum}mm`
        : "",
    ].filter((part) => part.length > 0);

    if (parts.length > 0) {
      lines.push(`明日（${tomorrow.date}）は、${parts.join("、")}です。`);
    }
  }

  return lines.join("\n");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const latitude = toNumber(searchParams.get("latitude"));
    const longitude = toNumber(searchParams.get("longitude"));

    if (latitude == null || longitude == null) {
      return NextResponse.json(
        { error: "latitude と longitude が必要です" },
        { status: 400 },
      );
    }

    const openMeteoUrl = new URL("https://api.open-meteo.com/v1/forecast");

    openMeteoUrl.searchParams.set("latitude", String(latitude));
    openMeteoUrl.searchParams.set("longitude", String(longitude));
    openMeteoUrl.searchParams.set("current_weather", "true");
    openMeteoUrl.searchParams.set(
      "hourly",
      [
        "temperature_2m",
        "precipitation_probability",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
      ].join(","),
    );
    openMeteoUrl.searchParams.set(
      "daily",
      [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "precipitation_sum",
        "wind_speed_10m_max",
      ].join(","),
    );
    openMeteoUrl.searchParams.set("forecast_days", "7");
    // 過去日（前日の降雨判定などに使用）。指定時のみ付与（既定は付けない）。
    const pastDays = toNumber(searchParams.get("pastDays"));
    if (pastDays != null && pastDays > 0) {
      openMeteoUrl.searchParams.set(
        "past_days",
        String(Math.min(7, Math.floor(pastDays))),
      );
    }
    openMeteoUrl.searchParams.set("timezone", "Asia/Tokyo");

    const res = await fetch(openMeteoUrl.toString(), {
      next: { revalidate: 60 * 30 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "現在地情報の取得に失敗しました" },
        { status: 502 },
      );
    }

    const data = (await res.json()) as OpenMeteoResponse;

    const today = new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo",
    });

    const hourly = data.hourly;
    const todayHourly =
      hourly?.time
        ?.map((time, index) => {
          const date = time.slice(0, 10);
          if (date !== today) return null;

          const weatherCode = hourly.weather_code?.[index] ?? 0;

          return {
            time: time.slice(11, 16),
            temperature: hourly.temperature_2m?.[index] ?? null,
            precipitationProbability:
              hourly.precipitation_probability?.[index] ?? null,
            precipitation: hourly.precipitation?.[index] ?? null,
            weatherCode,
            weatherLabel: weatherCodeToLabel(weatherCode),
            windSpeed: hourly.wind_speed_10m?.[index] ?? null,
          };
        })
        .filter(Boolean) ?? [];

    const daily =
      data.daily?.time?.map((date, index) => {
        const weatherCode = data.daily?.weather_code?.[index] ?? 0;

        return {
          date,
          weatherCode,
          weatherLabel: weatherCodeToLabel(weatherCode),
          temperatureMax: data.daily?.temperature_2m_max?.[index] ?? null,
          temperatureMin: data.daily?.temperature_2m_min?.[index] ?? null,
          precipitationProbabilityMax:
            data.daily?.precipitation_probability_max?.[index] ?? null,
          precipitationSum: data.daily?.precipitation_sum?.[index] ?? null,
          windSpeedMax: data.daily?.wind_speed_10m_max?.[index] ?? null,
        };
      }) ?? [];

    const currentWeatherCode = data.current_weather?.weathercode ?? 0;
    const current = data.current_weather
      ? {
          time: data.current_weather.time,
          temperature: data.current_weather.temperature,
          weatherCode: currentWeatherCode,
          weatherLabel: weatherCodeToLabel(currentWeatherCode),
          windSpeed: data.current_weather.windspeed,
        }
      : null;

    const summaryText = formatWeatherSummary({
      current: current
        ? {
            weatherLabel: current.weatherLabel,
            temperature: current.temperature,
            windSpeed: current.windSpeed,
          }
        : null,
      daily,
    });

    return NextResponse.json({
      location: {
        latitude: data.latitude,
        longitude: data.longitude,
      },
      summaryText,
      current,
      todayHourly,
      daily,
    });
  } catch (e: unknown) {
    console.error("weather api error:", e);

    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "現在地情報APIでエラーが発生しました",
      },
      { status: 500 },
    );
  }
}
