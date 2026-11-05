import { fold } from "./text.js";

/** Mã điểm trên hệ thống Hoàng Long. */
const STATIONS: Record<string, number> = {
  hn: 10,
  "ha noi": 10,
  tnd: 10, // 68 Trần Nhật Duật
  hd: 14,
  "ha dong": 14,
  hp: 30,
  "hai phong": 30,
};

/** Mã tuyến theo cặp [điểm đi, điểm đến]. */
const ROUTES: Record<string, number> = {
  "10-30": 11, // 68 TND - Hải Phòng
  "30-10": 12, // Hải Phòng - 68 TND
  "30-14": 13, // Hải Phòng - Hà Đông
  "14-30": 14, // Hà Đông - Hải Phòng
};

const STATION_PATTERN = Object.keys(STATIONS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** "HĐ-HP" -> 14. Không có tuyến thì undefined. */
export function routeIdOf(routeText: string | undefined): number | undefined {
  if (!routeText) return undefined;
  const m = fold(routeText).match(new RegExp(`\\b(${STATION_PATTERN})\\s*(?:->|-|–|→)\\s*(${STATION_PATTERN})\\b`));
  if (!m) return undefined;
  return ROUTES[`${STATIONS[m[1]]}-${STATIONS[m[2]]}`];
}

/** Ghế 5A, 6A là ghế 10, 11 trên hệ thống. */
const SEAT_ALIASES: Record<string, number> = { "5a": 10, "6a": 11 };

/** "5A" -> 10, "3" -> 3. Ghế không có trên xe thì undefined. */
export function seatNumber(label: string | undefined): number | undefined {
  if (!label) return undefined;
  const s = label.trim().toLowerCase().replace(/^ghe\s*/, "");
  if (s in SEAT_ALIASES) return SEAT_ALIASES[s];
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 11 ? n : undefined;
}

/** 10 -> "5A", 3 -> "3". */
export function seatLabel(n: number): string {
  return n === 10 ? "5A" : n === 11 ? "6A" : String(n);
}

const VIP_SEATS = new Set([3, 4, 5, 6, 10, 11]);

export function isVip(seat: number): boolean {
  return VIP_SEATS.has(seat);
}

/** Tách "5A, 6A" hoặc "3 4" thành danh sách ghế. */
export function splitSeats(text: string | undefined): string[] {
  return (text ?? "").split(/[\s,;/]+/).filter(Boolean);
}
