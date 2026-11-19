// Các bước dùng API Hoàng Long: tìm chuyến mới, kiểm tra từng vé, chọn ghế, đổi vé.
// Trình tự theo tài liệu "Quy trình đổi vé LIMO qua API Hoàng Long".
import { apiDate, HoangLongApiError, type HoangLongApi, type TicketResult } from "../hl/api.js";
import { isVip, routeIdOf, seatLabel, seatNumber, splitSeats } from "./codes.js";
import type { ApiState, ShiftState, StoredRequest, TicketState } from "./store.js";
import { formatMoney, type ExchangeRequest } from "./template.js";
import { formatVn, sameVnDay } from "./time.js";
import { findRoute, ORIGIN_LABEL, shortRoute } from "./trip.js";

const hhmm = (d: Date) => formatVn(d).slice(0, 5);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tuyến chuyến mới; không ghi thì coi như cùng tuyến chuyến cũ. */
function newRouteId(r: ExchangeRequest): number | undefined {
  return routeIdOf(r.newRoute) ?? (r.newRoute ? undefined : routeIdOf(r.oldRoute));
}

export type PrepareResult =
  | { ok: true; state: ApiState }
  /** Lỗi do thông tin trong tin (không có chuyến, sai tuyến): không tạo yêu cầu. */
  | { ok: false; errors: string[] };

/** Bước 4–6 của quy trình: tìm chuyến mới, kiểm tra tài khoản phụ thu và từng vé. */
/** `now` có khi gửi yêu cầu: lúc đó mới chặn chuyến cũ (theo hệ thống) đã chạy từ ngày trước. */
export async function prepare(r: ExchangeRequest, api: HoangLongApi, now?: Date): Promise<PrepareResult> {
  const routeId = newRouteId(r);
  if (!routeId) {
    return {
      ok: false,
      errors: [`Không xác định được tuyến chuyến mới${r.newRoute ? ` (${r.newRoute})` : ""}. Tuyến hợp lệ: HN-HP, HP-HN, HP-HĐ, HĐ-HP`],
    };
  }
  const state: ApiState = { tickets: [] };
  try {
    const res = await api.getShifts(r.newDeparture, routeId, hhmm(r.newDeparture));
    const shifts = (res.ShiftInfo ?? []).map(
      (s): ShiftState => ({ id: s.ShiftID, name: s.ShiftName, freeSeat: s.FreeSeat, isExtra: s.IsExtra }),
    );
    if (!res.Status || shifts.length === 0) {
      return {
        ok: false,
        errors: [`Không có chuyến ${hhmm(r.newDeparture)} ngày ${apiDate(r.newDeparture)} tuyến ${r.newRoute ?? r.oldRoute} để đổi sang (${res.Message || "chuyến không tồn tại hoặc đang khoá"})`],
      };
    }
    if (shifts.length > 1) state.shiftChoices = shifts;
    else state.shift = shifts[0];
  } catch (err) {
    state.error = errorText(err);
    return { ok: true, state };
  }
  await checkAccount(r, state, api);
  if (state.shift) await checkTickets(r, state, api);
  const lateOld = now && oldTripError(r, now);
  if (lateOld) return { ok: false, errors: [lateOld] };
  return { ok: true, state };
}

/** "17:00" + "17-11-2026" (giờ Việt Nam) -> Date. */
export function systemDate(startTime: string, date: string): Date | undefined {
  const t = startTime.match(/(\d{1,2})\s*[:hg]\s*(\d{2})?/i);
  const d = date.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!t || !d) return undefined;
  return new Date(Date.UTC(+d[3], +d[2] - 1, +d[1], +t[1] - 7, +(t[2] ?? 0)));
}

/**
 * Người gửi không ghi chuyến cũ: lấy chuyến cũ từ thông tin vé hệ thống trả về (CheckLimoChangeTicket)
 * để hiện trong form xác nhận. Nhiều vé thì lấy vé đầu tiên có thông tin.
 */
function fillOldTrip(r: ExchangeRequest, state: ApiState): void {
  if (r.oldDeparture && !r.oldFromSystem) return;
  const t = state.tickets.find((x) => x.oldStart && x.oldDate);
  const date = t && systemDate(t.oldStart!, t.oldDate!);
  if (!t || !date) return;
  r.oldDeparture = date;
  r.oldRoute = t.oldRouter ? findRoute(t.oldRouter)?.text ?? t.oldRouter : undefined;
  if (r.ticketCodes.length === 1 && t.oldSeat !== undefined) r.oldSeat = seatLabel(t.oldSeat);
  r.oldFromSystem = true;
}

