import type { ExchangeRequest } from "./template.js";

/** NHAP: bot vừa đọc tin tự do, chờ người gửi xác nhận form. */
export type RequestStatus = "NHAP" | "CHO_DUYET" | "DA_DUYET" | "TU_CHOI";

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
