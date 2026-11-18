import { fold, hasExchangeKeyword } from "./text.js";
import { findRoute } from "./trip.js";
import { findDateText } from "./time.js";
import type { RawFields } from "./template.js";

/** Mã vé: 1-3 chữ cái + 5-8 chữ số, vd A711655. */
const TICKET_CODE = /\b[A-Za-z]{1,3}\d{5,8}\b/g;

/** Tin viết tự do có phải yêu cầu đổi vé không: có mã vé và có từ khóa đổi vé ("đổi", "chuyển", "sửa"...). */
export function looksLikeFreeText(content: string): boolean {
  return (content.match(TICKET_CODE)?.length ?? 0) > 0 && hasExchangeKeyword(content);
}

/**
 * Đọc tin kiểu: "A711655 A714050, anh đổi giúp em 3 mã vé này chuyến 16h45 HĐ-HP
 * sang chuyến 18h HN-HP ạ (xe TC đón khách không về kịp)".
 * Phần trước "sang/qua/→" là chuyến cũ, phần sau là chuyến mới.
 */
export function readFreeText(content: string): RawFields {
  const text = content.normalize("NFC").replace(/\s+/g, " ").trim();
  const fields: RawFields = {};

  const codes = text.match(TICKET_CODE);
  if (codes) fields.ticketCodes = codes.join(", ");

  // Phụ thu và tài khoản phụ thu đọc trước trên cả tin (kể cả trong ngoặc, sau "vì"), rồi bỏ khỏi tin
  // để không lẫn vào lý do. Vd "phụ thu 120k cho lanhnt-dhtt", "phụ thu bởi ngannn-tn",
  // "phụ thu 100k vào tài khoản trangph-it", "phụ thu 100k, cho tk trangph-it".
  let rest = text;
  /** Tìm `re` trên chữ đã bỏ dấu, lấy nhóm 1 theo chữ gốc và bỏ cả cụm khỏi tin. */
  const take = (re: RegExp): string | undefined => {
    const m = fold(rest).match(re);
    if (m?.index === undefined) return undefined;
    const start = m.index + m[0].length - m[1].length;
    const value = rest.slice(start, start + m[1].length);
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    return value;
  };
  const NAME = "([a-z0-9._-]+)";
  // Ở xa số tiền, tên tài khoản phải trông giống tên tài khoản: có -, . hoặc _ (vd lanhnt-dhtt) hoặc có số,
  // để không nhầm "cho khách", "vào tài khoản của khách" hay mã vé.
  const LOOSE_NAME = "([a-z0-9]+[._-][a-z0-9._-]*[a-z0-9]|[a-z]+\\d[a-z0-9._-]*)";
  fields.surchargeAccount =
    take(new RegExp(`\\b(?:phu thu boi|tai khoan phu thu|tk phu thu|nguoi phu thu)\\s*:?\\s*${NAME}`)) ??
    take(new RegExp(`\\b(?:(?:vao|cho|boi|ghi vao|tinh vao)\\s+)?(?:tai khoan|tk)\\s*:?\\s*${LOOSE_NAME}(?![a-z0-9])`));
  const money = fold(rest).match(/\bphu thu\s*:?\s*(\d[\d.,]*\s*(?:k|nghin|ngan|d|vnd)?)(?![a-z0-9])/);
  if (money?.index !== undefined) {
    let end = money.index + money[0].length;
    fields.proposedSurcharge = rest.slice(end - money[1].length, end);
    // Ngay sau số tiền: "bởi X", "cho X", "vào X" (X là tên tài khoản).
    // Có chữ "tài khoản"/"tk" thì nhận mọi tên, vd "phụ thu 100k vào tài khoản ngocanh".
    const by = fold(rest.slice(end)).match(
      /^\s*,?\s*(?:(?:boi|cho|vao)?\s*(?:tai khoan|tk)\s*:?\s*([a-z0-9._-]+)|(?:boi|cho|vao)\s*:?\s*([a-z0-9]+[._-][a-z0-9._-]*|[a-z]+\d[a-z0-9._-]*))/,
    );
    if (by && !fields.surchargeAccount) {
      const name = by[1] ?? by[2];
      const start = end + by[0].length - name.length;
      fields.surchargeAccount = rest.slice(start, start + name.length);
      end += by[0].length;
    }
    rest = rest.slice(0, money.index) + " " + rest.slice(end);
  }
  // Còn lại: "cho lanhnt-dhtt", "vào trangph-it" ở bất kỳ đâu trong tin có phụ thu.
  if (!fields.surchargeAccount && fields.proposedSurcharge) {
    fields.surchargeAccount = take(new RegExp(`\\b(?:cho|vao)\\s+${LOOSE_NAME}(?![a-z0-9])`));
  }
  if (!fields.surchargeAccount) delete fields.surchargeAccount;
  rest = rest.replace(/\s+/g, " ");

  // Lý do: trong ngoặc, hoặc sau "lý do", "vì", "do".
  const paren = rest.match(/\(([^)]+)\)/);
  const reasonMatch = paren ?? fold(rest).match(/\b(?:ly do|vi|do)\b:?\s*(.+)$/);
  if (reasonMatch && reasonMatch.index !== undefined) {
    // Ngoặc: lý do ngay sau "("; còn lại: lý do ở cuối đoạn khớp.
    const start = paren ? reasonMatch.index + 1 : reasonMatch.index + reasonMatch[0].length - reasonMatch[1].length;
    // Bỏ phần @nhắc người khác ở cuối, vd "... về luôn @Đet Vit".
    const reason = rest
      .slice(start, start + reasonMatch[1].length)
      .replace(/\s@.*$/, "")
      .replace(/^[\s,;.-]+|[\s,;.-]+$/g, "");
    fields.reason = cleanReason(reason) || undefined;
  }
  const body = paren ? rest.replace(paren[0], " ") : rest;

  // "sang/qua chuyến 18h", "lên/xuống chuyến 16h" (lên chuyến sớm hơn, xuống chuyến muộn hơn).
  const split = fold(body).match(/\s(?:sang|qua)\s|\s(?:len|xuong|thanh)\s+(?=chuyen\b|xe\b|\d)|->|→/);
  if (split?.index !== undefined) {
    const before = body.slice(0, split.index);
    const after = body.slice(split.index + split[0].length);
    fields.oldDeparture = tripPart(before, true);
    fields.newDeparture = tripPart(after, false);
    const oldSeat = fold(before).match(/\bghe\s+([a-z]?\d+[a-z]?)\b/);
    const newSeat = fold(after).match(/\bghe\s+([a-z]?\d+[a-z]?)\b/);
    if (oldSeat) fields.oldSeat = oldSeat[1].toUpperCase();
    if (newSeat) fields.newSeat = newSeat[1].toUpperCase();
  } else if (countTimes(body) === 1) {
    // Chỉ ghi một chuyến (không có "sang/qua/lên..."): đó là chuyến mới, chuyến cũ bot lấy từ hệ thống.
    fields.newDeparture = tripPart(body, false);
    const seat = fold(body).match(/\bghe\s+([a-z]?\d+[a-z]?)\b/);
    if (seat) fields.newSeat = seat[1].toUpperCase();
  }
  return fields;
}