/** Chuyến cũ (theo hệ thống) đã chạy từ ngày trước: không đổi được. */
function oldTripError(r: ExchangeRequest, now: Date): string | undefined {
  if (!r.oldFromSystem || !r.oldDeparture) return undefined;
  if (r.oldDeparture.getTime() > now.getTime() || sameVnDay(r.oldDeparture, now)) return undefined;
  return `Chuyến cũ theo hệ thống (${formatVn(r.oldDeparture)}${r.oldRoute ? ` ${r.oldRoute}` : ""}) đã chạy từ ngày trước, không đổi được (chỉ đổi được chuyến quá giờ trong cùng ngày)`;
}

async function checkAccount(r: ExchangeRequest, state: ApiState, api: HoangLongApi): Promise<void> {
  const account = state.account ?? r.surchargeAccount;
  if (!account) return;
  try {
    const res = await api.getUser(account);
    if (res.Status && res.Exists && !res.IsBlocked) {
      state.accountName = res.FullName ?? account;
      state.accountError = undefined;
    } else {
      state.accountName = undefined;
      state.accountError = res.Message || "Tài khoản không dùng được";
    }
  } catch (err) {
    state.accountError = errorText(err);
  }
}

/** Chọn ghế trống: ưu tiên cùng hạng với ghế cũ (VIP / thường), số nhỏ trước, không trùng vé khác. */
export function pickSeat(free: number[], oldSeat: number | undefined, taken: Set<number>): number | undefined {
  const options = free.filter((s) => !taken.has(s)).sort((a, b) => a - b);
  if (oldSeat === undefined) return options[0];
  return options.find((s) => isVip(s) === isVip(oldSeat)) ?? options[0];
}

function fromResult(code: string, res: TicketResult, seat: number | undefined): TicketState {
  const info = res.TicketInfo;
  return {
    code,
    allowed: res.Status,
    message: res.Message,
    ticketType: info?.TicketType,
    systemTrip: info ? `${info.StartTime} ${info.Date} ${info.RouterName}` : undefined,
    oldStart: info?.StartTime,
    oldDate: info?.Date,
    oldRouter: info?.RouterName,
    oldSeat: info?.Seat,
    changeNote: info?.ChangeTicketNote,
    seat,
    surcharge: res.Status ? res.Surcharge ?? 0 : 0,
  };
}

/**
 * API báo "Có lỗi xảy ra: ..." và không trả thông tin vé: lỗi phía máy chủ, không phải vé bị từ chối.
 * Coi như chưa kiểm tra được để khi duyệt bot kiểm tra lại.
 */
function serverChecked(res: TicketResult): TicketResult {
  if (!res.Status && !res.TicketInfo && /^c[oó] l[oỗ]i x[aả]y ra/i.test(res.Message ?? "")) {
    throw new HoangLongApiError(`máy chủ API báo lỗi: ${res.Message.replace(/^c[oó] l[oỗ]i x[aả]y ra:\s*/i, "")}`);
  }
  return res;
}

/** Không vé nào đổi được theo hệ thống (đã kiểm tra xong, không phải do lỗi API). */
export function noneAllowed(item: StoredRequest): boolean {
  const state = item.api;
  return !!state?.shift && !state.error && state.tickets.length > 0 && !state.tickets.some((t) => t.allowed);
}

/** Kiểm tra một vé với ghế muốn đổi; chưa có ghế hoặc ghế đã bán thì bot chọn ghế khác cùng hạng. */
async function checkOne(
  r: ExchangeRequest,
  shiftId: number,
  code: string,
  wanted: number | undefined,
  taken: Set<number>,
  api: HoangLongApi,
): Promise<{ ticket: TicketState; note?: string }> {
  let res = serverChecked(await api.checkTicket(code, r.newDeparture, shiftId, wanted));
  let seat = wanted;
  let note: string | undefined;
  const free = res.FreeSeats ?? [];
  const seatTaken = wanted !== undefined && free.length > 0 && !free.includes(wanted);
  if (res.TicketInfo && free.length > 0 && (wanted === undefined || seatTaken || taken.has(wanted))) {
    const pick = pickSeat(free, res.TicketInfo.Seat, taken);
    if (pick !== undefined && pick !== wanted) {
      if (wanted !== undefined) note = `Ghế ${seatLabel(wanted)} không còn trống, bot chọn ghế ${seatLabel(pick)}`;
      seat = pick;
      res = serverChecked(await api.checkTicket(code, r.newDeparture, shiftId, pick));
    }
  }
  if (seat !== undefined) taken.add(seat);
  return { ticket: fromResult(code, res, seat), note };
}

