import type { HoangLongApi } from "../hl/api.js";
import {
  checkAccount,
  checkLines,
  chooseShift,
  compactTripLines,
  compactSurchargeLines,
  ensureChecked,
  executeExchange,
  collectedSurcharge,
  finalStatus,
  hasOpenTickets,
  noneAllowed,
  prepare,
  readCollect,
  surchargeQuestion,
  ticketSummary,
  totalSurcharge,
} from "./api-flow.js";
import { isApprover, type Approver } from "./approvers.js";
import { looksLikeFreeText, readFreeText } from "./freetext.js";
import {
  buildRequest,
  looksLikeTemplate,
  parseExchangeRequest,
  formatMoney,
  minutesText,
  REQUEST_TEMPLATE,
  renderForm,
  type ExchangeRequest,
} from "./template.js";
import { fold, normalize } from "./text.js";
import type { ApiState, RequestStatus, RequestStore, StoredRequest } from "./store.js";
import { formatVn, NEW_TRIP_GRACE_MS } from "./time.js";
import { ORIGIN_LABEL, type Origin } from "./trip.js";

export { RequestStore } from "./store.js";

export interface Sender {
  id: string;
  name: string;
}

export interface FlowContext {
  store: RequestStore;
  approvers: Record<Origin, Approver>;
  now?: Date;
  /** Nhóm đang nhắn, lưu kèm yêu cầu. */
  chatId?: string;
  /** Bot đẩy báo cáo (đã duyệt / từ chối) vào đây để gửi sang nhóm báo cáo. */
  reports?: string[];
  /** API Hoàng Long; không có thì bot chỉ ghi nhận yêu cầu, chưa đổi vé thật. */
  api?: HoangLongApi;
  /** Tin nhắn riêng bot gửi thêm (vd báo người duyệt có yêu cầu mới), vì Zalo Bot chưa tag được người trong nhóm. */
  notices?: { chatId: string; text: string }[];
  /** Tin đang xử lý là tin nhắn riêng với bot (không phải trong nhóm). */
  privateChat?: boolean;
  /** Nhóm duyệt: yêu cầu gửi qua tin nhắn riêng, xác nhận xong bot chuyển vào đây. */
  approvalGroupId?: string;
  /** Yêu cầu vừa có kết quả duyệt trong lần xử lý này (để báo vào nhóm khi duyệt qua tin nhắn riêng). */
  decided?: StoredRequest;
}

/** Nhóm đổi vé của yêu cầu: nhóm duyệt nếu gửi riêng, không thì nhóm nơi gửi. */
function groupOf(ctx: FlowContext, item: StoredRequest): string | undefined {
  return item.fromPrivate ? ctx.approvalGroupId : item.chatId;
}

/** Yêu cầu gửi riêng đã chờ duyệt: chuyển vào nhóm duyệt. Trả về câu trả lời riêng cho người gửi, nếu đã chuyển. */
function forwardToGroup(ctx: FlowContext, item: StoredRequest): string | undefined {
  if (!item.fromPrivate || !ctx.approvalGroupId || item.status !== "CHO_DUYET") return undefined;
  if (item.api?.shiftChoices || noneAllowed(item)) return undefined;
  const approver = ctx.approvers[item.request.origin];
  ctx.notices?.push({ chatId: ctx.approvalGroupId, text: submittedReply(item, approver) });
  return `✅ Đã chuyển ${item.id} (${ticketsLabel(item.request)}) vào nhóm đổi vé, chờ ${approver.name} duyệt. Có kết quả bot sẽ nhắn riêng anh/chị.`;
}

/** Yêu cầu có kết quả: gửi báo cáo, và nhắn riêng người gửi nếu họ gửi qua tin nhắn riêng. */
function finish(ctx: FlowContext, item: StoredRequest): void {
  ctx.decided = item;
  const report = reportText(item);
  ctx.reports?.push(report);
  if (item.fromPrivate) ctx.notices?.push({ chatId: item.requestedBy.id, text: `Kết quả yêu cầu đổi vé của anh/chị:\n\n${report}` });
}

