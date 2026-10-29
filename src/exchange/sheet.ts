import type { StoredRequest } from "./store.js";
import { formatVn } from "./time.js";
import { ORIGIN_LABEL } from "./trip.js";

/** Tên cột trong Google Sheet, theo đúng thứ tự. Đổi ở đây thì không cần sửa Apps Script. */
export const SHEET_COLUMNS = [
  "Mã YC",
  "Trạng thái",
  "Mã vé",
  "Số vé",
  "Điểm đi",
  "Chuyến cũ",
  "Tuyến cũ",
  "Ghế cũ",
  "Chuyến mới",
  "Tuyến mới",
  "Ghế mới",
  "Lý do",
  "Tên khách",
  "SĐT khách",
  "Quá hạn",
  "Người gửi",
  "Giờ gửi",
  "Người duyệt",
  "Giờ duyệt",
  "Ghi chú duyệt",
  "Nhóm Zalo",
] as const;

const STATUS_TEXT: Record<StoredRequest["status"], string> = {
  NHAP: "Chờ người gửi xác nhận",
  CHO_DUYET: "Chờ duyệt",
  DA_DUYET: "Đã duyệt",
  TU_CHOI: "Từ chối",
};

export function toSheetRow(item: StoredRequest): string[] {
  const r = item.request;
  return [
    item.id,
    STATUS_TEXT[item.status],
    r.ticketCodes.join(", "),
    String(r.ticketCodes.length),
    ORIGIN_LABEL[r.origin],
    formatVn(r.oldDeparture),
    r.oldRoute ?? "",
    r.oldSeat ?? "",
    formatVn(r.newDeparture),
    r.newRoute ?? "",
    r.newSeat ?? "",
    r.reason ?? "",
    r.customerName ?? "",
    r.customerPhone ?? "",
    item.overdue ? "Có" : "",
    item.requestedBy.name,
    formatVn(item.requestedAt),
    item.decidedBy ?? "",
    item.decidedAt ? formatVn(item.decidedAt) : "",
    item.decisionNote ?? "",
    item.chatId ?? "",
  ];
}

/**
 * Ghi yêu cầu sang Google Sheet qua Web App Apps Script (scripts/google-sheet.gs).
 * Mỗi yêu cầu là một dòng, tìm theo "Mã YC": có rồi thì cập nhật, chưa có thì thêm mới.
 * Gửi lần lượt để các lần cập nhật cùng một yêu cầu không bị đảo thứ tự.
 */
export class SheetSync {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly secret: string,
  ) {}

  push(item: StoredRequest): void {
    const body = JSON.stringify({ secret: this.secret, columns: SHEET_COLUMNS, row: toSheetRow(item) });
    this.queue = this.queue.then(() => this.send(item.id, body));
  }

  /** Chờ các lần ghi đang xếp hàng (dùng khi tắt bot hoặc trong test). */
  flush(): Promise<void> {
    return this.queue;
  }

  private async send(id: string, body: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Apps Script trả 302 sang googleusercontent; fetch tự theo redirect.
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (data.ok) return;
        throw new Error(data.error ?? `HTTP ${res.status}`);
      } catch (err) {
        if (attempt === 3) {
          console.error(`Không ghi được ${id} sang Google Sheet:`, err);
          return;
        }
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
}