const TIME = /\b\d{1,2}\s*(?::|h|g)(?:\d{2})?\b/gi;

function countTimes(part: string): number {
  return [...part.matchAll(TIME)].length;
}

/**
 * Gom giờ, ngày và tuyến của một chuyến từ một vế câu, bất kể thứ tự
 * ("chuyến 18h HN-HP hôm nay", "ngày mai 29/10 chuyến 18h HN-HP").
 * Chuyến cũ lấy giờ cuối, chuyến mới lấy giờ đầu.
 */
function tripPart(part: string, last: boolean): string | undefined {
  const times = [...part.matchAll(TIME)];
  if (times.length === 0) return undefined;
  const time = (last ? times[times.length - 1] : times[0])[0];
  const date = findDateText(part)?.text;
  const folded = fold(part);
  const relative = ["ngay kia", "ngay mai", "hom nay"].find((w) => folded.includes(w)) ?? (/\bmai\b/.test(folded) ? "mai" : undefined);
  const route = findRoute(part)?.text;
  return [time, date, relative, route].filter(Boolean).join(" ");
}
/** Câu giao tiếp, báo cáo thêm không thuộc lý do đổi vé: "em đã gọi khách", "cảm ơn anh"... */
const SMALL_TALK = [
  /^(em|e|minh|toi|chi|c|anh|a|ben em)\s+(da|vua|cung da|se)\b/,
  /^(cam on|thank|thanks|tks)\b/,
  /^(nhe|nha|a|ah|vang|da)$/,
];
const TRAILING_PARTICLES = /(\s+(ạ|nhé|nha|nhá|ah|à|với|giúp em|giúp e))+$/i;

/** Giữ nội dung chính của lý do: bỏ vế giao tiếp và từ đệm cuối câu. */
export function cleanReason(reason: string): string {
  return reason
    .split(/\s*[,;.]\s*/)
    .map((clause) => clause.trim().replace(TRAILING_PARTICLES, "").trim())
    .filter((clause) => clause && !SMALL_TALK.some((re) => re.test(fold(clause))))
    .join(", ");
}
