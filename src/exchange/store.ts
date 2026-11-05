import type { ExchangeRequest } from "./template.js";

/**
 * NHAP: bot vừa đọc tin tự do, chờ người gửi xác nhận form.
 * DA_DUYET: người duyệt đã đồng ý, bot đang/chưa đổi xong trên hệ thống.
 * DA_DOI / DOI_MOT_PHAN / LOI_DOI: kết quả đổi vé qua API (đổi hết / một phần / không vé nào).
 */
export type RequestStatus = "NHAP" | "CHO_DUYET" | "DA_DUYET" | "TU_CHOI" | "DA_DOI" | "DOI_MOT_PHAN" | "LOI_DOI";

/** Kết quả kiểm tra và đổi một vé qua API Hoàng Long. */
export interface TicketState {
  code: string;
  /** API cho phép đổi. */
  allowed: boolean;
  message: string;
  ticketType?: string;
  /** Chuyến cũ theo hệ thống, vd "16:00 29-09-2026 68 TND - Hải Phòng LIMO". */
  systemTrip?: string;
  oldSeat?: number;
  changeNote?: string;
  /** Ghế mới (số trên hệ thống, 5A = 10, 6A = 11). */
  seat?: number;
  surcharge: number;
  /** DONE: đã đổi; FAILED: đổi lỗi; UNKNOWN: mất kết nối khi đổi, chưa rõ. */
  result?: "DONE" | "FAILED" | "UNKNOWN";
  resultMessage?: string;
}

export interface ShiftState {
  id: number;
  name: string;
  freeSeat: number;
  isExtra: boolean;
}

export interface ApiState {
  shift?: ShiftState;
  /** API trả nhiều chuyến cùng giờ: chờ người gửi chọn. */
  shiftChoices?: ShiftState[];
  tickets: TicketState[];
  /** Họ tên chủ tài khoản phụ thu (API GetUserInfo). */
  accountName?: string;
  accountError?: string;
  /** Lỗi khi gọi API lúc kiểm tra (bot sẽ kiểm tra lại khi duyệt). */
  error?: string;
  /** Người duyệt chọn thu phụ thu hay không. */
  collect?: boolean;
  /** Tài khoản phụ thu người duyệt ghi khi đồng ý (ưu tiên hơn form). */
  account?: string;
}

export interface StoredRequest {
  id: string;
  request: ExchangeRequest;
  requestedBy: { id: string; name: string };
  requestedAt: Date;
  /** Nhóm Zalo nơi gửi yêu cầu. */
  chatId?: string;
  overdue: boolean;
  status: RequestStatus;
  decidedBy?: string;
  decidedAt?: Date;
  decisionNote?: string;
  /** Có khi bot nối API Hoàng Long. */
  api?: ApiState;
}

export interface StoreSnapshot {
  seq: number;
  items: StoredRequest[];
}

const DATE_KEYS = new Set(["requestedAt", "decidedAt", "oldDeparture", "newDeparture"]);

/** Đọc lại JSON đã lưu, chuyển chuỗi ngày giờ thành Date. */
export function parseStored<T = StoreSnapshot>(json: string): T {
  return JSON.parse(json, (key, value) =>
    DATE_KEYS.has(key) && typeof value === "string" ? new Date(value) : value,
  ) as T;
}

/**
 * Lưu yêu cầu đổi vé trong bộ nhớ. `persist` được gọi sau mỗi thay đổi để ghi
 * ra nơi lưu lâu dài (file khi chạy Node, Durable Object khi chạy Cloudflare).
 */
export class RequestStore {
  private seq = 0;
  private readonly items = new Map<string, StoredRequest>();
  private readonly listeners: ((item: StoredRequest) => void)[] = [];

  constructor(
    snapshot?: StoreSnapshot,
    private readonly persist?: (store: RequestStore, changed: StoredRequest) => void,
  ) {
    if (!snapshot) return;
    this.seq = snapshot.seq;
    for (const item of snapshot.items) this.items.set(item.id, item);
  }

  add(item: Omit<StoredRequest, "id">): StoredRequest {
    const id = `YC${String(++this.seq).padStart(3, "0")}`;
    const stored = { ...item, id };
    this.items.set(id, stored);
    this.save(stored);
    return stored;
  }

  get(id: string): StoredRequest | undefined {
    return this.items.get(id.toUpperCase());
  }

  /** Bản nháp mới nhất của một người gửi. */
  latestDraftBy(userId: string): StoredRequest | undefined {
    return [...this.items.values()].reverse().find((i) => i.status === "NHAP" && i.requestedBy.id === userId);
  }

  /** Yêu cầu đang chờ người gửi chọn chuyến. */
  latestShiftChoiceBy(userId: string): StoredRequest | undefined {
    return [...this.items.values()].reverse().find((i) => i.api?.shiftChoices && i.requestedBy.id === userId);
  }

  /** Các yêu cầu chưa có kết quả (nháp hoặc chờ duyệt). */
  pending(): StoredRequest[] {
    return [...this.items.values()].filter((i) => i.status === "NHAP" || i.status === "CHO_DUYET");
  }

  /** Đã duyệt nhưng còn vé chưa đổi xong (ghế vừa bị bán, mất kết nối). */
  awaitingRetry(): StoredRequest[] {
    return [...this.items.values()].filter(
      (i) => i.status === "DA_DUYET" && i.api?.tickets.some((t) => t.allowed && t.result !== "DONE" && t.result !== "FAILED"),
    );
  }

  /** Đăng ký nhận yêu cầu mỗi khi có thay đổi (vd ghi sang Google Sheet). */
  onChange(listener: (item: StoredRequest) => void): void {
    this.listeners.push(listener);
  }

  /** Gọi sau khi sửa một yêu cầu đã lấy ra từ store. */
  save(changed: StoredRequest): void {
    this.persist?.(this, changed);
    for (const listener of this.listeners) listener(changed);
  }

  get lastSeq(): number {
    return this.seq;
  }

  snapshot(): StoreSnapshot {
    return { seq: this.seq, items: [...this.items.values()] };
  }
}