async function checkTickets(r: ExchangeRequest, state: ApiState, api: HoangLongApi): Promise<void> {
  const wanted = splitSeats(r.newSeat).map(seatNumber);
  const taken = new Set<number>();
  state.tickets = [];
  for (const [i, code] of r.ticketCodes.entries()) {
    try {
      const { ticket, note } = await checkOne(r, state.shift!.id, code, wanted[i], taken, api);
      if (note) ticket.message = `${note}. ${ticket.message}`;
      state.tickets.push(ticket);
    } catch (err) {
      state.error = errorText(err);
      state.tickets.push({ code, allowed: false, message: `Chưa kiểm tra được: ${errorText(err)}`, surcharge: 0 });
    }
  }
  applySurchargeRule(r, state);
  fillOldTrip(r, state);
}

/**
 * Quy định phụ thu (chị Tyra chốt 09/11):
 * - Hệ thống không tính phụ thu mà người gửi ghi phụ thu: mặc định thu theo số người gửi (mỗi vé).
 * - Hệ thống có phụ thu và người gửi cũng ghi phụ thu: mặc định thu theo số lớn hơn (từng vé).
 * - Hệ thống có phụ thu mà người gửi không ghi: người duyệt xác nhận thu hay không.
 */
function applySurchargeRule(r: ExchangeRequest, state: ApiState): void {
  const proposed = r.proposedSurcharge ?? 0;
  if (proposed <= 0) return;
  const allowed = state.tickets.filter((t) => t.allowed);
  if (allowed.length === 0) return;
  for (const t of allowed) {
    t.systemSurcharge = t.surcharge;
    if (proposed > t.surcharge) {
      t.surcharge = proposed;
      t.surchargeFromUser = true;
    }
  }
  state.collect ??= true;
}

/** Người gửi chọn một chuyến khi API trả nhiều chuyến cùng giờ. */
export async function chooseShift(item: StoredRequest, index: number, api: HoangLongApi): Promise<string | undefined> {
  const choices = item.api?.shiftChoices;
  if (!choices) return `${item.id} không có chuyến nào cần chọn.`;
  const shift = choices[index - 1];
  if (!shift) return `Chỉ có ${choices.length} chuyến, chọn từ 1 đến ${choices.length}.`;
  item.api!.shift = shift;
  item.api!.shiftChoices = undefined;
  await checkAccount(item.request, item.api!, api);
  await checkTickets(item.request, item.api!, api);
  return undefined;
}

/** Kiểm tra lại khi lần trước API lỗi hoặc chưa kiểm tra. */
export async function ensureChecked(item: StoredRequest, api: HoangLongApi): Promise<string | undefined> {
  if (item.api?.shiftChoices) return `${item.id} đang chờ ${item.requestedBy.name} chọn chuyến (@bot chọn 1, 2...).`;
  if (item.api?.shift && !item.api.error) return undefined;
  const result = await prepare(item.request, api);
  if (!result.ok) return result.errors.join("\n");
  item.api = { ...result.state, collect: item.api?.collect, account: item.api?.account };
  if (item.api.error) return `Chưa kết nối được API Hoàng Long: ${item.api.error}. Thử lại sau ít phút.`;
  if (item.api.shiftChoices) return `${item.id} có nhiều chuyến cùng giờ, cần ${item.requestedBy.name} chọn trước.`;
  return undefined;
}

function shiftLine(s: ShiftState, r: ExchangeRequest): string {
  return `${s.name} ngày ${apiDate(r.newDeparture)}${s.isExtra ? " (xe tăng cường)" : ""}, còn ${s.freeSeat} ghế trống`;
}

/** Tổng phụ thu API tính cho các vé đổi được (chưa đổi xong). */
export function totalSurcharge(item: StoredRequest): number {
  return (item.api?.tickets ?? []).filter((t) => t.allowed && t.result !== "FAILED").reduce((s, t) => s + t.surcharge, 0);
}

