import { HoangLongApiError, type HoangLongApi } from "../hl/api.js";
import { TICKET_CODE } from "./freetext.js";
import { fold, hasExchangeKeyword, normalize } from "./text.js";
import { formatVn } from "./time.js";

/**
 * Yêu cầu LẤY HÓA ĐƠN (tích hóa đơn cho vé, API LimoMarkTicketTax, mục 5 tài liệu API Hoàng Long).
 * Nhân viên nhắn riêng cho bot, bot tích từng mã vé trên hệ thống rồi báo kết quả,
 * kèm tin gọn vào nhóm.
 */
export const INVOICE_TEMPLATE = ["LẤY HÓA ĐƠN", "Mã vé: (nhiều mã cách nhau dấu phẩy)", "Ghi chú: "].join("\n");

/** Từ khóa hóa đơn: "lấy hóa đơn", "xuất hóa đơn", "tích hóa đơn", "hóa đơn VAT"... ("HĐ" một mình là Hà Đông, không tính). */
const INVOICE_WORD = /\bhoa don\b/;

/** Dòng tiêu đề mẫu: "LẤY HÓA ĐƠN", "HÓA ĐƠN", "XUẤT HÓA ĐƠN", "TÍCH HÓA ĐƠN". */
function isInvoiceHeading(line: string): boolean {
  return /^(yeu cau )?((lay|xuat|tich|danh dau) )?hoa don( vat)?$/.test(normalize(line));
}

/** Tin có phải yêu cầu lấy hóa đơn không: mẫu "LẤY HÓA ĐƠN", hoặc tin có mã vé + "hóa đơn" mà không có từ đổi vé. */
export function looksLikeInvoice(content: string): boolean {
  const first = content.split(/\r?\n/)[0] ?? "";
  if (isInvoiceHeading(first)) return true;
  const hasCode = (content.match(TICKET_CODE)?.length ?? 0) > 0;
  return hasCode && INVOICE_WORD.test(normalize(content)) && !hasExchangeKeyword(content);
}

export interface InvoiceRequest {
  ticketCodes: string[];
  note?: string;
}

/** Đọc mã vé và ghi chú (dòng "Ghi chú:" hoặc phần trong ngoặc). */
export function readInvoice(content: string): InvoiceRequest {
  const text = content.normalize("NFC");
  const ticketCodes = [...new Set((text.match(TICKET_CODE) ?? []).map((c) => c.toUpperCase()))];
  let note: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0 && /^(ghi chu|ly do|note)$/.test(normalize(line.slice(0, idx)))) note = line.slice(idx + 1).trim() || undefined;
  }
  if (!note) note = text.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
  return { ticketCodes, note };
}

export interface InvoiceResult {
  code: string;
  ok: boolean;
  message: string;
}

/** Tích hóa đơn từng mã vé. Vé lỗi ghi lý do, vé khác vẫn tích. */
export async function markInvoices(codes: string[], api: HoangLongApi): Promise<InvoiceResult[]> {
  const results: InvoiceResult[] = [];
  for (const code of codes) {
    try {
      const res = await api.markTicketTax(code);
      results.push({ code, ok: res.Status, message: res.Message });
    } catch (err) {
      const message = err instanceof HoangLongApiError ? err.message : String(err);
      results.push({ code, ok: false, message: `${message}. Chưa rõ đã tích chưa, gửi lại để bot thử lại.` });
    }
  }
  return results;
}

const SEPARATOR = "______________________";

const resultLine = (r: InvoiceResult) => (r.ok ? `✅ ${r.code}: đã tích hóa đơn` : `❌ ${r.code}: ${r.message}`);

/** Tin soạn để người gửi kiểm tra trước khi tích. */
export function invoiceDraftReply(req: InvoiceRequest, name: string): string {
  return [
    `🧾 Em đã soạn yêu cầu LẤY HÓA ĐƠN (${req.ticketCodes.length} vé):`,
    SEPARATOR,
    `🎫 Mã vé: ${req.ticketCodes.join(", ")}`,
    req.note ? `📝 Ghi chú: ${req.note}` : undefined,
    SEPARATOR,
    `👉 ${name} kiểm tra giúp em: đúng thì trả lời Xác nhận để bot tích hóa đơn. Sai thì gửi lại yêu cầu mới.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Trả lời người gửi. */
export function invoiceReply(req: InvoiceRequest, results: InvoiceResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  return [
    `🧾 Kết quả LẤY HÓA ĐƠN (${req.ticketCodes.length} vé):`,
    SEPARATOR,
    ...results.map(resultLine),
    req.note ? `📝 Ghi chú: ${req.note}` : undefined,
    SEPARATOR,
    ok === results.length ? "👉 Đã tích hóa đơn tất cả vé." : `👉 Tích được ${ok}/${results.length} vé. Vé lỗi kiểm tra lại thông tin công ty rồi gửi lại.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Tin gọn báo vào nhóm và nhóm báo cáo (nhóm chỉ để thông báo). */
export function invoiceNotice(req: InvoiceRequest, results: InvoiceResult[], by: string, at: Date, fromPrivate: boolean): string {
  return [
    `🧾 Y/c LẤY HÓA ĐƠN`,
    `từ ${by} (${fromPrivate ? "ib" : "nhóm"} lúc ${formatVn(at).replace(/\//g, "-")}):`,
    SEPARATOR,
    ...results.map(resultLine),
    req.note ? `📝 Ghi chú: ${req.note}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Lệnh lấy mẫu: "mẫu hóa đơn", "mẫu lấy hóa đơn" ("hđ" là Hà Đông nên không nhận viết tắt). */
export function isInvoiceTemplateCommand(n: string): boolean {
  return /^\/?mau (lay |xuat |tich )?hoa don$/.test(fold(n).trim());
}
