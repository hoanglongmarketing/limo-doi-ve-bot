import { fold, normalize } from "./text.js";

export type Origin = "HAI_PHONG" | "HA_NOI";

export const ORIGIN_LABEL: Record<Origin, string> = {
  HAI_PHONG: "Hải Phòng",
  HA_NOI: "Hà Nội",
};

/** Điểm đón (đã bỏ dấu) -> mã điểm trên hệ thống Hoàng Long. Các tên cùng một điểm là tương đương. Thêm tên mới ở đây. */
export const PLACE_STATIONS: Record<string, number> = {
  // Hải Phòng = HP
  hp: 30,
  "hai phong": 30,
  haiphong: 30,
  "h phong": 30,
  hphong: 30,
  // Hà Nội = HN (68 Trần Nhật Duật)
  hn: 10,
  "ha noi": 10,
  hanoi: 10,
  "h noi": 10,
  hnoi: 10,
  tnd: 10,
  "68 tnd": 10,
  "tran nhat duat": 10,
  "68 tran nhat duat": 10,
  // Hà Đông = HĐ = TP / Trần Phú
  hd: 14,
  "ha dong": 14,
  hadong: 14,
  "h dong": 14,
  hdong: 14,
  tp: 14,
  "tran phu": 14,
  tranphu: 14,
};

const STATION_ORIGIN: Record<number, Origin> = { 30: "HAI_PHONG", 10: "HA_NOI", 14: "HA_NOI" };

/** Tên điểm dạng regex, khớp trên chữ đã bỏ dấu. "H.Phòng" cũng khớp như "H Phòng". */
export const PLACE_PATTERN = Object.keys(PLACE_STATIONS)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/ /g, "[\\s.]*"))
  .join("|");

/** Dấu nối giữa điểm đi và điểm đến: "-", "–", "->", "→", ">", "/", "đi", "về", hoặc chỉ dấu cách ("hp hn"). */
export const ROUTE_SEPARATOR = "\\s*(?:->|=>|-|–|—|→|>|/)\\s*|\\s+(?:di|ve|to)\\s+|\\s+";

/** Chuỗi tên điểm (đã bỏ dấu) -> mã điểm. */
export function stationOf(folded: string): number | undefined {
  const key = folded.replace(/[\s.]+/g, " ").trim();
  return PLACE_STATIONS[key] ?? PLACE_STATIONS[key.replace(/ /g, "")];
}

export function parseOrigin(text: string): Origin | undefined {
  const n = normalize(text);
  const m = n.match(new RegExp(`^(?:tu\\s+)?(${PLACE_PATTERN})\\b`));
  const station = m ? stationOf(m[1]) : undefined;
  return station === undefined ? undefined : STATION_ORIGIN[station];
}

export interface Route {
  /** Viết như trong tin, vd "HĐ-HP". */
  text: string;
  origin: Origin;
}

/** Tìm tuyến dạng "HĐ-HP", "HN - HP", "Hải Phòng → Hà Nội". */
export function findRoute(text: string): Route | undefined {
  const original = text.normalize("NFC");
  const re = new RegExp(`\\b(${PLACE_PATTERN})(?:${ROUTE_SEPARATOR})(${PLACE_PATTERN})\\b`);
  const m = fold(original).match(re);
  if (!m || m.index === undefined) return undefined;
  return { text: original.slice(m.index, m.index + m[0].length), origin: STATION_ORIGIN[stationOf(m[1])!] };
}