/** Nhắn riêng cho người duyệt khi có yêu cầu chờ duyệt. */
function notifyApprover(ctx: FlowContext, item: StoredRequest): void {
  if (item.status !== "CHO_DUYET" || item.api?.shiftChoices || noneAllowed(item)) return;
  const approver = ctx.approvers[item.request.origin];
  const text = compactMessage(
    item,
    `🔔 Yêu cầu ĐỔI VÉ ${item.id} của ${item.requestedBy.name} đang chờ ${approver.name} duyệt:`,
    `👉 Trả lời ngay tại đây (hoặc trong nhóm, kèm @bot): Đồng ý ${item.id} hoặc Từ chối ${item.id} <lý do>`,
  );
  for (const id of approver.zaloIds) ctx.notices?.push({ chatId: id, text });
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  NHAP: "chờ người gửi xác nhận",
  CHO_DUYET: "chờ duyệt",
  DA_DUYET: "đã duyệt",
  TU_CHOI: "từ chối",
  DA_DOI: "đã đổi vé",
  DOI_MOT_PHAN: "đã đổi một phần",
  LOI_DOI: "đổi vé lỗi",
};

export function helpText(senderName: string): string {
  return [
    `Chào ${senderName}! Em là bot đổi vé LIMO Hoàng Long (bản test).`,
    "• Gửi yêu cầu: @bot rồi nhắn bình thường, chỉ cần mã vé và chuyến mới (giờ, ngày, tuyến), chuyến cũ bot lấy từ hệ thống. Vd: A711655 A714050 đổi sang chuyến 18h HN-HP ngày 30/11 (lý do). Dùng được các từ: đổi vé, chuyển vé, sửa vé, dời/lùi chuyến. Bot soạn form, người gửi chỉ cần @bot Xác nhận.",
    "• Hoặc gửi theo mẫu: @bot mẫu",
    "• Có thể nhắn riêng cho bot (không cần @bot). Xác nhận xong bot chuyển yêu cầu vào nhóm đổi vé để duyệt, có kết quả bot nhắn riêng lại.",
    "• Người duyệt (trong nhóm, hoặc nhắn riêng cho bot không cần @bot): @bot Đồng ý YC001 hoặc @bot Từ chối YC001 <lý do>. Có phụ thu: @bot Đồng ý YC001 thu <tài khoản> hoặc @bot Đồng ý YC001 không thu",
    "• Nhiều chuyến cùng giờ: @bot chọn 1",
    "• Xem trạng thái: @bot xem YC001",
  ].join("\n");
}

function ticketsLabel(r: ExchangeRequest): string {
  return r.ticketCodes.length === 1 ? `vé ${r.ticketCodes[0]}` : `${r.ticketCodes.length} vé ${r.ticketCodes.join(", ")}`;
}

/** Quy định quá giờ, in kèm cảnh báo đỏ. */
const LATE_RULE =
  "🔴 Quy định: chuyến quá giờ trong ngày vẫn đổi được nếu người duyệt đồng ý; chuyến đã chạy từ ngày trước thì không đổi được.";

/** "đã chạy lúc 05:30, quá 3 tiếng 30 phút" */
function lateBy(d: Date, now: Date): string {
  return `đã chạy lúc ${formatVn(d).slice(0, 5)}, quá ${minutesText(Math.round((now.getTime() - d.getTime()) / 60_000))}`;
}

function checksText(item: StoredRequest): string[] {
  const r = item.request;
  return [
    item.overdue
      ? `🔴 CHUYẾN CŨ ĐÃ QUÁ GIỜ (${r.oldDeparture ? lateBy(r.oldDeparture, item.requestedAt) : "đã chạy"}). Chỉ đổi khi người duyệt đồng ý.`
      : item.request.oldDeparture
      ? "✅ Chuyến cũ chưa chạy."
      : "⏳ Chuyến cũ: chưa lấy được từ hệ thống, bot sẽ kiểm tra lại khi duyệt.",
    ...(item.newTripLate
      ? [`🔴 CHUYẾN MỚI ĐÃ QUÁ GIỜ (${lateBy(r.newDeparture, item.requestedAt)}). Chỉ đổi khi người duyệt đồng ý.`]
      : []),
    ...(item.overdue || item.newTripLate ? [LATE_RULE] : []),
    ...(item.api ? checkLines(item) : ["⏳ Ghế trống và chênh lệch giá/phụ thu: chưa kiểm tra (chưa nối API Hoàng Long)."]),
  ];
}