/** Phụ thu thực thu trên các vé đã đổi. */
export function collectedSurcharge(item: StoredRequest): number {
  if (!item.api?.collect) return 0;
  return item.api.tickets.filter((t) => t.result === "DONE").reduce((s, t) => s + t.surcharge, 0);
}

export function ticketSummary(t: TicketState): string {
  const seat = t.seat !== undefined ? ` ghế ${seatLabel(t.seat)}` : "";
  if (t.result === "DONE") return `${t.code}: đã đổi${seat}`;
  if (t.result === "FAILED") return `${t.code}: lỗi (${t.resultMessage ?? t.message})`;
  if (t.result === "UNKNOWN") return `${t.code}: chưa rõ kết quả`;
  return t.allowed ? `${t.code}: đổi được${seat}` : `${t.code}: không đổi được (${t.message})`;
}

/** Các dòng kết quả kiểm tra, in dưới form. */
export function checkLines(item: StoredRequest): string[] {
  const r = item.request;
  const state = item.api;
  if (!state) return [];
  if (state.shiftChoices) {
    return [
      `🚐 Có ${state.shiftChoices.length} chuyến ${hhmm(r.newDeparture)} ngày ${apiDate(r.newDeparture)}:`,
      ...state.shiftChoices.map((s, i) => `  ${i + 1}. ${shiftLine(s, r)}`),
      `${item.requestedBy.name} chọn chuyến: @bot chọn 1${state.shiftChoices.length > 1 ? `, @bot chọn 2...` : ""}`,
    ];
  }
  if (!state.shift) return [`⏳ Chưa kiểm tra được với hệ thống (${state.error ?? "lỗi API"}). Bot sẽ kiểm tra lại khi duyệt.`];

  const lines = [`🚐 Chuyến mới: ${shiftLine(state.shift, r)}`];
  for (const t of state.tickets) {
    lines.push(ticketLine(t, r, ""));
    if (t.systemTrip && !r.oldFromSystem && !sameTrip(t, r)) lines.push(`   ⚠️ Hệ thống ghi chuyến cũ của vé này: ${t.systemTrip}`);
  }
  if (state.error) lines.push(`⏳ Có vé chưa kiểm tra được (${state.error}). Bot sẽ kiểm tra lại khi duyệt.`);
  return [...lines, ...surchargeLines(item)];
}

/** "✅ A692289 (Vé 1 chiều, ghế cũ 7) → ghế 1, không phụ thu" */
function ticketLine(t: TicketState, r: ExchangeRequest, prefix: string): string {
  const type = t.ticketType ? `${t.ticketType}, ` : "";
  const oldTrip = r.oldFromSystem && t.systemTrip && !prefix ? `chuyến cũ ${t.systemTrip}, ` : "";
  const old = `${oldTrip}${t.oldSeat !== undefined ? `ghế cũ ${seatLabel(t.oldSeat)}` : ""}`;
  if (t.allowed) {
    const fee = t.surcharge > 0 ? `, phụ thu ${formatMoney(t.surcharge)}` : ", không phụ thu";
    return `✅ ${prefix}${t.code} (${type}${old}) → ghế ${t.seat !== undefined ? seatLabel(t.seat) : "?"}${fee}`;
  }
  return `❌ ${prefix}${t.code}${t.ticketType ? ` (${t.ticketType})` : ""}: ${t.message} → để lại, không đổi`;
}

/** "13:30 19-11-2026" */
const dashTime = (d: Date) => `${hhmm(d)} ${apiDate(d)}`;

/**
 * Phần thông tin vé gọn cho tin gửi người duyệt (mẫu chị Tyra 19/11):
 * mã vé + kết quả kiểm tra, điểm đi, chuyến cũ, chuyến mới.
 */
