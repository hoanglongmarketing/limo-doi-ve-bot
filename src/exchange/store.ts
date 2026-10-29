import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

interface FileData {
  seq: number;
  items: StoredRequest[];
}

const DATE_KEYS = new Set(["requestedAt", "decidedAt", "oldDeparture", "newDeparture"]);

/**
 * Lưu yêu cầu đổi vé. Có `filePath` thì ghi ra file JSON sau mỗi thay đổi
 * (khởi động lại bot không mất); không có thì chỉ giữ trong bộ nhớ (dùng cho test).
 */
export class RequestStore {
  private seq = 0;
  private readonly items = new Map<string, StoredRequest>();
  private readonly listeners: ((item: StoredRequest) => void)[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"), (key, value) =>
        DATE_KEYS.has(key) && typeof value === "string" ? new Date(value) : value,
      ) as FileData;
      this.seq = data.seq;
      for (const item of data.items) this.items.set(item.id, item);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
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
    this.writeFile();
    for (const listener of this.listeners) listener(changed);
  }

  private writeFile(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const data: FileData = { seq: this.seq, items: [...this.items.values()] };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }
}