function waitingApprovalText(item: StoredRequest, approver: Approver): string {
  return `Chờ ${approver.name} duyệt. Trả lời: @bot Đồng ý ${item.id} hoặc @bot Từ chối ${item.id}`;
}

/** Form kèm phụ thu hệ thống tính, để in dòng "Phụ thu bởi" khi cần. */
function formOf(item: StoredRequest): string {
  return renderForm(item.request, { surcharge: totalSurcharge(item), account: item.api?.account });
}

function draftReply(item: StoredRequest): string {
  const r = item.request;
  return [
    `Em đã soạn yêu cầu ${item.id} (${ticketsLabel(r)}):`,
    "",
    formOf(item),
    "",
    ...r.assumptions.map((a) => `ℹ️ ${a}`),
    ...checksText(item),
    "",
    noneAllowed(item)
      ? NONE_ALLOWED
      : item.api?.shiftChoices
      ? `Chọn chuyến xong, ${item.requestedBy.name} kiểm tra lại form rồi @bot Xác nhận.`
      : `${item.requestedBy.name} kiểm tra giúp em: đúng thì @bot Xác nhận, sai thì sao chép form trên, sửa rồi gửi lại.`,
  ].join("\n");
}

/** Dòng ghi nhân viên nào đã xác nhận form. */
function confirmedLine(item: StoredRequest): string | undefined {
  return item.confirmedAt ? `✍️ Nhân viên xác nhận: ${item.requestedBy.name} lúc ${formatVn(item.confirmedAt)}` : undefined;
}

function submittedReply(item: StoredRequest, approver: Approver): string {
  return compactMessage(
    item,
    `Đã nhận yêu cầu ĐỔI VÉ ${item.id} từ ${item.requestedBy.name}${item.fromPrivate ? " (gửi riêng cho bot)" : ""}:`,
    noneAllowed(item) ? NONE_ALLOWED : `👉 ${waitingApprovalText(item, approver)}`,
  );
}

const SEPARATOR = "______________________";

/**
 * Tin gọn gửi người duyệt (mẫu chị Tyra 19/11): thông tin vé, rồi cảnh báo / phụ thu / người xác nhận,
 * rồi lời nhắc duyệt. Không in các dòng "bot hiểu là...".
 */