export function compactTripLines(item: StoredRequest): string[] {
  const r = item.request;
  const state = item.api;
  const lines: string[] = [];
  const checked = !!state?.shift && state.tickets.length > 0;
  if (checked) {
    for (const t of state!.tickets) {
      const info = [t.ticketType, t.oldSeat !== undefined ? `ghế cũ ${seatLabel(t.oldSeat)}` : undefined].filter(Boolean).join(", ");
      lines.push(t.allowed ? `✅ Mã vé: ${t.code}${info ? ` (${info})` : ""}` : `❌ Mã vé: ${t.code}${t.ticketType ? ` (${t.ticketType})` : ""}: ${t.message} → để lại, không đổi`);
    }
  } else lines.push(`🎫 Mã vé: ${r.ticketCodes.join(", ")}`);
  lines.push(`🚩 Điểm đi: ${ORIGIN_LABEL[r.origin]}`);
  lines.push(`🚐 Chuyến cũ: ${r.oldDeparture ? `${dashTime(r.oldDeparture)} ${shortRoute(r.oldRoute)}`.trim() : "(chưa lấy được từ hệ thống)"}${r.oldSeat && !state?.shift ? `, ghế ${r.oldSeat}` : ""}`);
  const route = shortRoute(r.newRoute ?? r.oldRoute);
  if (state?.shift) {
    const s = state.shift;
    lines.push(`🚐 Chuyến mới: ${s.name} ngày ${apiDate(r.newDeparture)} ${route}, còn ${s.freeSeat} ghế trống${s.isExtra ? " (xe tăng cường)" : ""}`);
    // Ghế mới (và phụ thu) tách dòng riêng dưới chuyến mới.
    const allowed = state.tickets.filter((t) => t.allowed);
    const fee = (t: TicketState) => (t.surcharge > 0 ? `phụ thu ${formatMoney(t.surcharge)}` : "không phụ thu");
    const seat = (t: TicketState) => (t.seat !== undefined ? seatLabel(t.seat) : "?");
    if (allowed.length === 1) lines.push(`💺 Ghế mới: ${seat(allowed[0])}, ${fee(allowed[0])}`);
    else if (allowed.length > 1) lines.push(`💺 Ghế mới: ${allowed.map((t) => `${t.code} ghế ${seat(t)} (${fee(t)})`).join("; ")}`);
  } else {
    lines.push(`🚐 Chuyến mới: ${dashTime(r.newDeparture)} ${route}`.trim() + (r.newSeat ? `, ghế ${r.newSeat}` : ""));
  }
  if (state?.shiftChoices) {
    lines.push(`   Có ${state.shiftChoices.length} chuyến cùng giờ, ${item.requestedBy.name} cần chọn: @bot chọn 1${state.shiftChoices.length > 1 ? ", @bot chọn 2..." : ""}`);
  }
  for (const t of state?.tickets ?? []) {
    if (t.systemTrip && !r.oldFromSystem && !sameTrip(t, r)) lines.push(`   ⚠️ Hệ thống ghi chuyến cũ của vé ${t.code}: ${t.systemTrip}`);
  }
  if (state && !state.shift && !state.shiftChoices) lines.push(`⏳ Chưa kiểm tra được với hệ thống (${state.error ?? "lỗi API"}). Bot sẽ kiểm tra lại khi duyệt.`);
  else if (state?.error) lines.push(`⏳ Có vé chưa kiểm tra được (${state.error}). Bot sẽ kiểm tra lại khi duyệt.`);
  return lines;
}

/** Phụ thu và tài khoản phụ thu, gọn trong 2 dòng (tin gửi người duyệt). */
export function compactSurchargeLines(item: StoredRequest): string[] {
  const r = item.request;
  const state = item.api;
  const proposed = r.proposedSurcharge ?? 0;
  const account = state?.account ?? r.surchargeAccount;
  const lines: string[] = [];
  if (!state?.shift) {
    if (proposed > 0) lines.push(`💰 Phụ thu: ${formatMoney(proposed)}/1 mã vé`);
    if (account) lines.push(`💳 Phụ thu bởi: ${account}`);
    return lines;
  }
  const total = totalSurcharge(item);
  const allowed = state.tickets.filter((t) => t.allowed);
  if (total > 0) {
    // Ghi nguồn phụ thu theo thực tế: người gửi ghi hay hệ thống tính.
    const charged = allowed.filter((t) => t.surcharge > 0);
    const fromUser = charged.filter((t) => t.surchargeFromUser).length;
    const source = fromUser === charged.length ? "theo người gửi" : fromUser === 0 ? "theo hệ thống" : "theo người gửi và hệ thống";
    const per = proposed > 0 ? `${formatMoney(Math.max(proposed, ...allowed.map((t) => t.surcharge)))}/1 mã vé, ` : "";
    lines.push(`💰 Phụ thu: ${per}tổng ${formatMoney(total)} (${source})`);
  }
  if (account) {
    const who = state.accountName ? ` (${state.accountName})` : state.accountError ? ` ❌ ${state.accountError}` : "";
    lines.push(`💳 Phụ thu bởi: ${account}${who}`);
  } else if (total > 0) {
    lines.push(`💳 Phụ thu bởi: (chưa có) Người duyệt ghi khi đồng ý: Đồng ý ${item.id} thu <tài khoản>`);
  }
  return lines;
}

