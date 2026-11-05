// Gọi API đổi chuyến của Hoàng Long (tài liệu: "Hoàng Long API đổi chuyến cho vé").
// Mọi hàm đều POST JSON, kèm username + key do Hoàng Long cấp.

export interface ShiftInfo {
  FreeSeat: number;
  IsExtra: boolean;
  ShiftID: number;
  ShiftName: string;
}

export interface ShiftResult {
  Status: boolean;
  Message: string;
  ShiftInfo: ShiftInfo[];
}

export interface UserResult {
  Status: boolean;
  Message: string;
  Exists: boolean;
  FullName: string | null;
  IsBlocked: boolean;
}

export interface TicketInfo {
  ChangeTicketNote: string;
  /** dd-MM-yyyy */
  Date: string;
  OrderNumber: string;
  RouterName: string;
  Seat: number;
  StartTime: string;
  TicketType: string;
}

export interface TicketResult {
  Status: boolean;
  Message: string;
  FreeSeats: number[] | null;
  StartTime: string | null;
  Surcharge: number;
  TicketInfo: TicketInfo | null;
}

export interface ChangeInput {
  orderNumber: string;
  date: Date;
  shiftId: number;
  seat: number;
  surcharge: number;
  userSurcharge: string;
  note: string;
  requestCode: string;
}

/** Bốn hàm bot cần. Test dùng bản giả cùng giao diện này. */
export interface HoangLongApi {
  getShifts(date: Date, routerId: number, startTime: string): Promise<ShiftResult>;
  getUser(user: string): Promise<UserResult>;
  checkTicket(orderNumber: string, date: Date, shiftId: number, seat?: number): Promise<TicketResult>;
  changeTicket(input: ChangeInput): Promise<TicketResult>;
}

export class HoangLongApiError extends Error {}

/** Ngày theo giờ Việt Nam, dạng dd-MM-yyyy như API trả về. */
export function apiDate(d: Date): string {
  const vn = new Date(d.getTime() + 7 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(vn.getUTCDate())}-${pad(vn.getUTCMonth() + 1)}-${vn.getUTCFullYear()}`;
}

export class HttpHoangLongApi implements HoangLongApi {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly key: string,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.username, key: this.key, ...body }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new HoangLongApiError(`Không kết nối được API Hoàng Long (${method}): ${String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new HoangLongApiError(`API Hoàng Long ${method} lỗi HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HoangLongApiError(`API Hoàng Long ${method} trả về không phải JSON: ${text.slice(0, 200)}`);
    }
  }

  getShifts(date: Date, routerId: number, startTime: string): Promise<ShiftResult> {
    return this.call("GetLimoShiftInfo", { date: apiDate(date), routerId, startTime });
  }

  getUser(user: string): Promise<UserResult> {
    return this.call("GetUserInfo", { user });
  }

  checkTicket(orderNumber: string, date: Date, shiftId: number, seat?: number): Promise<TicketResult> {
    return this.call("CheckLimoChangeTicket", { ordernumber: orderNumber, date: apiDate(date), shiftId, seat: seat ?? 0 });
  }

  changeTicket(i: ChangeInput): Promise<TicketResult> {
    return this.call("LimoChangeTicket", {
      ordernumber: i.orderNumber,
      date: apiDate(i.date),
      shiftId: i.shiftId,
      seat: i.seat,
      surcharge: i.surcharge,
      userSurcharge: i.userSurcharge,
      note: i.note,
      requestCode: i.requestCode,
    });
  }
}

/** Đủ HL_API_USERNAME và HL_API_KEY thì bật API; thiếu thì bot chạy như bản test (chưa đổi vé thật). */
export function loadHoangLongApi(env: Record<string, string | undefined>): HoangLongApi | undefined {
  const username = env.HL_API_USERNAME?.trim();
  const key = env.HL_API_KEY?.trim();
  if (!username || !key) return undefined;
  const url = env.HL_API_URL?.trim() || "http://apitesthoanglong.csell.vn:8686/HLService.svc/rest";
  return new HttpHoangLongApi(url, username, key);
}