function compactMessage(item: StoredRequest, header: string, footer: string): string {
  const r = item.request;
  const late: string[] = [];
  if (item.overdue) late.push(`🔴 CHUYẾN CŨ ĐÃ QUÁ GIỜ (${r.oldDeparture ? lateBy(r.oldDeparture, item.requestedAt) : "đã chạy"}).`);
  if (item.newTripLate) late.push(`🔴 CHUYẾN MỚI ĐÃ QUÁ GIỜ (${lateBy(r.newDeparture, item.requestedAt)}).`);
  if (late.length) {
    late.push("Người duyệt kiểm tra kỹ trước khi đồng ý. Chỉ đổi khi người duyệt đồng ý.");
    late.push("Quy định: chuyến đã chạy từ ngày trước thì không đổi được.");
  }
  const notes = [
    ...late,
    ...(item.api ? [] : ["⏳ Ghế trống và phụ thu: chưa kiểm tra (chưa nối API Hoàng Long)."]),
    confirmedLine(item),
  ].filter((line): line is string => !!line);
  return [
    header,
    SEPARATOR,
    ...compactTripLines(item),
    r.customerName || r.customerPhone ? `👤 Khách: ${[r.customerName, r.customerPhone].filter(Boolean).join(" - ")}` : undefined,
    ...compactSurchargeLines(item),
    r.reason ? `📝 Lý do: ${r.reason}` : undefined,
    ...(notes.length ? [SEPARATOR, ...notes] : []),
    SEPARATOR,
    footer,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const NONE_ALLOWED = "⛔ Không vé nào đổi được theo hệ thống. Anh/chị kiểm tra lại mã vé, chuyến mới rồi gửi yêu cầu mới.";

type Command = { kind: "confirm" | "approve" | "reject" | "choose"; id?: string; note: string };

const COMMAND_WORDS: [Command["kind"], RegExp][] = [
  ["choose", /^chon\b/],
  ["reject", /^(tu choi|khong dong y|khong duyet)\b/],
  ["approve", /^(dong y|duyet|ok|oke|okay)\b/],
  ["confirm", /^(xac nhan|dung roi)\b/],
];

/**
 * Đọc lệnh ngắn: "Xác nhận", "Đồng ý YC001", "YC001 xác nhận", "từ chối yc 1 hết ghế".
 * Mã YC đứng trước hay sau đều được. Tin có mã vé thì không phải lệnh (là yêu cầu mới).
 */
export function parseCommand(content: string): Command | undefined {
  if (content.length > 150 || /\bA\d{6}\b/i.test(content)) return undefined;
  const original = content.normalize("NFC").trim();
  const idMatch = fold(original).match(/\byc\s*0*(\d{1,6})\b/);
  const id = idMatch ? `YC${idMatch[1].padStart(3, "0")}` : undefined;
  const rest = idMatch ? (original.slice(0, idMatch.index) + " " + original.slice(idMatch.index! + idMatch[0].length)).trim() : original;
  const restFolded = fold(rest).replace(/^[\s,.:\-!]+/, "");
  const offset = fold(rest).length - restFolded.length;
  for (const [kind, re] of COMMAND_WORDS) {
    const m = restFolded.match(re);
    if (!m) continue;
    const note = rest.slice(offset + m[0].length).replace(/^[\s,.:\-!]+/, "").trim();
    return { kind, id, note };
  }
  return undefined;
}

async function handleChoose(cmd: Command, sender: Sender, ctx: FlowContext): Promise<string> {
  const n = Number(cmd.note.match(/\d+/)?.[0]);
  const item = cmd.id ? ctx.store.get(cmd.id) : ctx.store.latestShiftChoiceBy(sender.id);
  if (!item?.api?.shiftChoices || !ctx.api) return "Không có yêu cầu nào đang chờ chọn chuyến.";
  if (!n) return `Ghi số thứ tự chuyến, vd: @bot chọn 1 ${item.id}`;
  const error = await chooseShift(item, n, ctx.api);
  if (error) return error;
  const old = item.request.oldDeparture;
  if (old) item.overdue = old.getTime() <= (ctx.now ?? new Date()).getTime();
  ctx.store.save(item);
  if (item.status === "NHAP") return draftReply(item);
  notifyApprover(ctx, item);
  return forwardToGroup(ctx, item) ?? submittedReply(item, ctx.approvers[item.request.origin]);
}

function handleConfirm(cmd: Command, sender: Sender, ctx: FlowContext): string {
  const item = cmd.id ? ctx.store.get(cmd.id) : ctx.store.latestDraftBy(sender.id);
  if (!item) return cmd.id ? `Không tìm thấy yêu cầu ${cmd.id}.` : "Không có yêu cầu nào đang chờ anh/chị xác nhận.";
  if (item.status !== "NHAP") return `${item.id} đã được xác nhận trước đó (${STATUS_LABEL[item.status]}).`;
  if (item.api?.shiftChoices) return `${item.id} cần chọn chuyến trước: @bot chọn 1, @bot chọn 2...`;
  const approver = ctx.approvers[item.request.origin];
  if (item.requestedBy.id !== sender.id) {
    return `Chỉ ${item.requestedBy.name} (người gửi) xác nhận được ${item.id}. ${approver.name} có thể duyệt luôn: @bot Đồng ý ${item.id}`;
  }

  item.status = "CHO_DUYET";
  item.confirmedAt = ctx.now ?? new Date();
  ctx.store.save(item);
  notifyApprover(ctx, item);
  const forwarded = forwardToGroup(ctx, item);
  if (forwarded) return forwarded;
  return `Đã xác nhận ${item.id} (${ticketsLabel(item.request)}).\n${waitingApprovalText(item, approver)}`;
}

/**
 * Người duyệt đồng ý / từ chối. Duyệt qua tin nhắn riêng với bot thì kết quả cũng được báo vào nhóm đổi vé,
 * như khi duyệt trong nhóm.
 */
async function handleDecision(cmd: Command, sender: Sender, ctx: FlowContext): Promise<string> {
  ctx.decided = undefined;
  const reply = await decide(cmd, sender, ctx);
  const group = ctx.privateChat && ctx.decided ? groupOf(ctx, ctx.decided) : undefined;
  if (group) ctx.notices?.push({ chatId: group, text: `${reply}\n\n(${sender.name} duyệt qua tin nhắn riêng với bot)` });
  return reply;
}

async function decide(cmd: Command, sender: Sender, ctx: FlowContext): Promise<string> {
  const approve = cmd.kind === "approve";
  let item = cmd.id ? ctx.store.get(cmd.id) : undefined;
  if (cmd.id && !item) return `Không tìm thấy yêu cầu ${cmd.id}.`;
  if (!item) {
    // Không ghi mã: lấy yêu cầu đang chờ người này duyệt, nếu chỉ có một.
    const waiting = [...ctx.store.pending(), ...ctx.store.awaitingRetry()]
      .filter((i) => isApprover(ctx.approvers[i.request.origin], sender.id, sender.name));
    if (waiting.length === 0) return "Không có yêu cầu nào đang chờ anh/chị duyệt.";
    if (waiting.length > 1) {
      return `Đang có ${waiting.length} yêu cầu chờ duyệt (${waiting.map((i) => i.id).join(", ")}). Anh/chị ghi rõ mã, vd: @bot Đồng ý ${waiting[0].id}`;
    }
    item = waiting[0];
  }

  const approver = ctx.approvers[item.request.origin];
  if (!isApprover(approver, sender.id, sender.name)) {
    return `${item.id} là vé đi từ ${ORIGIN_LABEL[item.request.origin]}, chỉ ${approver.name} được duyệt.`;
  }
  const retry = approve && item.status === "DA_DUYET" && hasOpenTickets(item);
  if (item.status !== "NHAP" && item.status !== "CHO_DUYET" && !retry) {
    return `${item.id} đã được xử lý trước đó (${STATUS_LABEL[item.status]} bởi ${item.decidedBy}).`;
  }

  if (approve && ctx.api) return approveWithApi(item, cmd, sender, ctx, approver);

  // Người duyệt quyết định luôn cả khi người gửi chưa xác nhận form.
  item.status = approve ? "DA_DUYET" : "TU_CHOI";
  item.decidedBy = sender.name;
  item.decidedAt = ctx.now ?? new Date();
  if (cmd.note) item.decisionNote = cmd.note;
  ctx.store.save(item);
  finish(ctx, item);

  if (!approve) {
    return `❌ ${approver.name} đã từ chối ${item.id} (${ticketsLabel(item.request)}).${cmd.note ? `\nLý do: ${cmd.note}` : ""}`;
  }
  return [
    `✅ ${approver.name} đã đồng ý đổi ${item.id} (${ticketsLabel(item.request)}).`,
    "Bản test: bot CHƯA đổi vé thật trên hệ thống. Khi có API Hoàng Long, bước này sẽ kiểm tra ghế, tính phụ thu và đổi vé.",
  ].join("\n");
}

/** Đồng ý khi có API: kiểm tra lại, hỏi thu phụ thu nếu cần, rồi đổi từng vé. */
async function approveWithApi(item: StoredRequest, cmd: Command, sender: Sender, ctx: FlowContext, approver: Approver): Promise<string> {
  const api = ctx.api!;
  const notReady = await ensureChecked(item, api);
  if (notReady) {
    ctx.store.save(item);
    return notReady;
  }
  const state = item.api!;
  const choice = readCollect(cmd.note);
  if (choice.collect !== undefined) state.collect = choice.collect;
  if (choice.account && choice.account !== (state.account ?? item.request.surchargeAccount)) {
    state.account = choice.account;
    await checkAccount(item.request, state, api);
  }
  if (!state.tickets.some((t) => t.allowed)) {
    item.status = "TU_CHOI";
    item.decidedBy = sender.name;
    item.decidedAt = ctx.now ?? new Date();
    item.decisionNote = "Không vé nào đổi được theo hệ thống";
    ctx.store.save(item);
    finish(ctx, item);
    return [`❌ ${item.id}: không vé nào đổi được theo hệ thống.`, ...state.tickets.map((t) => `• ${ticketSummary(t)}`)].join("\n");
  }
  const question = surchargeQuestion(item);
  if (question) {
    ctx.store.save(item);
    return question;
  }

  item.status = "DA_DUYET";
  item.decidedBy = sender.name;
  item.decidedAt = ctx.now ?? new Date();
  if (choice.rest) item.decisionNote = choice.rest;
  ctx.store.save(item);

  const outcome = await executeExchange(item, api, sender.name);
  const header = `${approver.name} đã đồng ý ${item.id}. Kết quả đổi vé trên hệ thống:`;
  if (outcome.needsRetry) {
    ctx.store.save(item);
    ctx.decided = item;
    return [header, ...outcome.lines, "", `Còn vé chưa đổi xong. ${approver.name} kiểm tra rồi gõ lại: @bot Đồng ý ${item.id}`].join("\n");
  }
  item.status = finalStatus(item);
  ctx.store.save(item);
  finish(ctx, item);
  const left = state.tickets.filter((t) => !t.allowed).map((t) => `❌ ${t.code}: ${t.message} → để lại`);
  return [header, ...outcome.lines, ...left, "", `${item.id}: ${STATUS_LABEL[item.status]}.`].join("\n");
}

const REPORT_TITLE: Record<RequestStatus, string> = {
  NHAP: "📝 NHÁP",
  CHO_DUYET: "⏳ CHỜ DUYỆT",
  DA_DUYET: "✅ ĐÃ DUYỆT",
  TU_CHOI: "❌ TỪ CHỐI",
  DA_DOI: "✅ ĐÃ ĐỔI",
  DOI_MOT_PHAN: "⚠️ ĐỔI MỘT PHẦN",
  LOI_DOI: "❌ LỖI",
};

/** Báo cáo gửi sang nhóm báo cáo khi yêu cầu có kết quả. */
export function reportText(item: StoredRequest): string {
  const approved = item.status !== "TU_CHOI";
  return [
    `${REPORT_TITLE[item.status]} ĐỔI VÉ ${item.id}`,
    "",
    formOf(item),
    "",
    `Người gửi: ${item.requestedBy.name} lúc ${formatVn(item.requestedAt)}`,
    `${approved ? "Người duyệt" : "Người từ chối"}: ${item.decidedBy}${item.decidedAt ? ` lúc ${formatVn(item.decidedAt)}` : ""}`,
    item.decisionNote ? `Ghi chú: ${item.decisionNote}` : undefined,
    item.overdue ? "🔴 Chuyến cũ quá giờ" : undefined,
    item.newTripLate ? "🔴 Chuyến mới quá giờ" : undefined,
    ...(item.api?.shift ? [`Chuyến mới trên hệ thống: ${item.api.shift.name} (ShiftID ${item.api.shift.id})`] : []),
    ...(item.api?.tickets.map((t) => `• ${ticketSummary(t)}${t.result === "DONE" && item.api?.collect && t.surcharge > 0 ? `, phụ thu ${formatMoney(t.surcharge)}` : ""}`) ?? []),
    item.api?.collect && collectedSurcharge(item) > 0
      ? `Phụ thu: ${formatMoney(collectedSurcharge(item))} (tài khoản ${item.api.account ?? item.request.surchargeAccount})`
      : undefined,
    item.api?.collect === false && totalSurcharge(item) > 0 ? "Phụ thu: không thu (người duyệt chọn)" : undefined,
    approved && !item.api ? "Trạng thái đổi vé trên hệ thống: chưa thực hiện (chưa nối API)" : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function missingInfoReply(errors: string[]): string {
  return ["Yêu cầu đổi vé chưa đủ thông tin:", ...errors.map((e) => `• ${e}`), "", 'Gõ "@bot mẫu" để lấy mẫu.'].join("\n");
}

/** Xử lý nội dung (đã bỏ @bot) và trả về câu trả lời. */
export async function respond(content: string, sender: Sender, ctx: FlowContext): Promise<string> {
  const now = ctx.now ?? new Date();
  const n = normalize(content);

  if (n === "" || /^(help|\/help|huong dan)\b/.test(n)) return helpText(sender.name);
  if (/^\/?ping\b/.test(n)) return "pong 🏓";
  if (/^\/?mau( doi ve)?$/.test(n)) {
    return `Mẫu yêu cầu đổi vé (sao chép, điền rồi gửi kèm @bot):\n\n${REQUEST_TEMPLATE}`;
  }

  const view = n.match(/^xem\s+(yc\d+)\b/);
  if (view) {
    const item = ctx.store.get(view[1]);
    if (!item) return `Không tìm thấy yêu cầu ${view[1].toUpperCase()}.`;
    const by = item.decidedBy ? ` bởi ${item.decidedBy}` : "";
    const tickets = item.api?.tickets.map((t) => `• ${ticketSummary(t)}`) ?? [];
    return [`${item.id}: ${STATUS_LABEL[item.status]}${by}`, "", formOf(item), ...(tickets.length ? ["", ...tickets] : [])].join("\n");
  }

  const cmd = parseCommand(content);
  if (cmd?.kind === "choose") return handleChoose(cmd, sender, ctx);
  if (cmd) return cmd.kind === "confirm" ? handleConfirm(cmd, sender, ctx) : handleDecision(cmd, sender, ctx);

  // Mẫu điền đủ: người gửi đã tự kiểm tra, chuyển thẳng cho người duyệt.
  if (looksLikeTemplate(content)) {
    const parsed = parseExchangeRequest(content, now);
    if (!parsed.ok) return missingInfoReply(parsed.errors);
    const api = await checkWithApi(ctx, parsed.request);
    if (api && !api.ok) return checkFailedReply(api.errors);
    const item = addRequest(ctx, parsed.request, sender, now, "CHO_DUYET", api?.state);
    item.confirmedAt = now;
    ctx.store.save(item);
    notifyApprover(ctx, item);
    const forwarded = forwardToGroup(ctx, item);
    return forwarded ? `${submittedReply(item, ctx.approvers[parsed.request.origin])}\n\n${forwarded}` : submittedReply(item, ctx.approvers[parsed.request.origin]);
  }

  // Tin viết tự do: bot soạn form, người gửi xác nhận.
  if (looksLikeFreeText(content)) {
    const parsed = buildRequest(readFreeText(content), now);
    if (!parsed.ok) return missingInfoReply(parsed.errors);
    const api = await checkWithApi(ctx, parsed.request);
    if (api && !api.ok) return checkFailedReply(api.errors);
    return draftReply(addRequest(ctx, parsed.request, sender, now, "NHAP", api?.state));
  }

  return `Em chưa hiểu yêu cầu. Gõ "@bot help" để xem hướng dẫn.`;
}

function checkWithApi(ctx: FlowContext, request: ExchangeRequest) {
  return ctx.api ? prepare(request, ctx.api, ctx.now ?? new Date()) : undefined;
}

function checkFailedReply(errors: string[]): string {
  return ["Hệ thống Hoàng Long báo:", ...errors.map((e) => `• ${e}`), "", "Anh/chị sửa lại rồi gửi yêu cầu mới."].join("\n");
}

function addRequest(
  ctx: FlowContext,
  request: ExchangeRequest,
  sender: Sender,
  now: Date,
  status: RequestStatus,
  api?: ApiState,
): StoredRequest {
  return ctx.store.add({
    request,
    requestedBy: sender,
    requestedAt: now,
    chatId: ctx.chatId,
    fromPrivate: ctx.privateChat || undefined,
    overdue: !!request.oldDeparture && request.oldDeparture.getTime() <= now.getTime(),
    newTripLate: request.newDeparture.getTime() < now.getTime() - NEW_TRIP_GRACE_MS,
    status,
    api,
  });
}