/** Các dòng phụ thu (💰, tài khoản), dùng chung cho form đầy đủ và tin gọn. */
export function surchargeLines(item: StoredRequest): string[] {
  const r = item.request;
  const state = item.api;
  if (!state?.shift) return [];
  const lines: string[] = [];
  const total = totalSurcharge(item);
  const proposed = r.proposedSurcharge ?? 0;
  const allowed = state.tickets.filter((t) => t.allowed);
  if (proposed > 0 && allowed.every((t) => t.surchargeFromUser) && !allowed.some((t) => t.systemSurcharge)) {
    lines.push(`💰 Hệ thống không tính phụ thu, bot nhận phụ thu người gửi yêu cầu: ${formatMoney(proposed)}/1 mã vé, tổng ${formatMoney(total)} (mặc định thu)`);
  } else if (proposed > 0 && total > 0) {
    lines.push(`💰 Người gửi ghi phụ thu ${formatMoney(proposed)}/1 mã vé, bot lấy số lớn hơn giữa hệ thống và người gửi cho từng vé: tổng ${formatMoney(total)} (mặc định thu)`);
  } else if (total > 0) {
    lines.push(`💰 Hệ thống tính phụ thu ${formatMoney(total)}, người gửi không ghi phụ thu. Người duyệt xác nhận: @bot Đồng ý ${item.id} thu <tài khoản> hoặc @bot Đồng ý ${item.id} không thu`);
  }
  const account = state.account ?? r.surchargeAccount;
  if (account && state.accountName) lines.push(`👤 Tài khoản phụ thu ${account}: ${state.accountName}`);
  if (account && state.accountError) lines.push(`❌ Tài khoản phụ thu ${account}: ${state.accountError}`);
  if (total > 0 && !account) lines.push(`⚠️ Có phụ thu nhưng chưa ghi tài khoản. Người duyệt ghi kèm khi đồng ý: @bot Đồng ý ${item.id} thu <tài khoản>`);
  return lines;
}

function sameTrip(t: TicketState, r: ExchangeRequest): boolean {
  if (!r.oldDeparture) return true;
  return !!t.systemTrip?.startsWith(`${hhmm(r.oldDeparture)} ${apiDate(r.oldDeparture)}`);
}

/** Người duyệt chọn thu hay không: "thu", "thu ngannn-tn", "không thu". */
export function readCollect(note: string): { collect?: boolean; account?: string; rest: string } {
  const m = note.match(/^(kh[oô]ng\s+thu|ko\s+thu|k\s+thu|thu)\b\s*/i);
  if (!m) return { rest: note };
  if (!/^thu$/i.test(m[1])) return { collect: false, rest: note.slice(m[0].length).trim() };
  const after = note.slice(m[0].length).trim();
  const account = after.match(/^([A-Za-z0-9._-]+)(?:\s|$)/)?.[1];
  return { collect: true, account, rest: account ? after.slice(account.length).trim() : after };
}

/** Câu hỏi cho người duyệt nếu còn thiếu lựa chọn thu phụ thu / tài khoản. undefined = đủ để đổi. */
export function surchargeQuestion(item: StoredRequest): string | undefined {
  const state = item.api!;
  const total = totalSurcharge(item);
  if (total === 0) return undefined;
  if (state.collect === undefined) {
    return `${item.id} có phụ thu ${formatMoney(total)}. Anh/chị chọn:\n@bot Đồng ý ${item.id} thu\n@bot Đồng ý ${item.id} không thu`;
  }
  if (!state.collect) return undefined;
  const account = state.account ?? item.request.surchargeAccount;
  if (!account) return `Cần tài khoản gán phụ thu: @bot Đồng ý ${item.id} thu <tài khoản>`;
  if (state.accountError) return `Tài khoản phụ thu ${account} không dùng được (${state.accountError}). Ghi tài khoản khác: @bot Đồng ý ${item.id} thu <tài khoản>`;
  return undefined;
}

export { checkAccount };

export interface ExchangeOutcome {
  lines: string[];
  /** Còn vé chờ duyệt lại (ghế vừa bị bán, chưa rõ kết quả). */
  needsRetry: boolean;
}

