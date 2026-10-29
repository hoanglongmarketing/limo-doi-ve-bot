import { fold } from "./text.js";
import type { RawFields } from "./template.js";

/** Mã vé: 1-3 chữ cái + 5-8 chữ số, vd A711655. */
const TICKET_CODE = /\b[A-Za-z]{1,3}\d{5,8}\b/g;

/** Tin viết tự do có phải yêu cầu đổi vé không: có mã vé và có chữ "đổi". */
export function looksLikeFreeText(content: string): boolean {
  return (content.match(TICKET_CODE)?.length ?? 0) > 0 && /\bdoi\b/.test(fold(content));
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

  // Lý do: trong ngoặc, hoặc sau "lý do", "vì", "do".
  const paren = text.match(/\(([^)]+)\)/);
  const reasonMatch = paren ?? fold(text).match(/\b(?:ly do|vi|do)\b:?\s*(.+)$/);
  if (reasonMatch && reasonMatch.index !== undefined) {
    const start = reasonMatch.index + reasonMatch[0].length - reasonMatch[1].length;
    fields.reason = cleanReason(text.slice(start, start + reasonMatch[1].length)) || undefined;
  }
  const body = paren ? text.replace(paren[0], " ") : text;

  const split = fold(body).match(/\s(?:sang|qua)\s|->|→/);
  if (split?.index !== undefined) {
    const before = body.slice(0, split.index);
    const after = body.slice(split.index + split[0].length);
    fields.oldDeparture = tripPart(before, true);
    fields.newDeparture = tripPart(after, false);
    const oldSeat = fold(before).match(/\bghe\s+([a-z]?\d+[a-z]?)\b/);
    const newSeat = fold(after).match(/\bghe\s+([a-z]?\d+[a-z]?)\b/);
    if (oldSeat) fields.oldSeat = oldSeat[1].toUpperCase();
    if (newSeat) fields.newSeat = newSeat[1].toUpperCase();
  }
  return fields;
}

/** Lấy đoạn chứa giờ (và ngày, tuyến) của một chuyến. Chuyến cũ lấy giờ cuối, chuyến mới lấy giờ đầu. */
function tripPart(part: string, last: boolean): string | undefined {
  const times = [...part.matchAll(/\b\d{1,2}\s*(?::|h|g)(?:\d{2})?\b/gi)];
  if (times.length === 0) return undefined;
  const t = last ? times[times.length - 1] : times[0];
  // Lấy giờ cùng phần chữ ngay sau (ngày, tuyến) tới dấu câu gần nhất.
  const rest = part.slice(t.index! + t[0].length).split(/[,.;!?]|\s(?:ạ|a)(?=\s|$)/)[0];
  return `${t[0]}${rest}`.trim();
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
