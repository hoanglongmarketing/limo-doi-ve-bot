import { normalize } from "./text.js";
import { formatVn, parseVnDateTime } from "./time.js";
import { findRoute, ORIGIN_LABEL, parseOrigin, type Origin } from "./trip.js";

/** Mẫu tin nhân viên gửi vào nhóm. Sửa mẫu ở đây thì sửa luôn FIELDS bên dưới. */
export const REQUEST_TEMPLATE = [
  "ĐỔI VÉ",
  "Mã vé: (nhiều mã cách nhau dấu phẩy)",
  "Tên khách: ",
  "SĐT khách: ",
  "Điểm đi: Hải Phòng / Hà Nội",
  "Chuyến cũ: giờ ngày tuyến (vd 16:45 30/10 HĐ-HP)",
  "Ghế cũ: ",
  "Chuyến mới: giờ ngày tuyến (vd 18:00 30/10 HN-HP)",
  "Ghế mới: (nếu đã chọn)",
  "Lý do: ",
].join("\n");

export interface ExchangeRequest {
  ticketCodes: string[];
  customerName?: string;
  customerPhone?: string;
  origin: Origin;
  oldDeparture: Date;
  oldRoute?: string;
  oldSeat?: string;
  newDeparture: Date;
  newRoute?: string;
  newSeat?: string;
  reason?: string;
  /** Các ghi chú bot tự suy ra (vd tự điền ngày), để người gửi kiểm tra khi xác nhận. */
  assumptions: string[];
}

export type FieldKey =
  | "ticketCodes"
  | "customerName"
  | "customerPhone"
  | "origin"
  | "oldDeparture"
  | "oldSeat"
  | "newDeparture"
  | "newSeat"
  | "reason";

export type RawFields = Partial<Record<FieldKey, string>>;

/** Các cách ghi nhãn được chấp nhận (đã bỏ dấu, chữ thường). */
const FIELDS: Record<FieldKey, string[]> = {
  ticketCodes: ["ma ve", "ma dat cho", "ma"],
  customerName: ["ten khach", "khach hang", "ten"],
  customerPhone: ["sdt khach", "sdt", "so dien thoai", "dien thoai"],
  origin: ["diem di", "chieu di", "di tu"],
  oldDeparture: ["chuyen cu", "gio cu", "chuyen hien tai"],
  oldSeat: ["ghe cu", "so ghe cu"],
  newDeparture: ["chuyen moi", "gio moi", "chuyen muon doi", "doi sang"],
  newSeat: ["ghe moi", "so ghe moi"],
  reason: ["ly do", "ghi chu"],
};

export const FIELD_LABELS: Record<FieldKey, string> = {
  ticketCodes: "Mã vé",
  customerName: "Tên khách",
  customerPhone: "SĐT khách",
  origin: "Điểm đi",
  oldDeparture: "Chuyến cũ",
  oldSeat: "Ghế cũ",
  newDeparture: "Chuyến mới",
  newSeat: "Ghế mới",
  reason: "Lý do",
};

/** Tin có phải mẫu đổi vé không: bắt đầu bằng "đổi vé" hoặc có dòng "Mã vé:". */
export function looksLikeTemplate(content: string): boolean {
  const lines = content.split(/\r?\n/).map(normalize);
  return lines[0] === "doi ve" || lines.some((line) => /^ma ve\s*:/.test(line));
}