/** Bước 9–10: kiểm tra lại ngay trước khi đổi, rồi đổi từng vé. Vé lỗi để lại, vé khác vẫn đổi. */
export async function executeExchange(item: StoredRequest, api: HoangLongApi, approverName: string): Promise<ExchangeOutcome> {
  const state = item.api!;
  const shift = state.shift!;
  const r = item.request;
  const account = state.account ?? r.surchargeAccount ?? "";
  const lines: string[] = [];
  let needsRetry = false;
  const taken = new Set(state.tickets.filter((t) => t.result === "DONE" && t.seat !== undefined).map((t) => t.seat!));
  const note = `${item.id} - duyệt bởi ${approverName}${item.decisionNote ? `: ${item.decisionNote}` : ""}`;

  for (const t of state.tickets) {
    if (!t.allowed || t.result === "DONE" || t.result === "FAILED") continue;
    try {
      const check = await api.checkTicket(t.code, r.newDeparture, shift.id, t.seat);
      // Lần trước mất kết nối khi đổi: xem hệ thống đã ghi chuyến mới chưa.
      if (t.result === "UNKNOWN" && check.TicketInfo?.Date === apiDate(r.newDeparture) && check.TicketInfo.StartTime === shift.name) {
        t.result = "DONE";
        t.resultMessage = "Đã đổi (xác nhận lại với hệ thống)";
        lines.push(`✅ ${t.code}: đã đổi sang ghế ${seatLabel(check.TicketInfo.Seat)}`);
        continue;
      }
      if (!check.Status) {
        const free = check.FreeSeats ?? [];
        if (t.seat !== undefined && free.length > 0 && !free.includes(t.seat)) {
          const alt = pickSeat(free, t.oldSeat, taken);
          if (alt !== undefined) {
            lines.push(`⚠️ ${t.code}: ghế ${seatLabel(t.seat)} vừa có người đặt, bot đề xuất ghế ${seatLabel(alt)}`);
            t.seat = alt;
            t.result = undefined;
            needsRetry = true;
            continue;
          }
        }
        t.result = "FAILED";
        t.resultMessage = check.Message;
        lines.push(`❌ ${t.code}: ${check.Message} → để lại, không đổi`);
        continue;
      }
      if (!t.surchargeFromUser && check.Surcharge !== t.surcharge) {
        lines.push(`⚠️ ${t.code}: phụ thu đổi từ ${formatMoney(t.surcharge)} thành ${formatMoney(check.Surcharge)}, cần duyệt lại`);
        t.surcharge = check.Surcharge;
        needsRetry = true;
        continue;
      }

      t.result = "UNKNOWN"; // ghi trước khi gọi, nếu mất kết nối giữa chừng thì lần sau kiểm tra lại
      const res = await api.changeTicket({
        orderNumber: t.code,
        date: r.newDeparture,
        shiftId: shift.id,
        seat: t.seat!,
        surcharge: state.collect ? t.surcharge : 0,
        userSurcharge: state.collect ? account : "",
        note,
        requestCode: `${item.id}-${t.code}`,
      });
      t.result = res.Status ? "DONE" : "FAILED";
      t.resultMessage = res.Message;
      if (res.Status) {
        taken.add(t.seat!);
        const fee = state.collect && t.surcharge > 0 ? `, phụ thu ${formatMoney(t.surcharge)}` : "";
        lines.push(`✅ ${t.code}: đã đổi sang ghế ${seatLabel(t.seat!)}${fee}`);
      } else {
        lines.push(`❌ ${t.code}: ${res.Message} → để lại, không đổi`);
      }
    } catch (err) {
      needsRetry = true;
      lines.push(`⏳ ${t.code}: ${errorText(err)}. Chưa rõ đã đổi chưa, gõ lại lệnh đồng ý để bot kiểm tra.`);
    }
  }
  return { lines, needsRetry };
}

/** Trạng thái cuối khi mọi vé đã có kết quả. */
export function finalStatus(item: StoredRequest): "DA_DOI" | "DOI_MOT_PHAN" | "LOI_DOI" {
  const done = item.api!.tickets.filter((t) => t.result === "DONE").length;
  return done === item.request.ticketCodes.length ? "DA_DOI" : done > 0 ? "DOI_MOT_PHAN" : "LOI_DOI";
}

/** Còn vé đổi được mà chưa có kết quả. */
export function hasOpenTickets(item: StoredRequest): boolean {
  return (item.api?.tickets ?? []).some((t) => t.allowed && t.result !== "DONE" && t.result !== "FAILED");
}
