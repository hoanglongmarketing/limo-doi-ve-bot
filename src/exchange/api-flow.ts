// Các bước dùng API Hoàng Long: tìm chuyến mới, kiểm tra từng vé, chọn ghế, đổi vé.
// Trình tự theo tài liệu "Quy trình đổi vé LIMO qua API Hoàng Long".
import { apiDate, HoangLongApiError, type HoangLongApi, type TicketResult } from "../hl/api.js";
import { isVip, routeIdOf, seatLabel, seatNumber, splitSeats } from "./codes.js";
import type { ApiState, ShiftState, StoredRequest, TicketState } from "./store.js";
import { formatMoney, type ExchangeRequest } from "./template.js";
import { formatVn } from "./time.js";

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
export async function prepare(r: ExchangeRequest, api: HoangLongApi): Promise<PrepareResult> {
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
  return { ok: true, state };
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
}

/**
 * Quy định phụ thu (chị Tyra chốt 09/11):
 * - Hệ thống không tính phụ thu mà người gửi ghi phụ thu: mặc định thu theo số người gửi (mỗi vé).
 * - Hệ thống có phụ thu và người gửi cũng ghi phụ thu: mặc định thu theo số hệ thống.
 * - Hệ thống có phụ thu mà người gửi không ghi: người duyệt xác nhận thu hay không.
 */
function applySurchargeRule(r: ExchangeRequest, state: ApiState): void {
  const proposed = r.proposedSurcharge ?? 0;
  if (proposed <= 0) return;
  const allowed = state.tickets.filter((t) => t.allowed);
  if (allowed.length === 0) return;
  if (allowed.every((t) => t.surcharge === 0)) {
    for (const t of allowed) {
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
    const type = t.ticketType ? `${t.ticketType}, ` : "";
    const old = t.oldSeat !== undefined ? `ghế cũ ${seatLabel(t.oldSeat)}` : "";
    if (t.allowed) {
      const fee = t.surcharge > 0 ? `, phụ thu ${formatMoney(t.surcharge)}` : ", không phụ thu";
      lines.push(`✅ ${t.code} (${type}${old}) → ghế ${t.seat !== undefined ? seatLabel(t.seat) : "?"}${fee}`);
    } else {
      lines.push(`❌ ${t.code}${t.ticketType ? ` (${t.ticketType})` : ""}: ${t.message} → để lại, không đổi`);
    }
    if (t.systemTrip && !sameTrip(t, r)) lines.push(`   ⚠️ Hệ thống ghi chuyến cũ của vé này: ${t.systemTrip}`);
  }
  if (state.error) lines.push(`⏳ Có vé chưa kiểm tra được (${state.error}). Bot sẽ kiểm tra lại khi duyệt.`);

  const total = totalSurcharge(item);
  const proposed = r.proposedSurcharge ?? 0;
  const fromUser = state.tickets.some((t) => t.allowed && t.surchargeFromUser);
  if (fromUser) {
    lines.push(`💰 Hệ thống không tính phụ thu, bot nhận phụ thu người gửi yêu cầu: ${formatMoney(proposed)}/vé, tổng ${formatMoney(total)} (mặc định thu)`);
  } else if (total > 0 && proposed > 0) {
    const note = proposed !== total ? ` (người gửi ghi ${formatMoney(proposed)})` : "";
    lines.push(`💰 Tổng phụ thu hệ thống tính: ${formatMoney(total)}${note}. Người gửi có yêu cầu phụ thu nên mặc định thu.`);
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