function readFields(content: string): RawFields {
  const values: RawFields = {};
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

export function splitTicketCodes(text: string): string[] {
  return [...new Set(text.split(/[\s,;/]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export type ParseResult = { ok: true; request: ExchangeRequest } | { ok: false; errors: string[] };

/** Kiểm tra và dựng yêu cầu từ các trường đã đọc (dùng chung cho mẫu và tin tự do). */
export function buildRequest(f: RawFields, now: Date = new Date()): ParseResult {
  const errors: string[] = [];
  const assumptions: string[] = [];

  const ticketCodes = f.ticketCodes ? splitTicketCodes(f.ticketCodes) : [];
  if (ticketCodes.length === 0) errors.push(`Thiếu "${FIELD_LABELS.ticketCodes}"`);

  const oldRoute = f.oldDeparture ? findRoute(f.oldDeparture) : undefined;
  const newRoute = f.newDeparture ? findRoute(f.newDeparture) : undefined;

  // Điểm đi: ghi rõ thì dùng, không thì lấy theo tuyến của chuyến cũ.
  let origin = f.origin ? parseOrigin(f.origin) : undefined;
  if (f.origin && !origin) errors.push(`"${FIELD_LABELS.origin}" chỉ nhận Hải Phòng hoặc Hà Nội, đang ghi: ${f.origin}`);
  if (!f.origin) {
    origin = oldRoute?.origin;
    if (!origin) errors.push(`Thiếu "${FIELD_LABELS.origin}" (Hải Phòng hoặc Hà Nội, hoặc ghi tuyến ở chuyến cũ như HĐ-HP)`);
  }

  const oldParsed = f.oldDeparture ? parseVnDateTime(f.oldDeparture, now) : undefined;
  if (!f.oldDeparture) errors.push(`Thiếu "${FIELD_LABELS.oldDeparture}"`);
  else if (!oldParsed) errors.push(`Không đọc được giờ ở "${FIELD_LABELS.oldDeparture}": ${f.oldDeparture}`);

  const newParsed = f.newDeparture ? parseVnDateTime(f.newDeparture, now, { futureOnly: true }) : undefined;
  if (!f.newDeparture) errors.push(`Thiếu "${FIELD_LABELS.newDeparture}"`);
  else if (!newParsed) errors.push(`Không đọc được giờ ở "${FIELD_LABELS.newDeparture}": ${f.newDeparture}`);
  else if (newParsed.date.getTime() <= now.getTime()) errors.push(`"${FIELD_LABELS.newDeparture}" đã qua giờ, cần chọn chuyến sau thời điểm hiện tại`);

  if (errors.length > 0 || !origin || !oldParsed || !newParsed) return { ok: false, errors };

  if (oldParsed.dateAssumed) assumptions.push(`Chuyến cũ không ghi ngày, bot hiểu là ${formatVn(oldParsed.date).slice(6)}`);
  if (newParsed.dateAssumed) assumptions.push(`Chuyến mới không ghi ngày, bot hiểu là ${formatVn(newParsed.date).slice(6)}`);
  if (!f.origin) assumptions.push(`Điểm đi lấy theo tuyến ${oldRoute!.text}: ${ORIGIN_LABEL[origin]}`);

  return {
    ok: true,
    request: {
      ticketCodes,
      customerName: f.customerName,
      customerPhone: f.customerPhone,
      origin,
      oldDeparture: oldParsed.date,
      oldRoute: oldRoute?.text,
      oldSeat: f.oldSeat,
      newDeparture: newParsed.date,
      newRoute: newRoute?.text,
      newSeat: f.newSeat,
      reason: f.reason,
      assumptions,
    },
  };
}

export function parseExchangeRequest(content: string, now: Date = new Date()): ParseResult {
  return buildRequest(readFields(content), now);
}

/** In yêu cầu theo đúng mẫu, để người gửi sao chép, sửa và gửi lại được. */
export function renderForm(r: ExchangeRequest): string {
  const trip = (d: Date, route?: string) => `${formatVn(d)}${route ? ` ${route}` : ""}`;
  return [
    "ĐỔI VÉ",
    `${FIELD_LABELS.ticketCodes}: ${r.ticketCodes.join(", ")}`,
    r.customerName && `${FIELD_LABELS.customerName}: ${r.customerName}`,
    r.customerPhone && `${FIELD_LABELS.customerPhone}: ${r.customerPhone}`,
    `${FIELD_LABELS.origin}: ${ORIGIN_LABEL[r.origin]}`,
    `${FIELD_LABELS.oldDeparture}: ${trip(r.oldDeparture, r.oldRoute)}`,
    r.oldSeat && `${FIELD_LABELS.oldSeat}: ${r.oldSeat}`,
    `${FIELD_LABELS.newDeparture}: ${trip(r.newDeparture, r.newRoute)}`,
    r.newSeat && `${FIELD_LABELS.newSeat}: ${r.newSeat}`,
    r.reason && `${FIELD_LABELS.reason}: ${r.reason}`,
  ]
    .filter(Boolean)
    .join("\n");
}
