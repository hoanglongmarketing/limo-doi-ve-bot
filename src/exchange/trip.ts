import { fold, normalize } from "./text.js";

export type Origin = "HAI_PHONG" | "HA_NOI";

export const ORIGIN_LABEL: Record<Origin, string> = {
  HAI_PHONG: "Hải Phòng",
  HA_NOI: "Hà Nội",
};

/** Mã điểm đón (đã bỏ dấu) -> phía Hải Phòng / Hà Nội. Thêm mã mới ở đây. */
const PLACE_CODES: Record<string, Origin> = {
  hp: "HAI_PHONG",
  "hai phong": "HAI_PHONG",
  hn: "HA_NOI",
  "ha noi": "HA_NOI",
  hd: "HA_NOI", // Hà Đông
  "ha dong": "HA_NOI",
};

const PLACE_PATTERN = Object.keys(PLACE_CODES)
  .sort((a, b) => b.length - a.length)
  .join("|");

export function parseOrigin(text: string): Origin | undefined {
  const n = normalize(text);
  const m = n.match(new RegExp(`^(${PLACE_PATTERN})\\b`));
  return m ? PLACE_CODES[m[1]] : undefined;
}

export interface Route {
  /** Viết như trong tin, vd "HĐ-HP". */
  text: string;
  origin: Origin;
}

/** Tìm tuyến dạng "HĐ-HP", "HN - HP", "Hải Phòng → Hà Nội". */
export function findRoute(text: string): Route | undefined {
  const original = text.normalize("NFC");
  const re = new RegExp(`\\b(${PLACE_PATTERN})\\s*(?:->|-|–|→)\\s*(${PLACE_PATTERN})\\b`);
  const m = fold(original).match(re);
  if (!m || m.index === undefined) return undefined;
  return { text: original.slice(m.index, m.index + m[0].length), origin: PLACE_CODES[m[1]] };
}
