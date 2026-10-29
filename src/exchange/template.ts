import { normalize } from "./text.js";
import { parseVnDateTime } from "./time.js";

/** Mẫu tin nhân viên gửi vào nhóm. Sửa mẫu ở đây thì sửa luôn FIELDS bên dưới. */
export const REQUEST_TEMPLATE = [
  "ĐỔI VÉ",
  "Mã vé: ",
  "Tên khách: ",
  "SĐT khách: ",
  "Điểm đi: Hải Phòng / Hà Nội",
  "Chuyến cũ: giờ ngày (vd 08:00 30/10)",
  "Ghế cũ: ",
  "Chuyến mới: giờ ngày (vd 14:00 30/10)",
  "Ghế mới: (nếu đã chọn)",
  "Lý do: ",
].join("\n");

export interface ExchangeRequest {
  ticketCode: string;
  customerName?: string;
  customerPhone?: string;
  origin: "HAI_PHONG" | "HA_NOI";
  oldDeparture: Date;
  oldSeat?: string;
  newDeparture: Date;
  newSeat?: string;
  reason?: string;
}

type FieldKey =
  | "ticketCode"
  | "customerName"
  | "customerPhone"
  | "origin"
  | "oldDeparture"
  | "oldSeat"
  | "newDeparture"
  | "newSeat"
  | "reason";

/** Các cách ghi nhãn được chấp nhận (đã bỏ dấu, chữ thường). */
const FIELDS: Record<FieldKey, string[]> = {
  ticketCode: ["ma ve", "ma dat cho", "ma"],
  customerName: ["ten khach", "khach hang", "ten"],
  customerPhone: ["sdt khach", "sdt", "so dien thoai", "dien thoai"],
  origin: ["diem di", "chieu di", "di tu", "tuyen"],
  oldDeparture: ["chuyen cu", "gio cu", "chuyen hien tai"],
  oldSeat: ["ghe cu", "so ghe cu"],
  newDeparture: ["chuyen moi", "gio moi", "chuyen muon doi", "doi sang"],
  newSeat: ["ghe moi", "so ghe moi"],
  reason: ["ly do", "ghi chu"],
};

const FIELD_LABELS: Record<FieldKey, string> = {
  ticketCode: "Mã vé",
  customerName: "Tên khách",
  customerPhone: "SĐT khách",
  origin: "Điểm đi",
  oldDeparture: "Chuyến cũ",
  oldSeat: "Ghế cũ",
  newDeparture: "Chuyến mới",
  newSeat: "Ghế mới",
  reason: "Lý do",
};

/** Tin có phải yêu cầu đổi vé không: bắt đầu bằng "đổi vé" hoặc có dòng "Mã vé:". */
export function looksLikeExchangeRequest(content: string): boolean {
  if (normalize(content).startsWith("doi ve")) return true;
  return content.split(/\r?\n/).some((line) => /^ma ve\s*:/.test(normalize(line)));
}

function readFields(content: string): Partial<Record<FieldKey, string>> {
  const values: Partial<Record<FieldKey, string>> = {};
  for (const line of content.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const label = normalize(line.slice(0, idx)).replace(/^[-*•\d.\s]+/, "");
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    const key = (Object.keys(FIELDS) as FieldKey[]).find((k) => FIELDS[k].includes(label));
    if (key && values[key] === undefined) values[key] = value;
  }
  return values;
}

export function parseOrigin(text: string): ExchangeRequest["origin"] | undefined {
  const n = normalize(text);
  if (/^(hai phong|hp)\b/.test(n)) return "HAI_PHONG";
  if (/^(ha noi|hn)\b/.test(n)) return "HA_NOI";
  return undefined;
}

export type ParseResult = { ok: true; request: ExchangeRequest } | { ok: false; errors: string[] };

export function parseExchangeRequest(content: string, now: Date = new Date()): ParseResult {
  const f = readFields(content);
  const errors: string[] = [];

  if (!f.ticketCode) errors.push(`Thiếu "${FIELD_LABELS.ticketCode}"`);

  const origin = f.origin ? parseOrigin(f.origin) : undefined;
  if (!f.origin) errors.push(`Thiếu "${FIELD_LABELS.origin}" (Hải Phòng hoặc Hà Nội)`);
  else if (!origin) errors.push(`"${FIELD_LABELS.origin}" chỉ nhận Hải Phòng hoặc Hà Nội, đang ghi: ${f.origin}`);

  const oldDeparture = f.oldDeparture ? parseVnDateTime(f.oldDeparture, now) : undefined;
  if (!f.oldDeparture) errors.push(`Thiếu "${FIELD_LABELS.oldDeparture}"`);
  else if (!oldDeparture) errors.push(`Không đọc được giờ ngày ở "${FIELD_LABELS.oldDeparture}": ${f.oldDeparture}`);

  const newDeparture = f.newDeparture ? parseVnDateTime(f.newDeparture, now) : undefined;
  if (!f.newDeparture) errors.push(`Thiếu "${FIELD_LABELS.newDeparture}"`);
  else if (!newDeparture) errors.push(`Không đọc được giờ ngày ở "${FIELD_LABELS.newDeparture}": ${f.newDeparture}`);
  else if (newDeparture.getTime() <= now.getTime()) errors.push(`"${FIELD_LABELS.newDeparture}" đã qua giờ, cần chọn chuyến sau thời điểm hiện tại`);

  if (errors.length > 0 || !origin || !oldDeparture || !newDeparture) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    request: {
      ticketCode: f.ticketCode!.toUpperCase(),
      customerName: f.customerName,
      customerPhone: f.customerPhone,
      origin,
      oldDeparture,
      oldSeat: f.oldSeat,
      newDeparture,
      newSeat: f.newSeat,
      reason: f.reason,
    },
  };
}
