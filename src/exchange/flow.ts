import { isApprover, type Approver } from "./approvers.js";
import { looksLikeFreeText, readFreeText } from "./freetext.js";
import {
  buildRequest,
  looksLikeTemplate,
  parseExchangeRequest,
  REQUEST_TEMPLATE,
  renderForm,
  type ExchangeRequest,
} from "./template.js";
import { fold, normalize } from "./text.js";
import type { RequestStatus, RequestStore, StoredRequest } from "./store.js";
import { formatVn } from "./time.js";
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
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  NHAP: "chờ người gửi xác nhận",
  CHO_DUYET: "chờ duyệt",
  DA_DUYET: "đã duyệt",
  TU_CHOI: "từ chối",
};

export function helpText(senderName: string): string {
  return [
    `Chào ${senderName}! Em là bot đổi vé LIMO Hoàng Long (bản test).`,
    "• Gửi yêu cầu: @bot rồi nhắn bình thường, vd: A711655 A714050 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP (lý do). Bot soạn form, người gửi chỉ cần @bot Xác nhận.",
    "• Hoặc gửi theo mẫu: @bot mẫu",
    "• Người duyệt: @bot Đồng ý YC001 hoặc @bot Từ chối YC001 <lý do>",
    "• Xem trạng thái: @bot xem YC001",
  ].join("\n");
}

function ticketsLabel(r: ExchangeRequest): string {
  return r.ticketCodes.length === 1 ? `vé ${r.ticketCodes[0]}` : `${r.ticketCodes.length} vé ${r.ticketCodes.join(", ")}`;
}

function checksText(item: StoredRequest): string[] {
  return [
    item.overdue
      ? "⚠️ Vé QUÁ HẠN (chuyến cũ đã chạy). Chỉ đổi được khi có xác nhận đồng ý."
      : "✅ Chuyến cũ chưa chạy.",
    "⏳ Ghế trống và chênh lệch giá/phụ thu: chưa kiểm tra (chờ API Hoàng Long).",
  ];
}

function waitingApprovalText(item: StoredRequest, approver: Approver): string {
  return `Chờ ${approver.name} duyệt. Trả lời: @bot Đồng ý ${item.id} hoặc @bot Từ chối ${item.id}`;
}

function draftReply(item: StoredRequest): string {
  const r = item.request;
  return [
    `Em đã soạn yêu cầu ${item.id} (${ticketsLabel(r)}):`,
    "",
    renderForm(r),
    "",
    ...r.assumptions.map((a) => `ℹ️ ${a}`),
    ...checksText(item),
    "",
    `${item.requestedBy.name} kiểm tra giúp em: đúng thì @bot Xác nhận, sai thì sao chép form trên, sửa rồi gửi lại.`,
  ].join("\n");
}

function submittedReply(item: StoredRequest, approver: Approver): string {
  return [
    `Đã nhận yêu cầu ${item.id} từ ${item.requestedBy.name}:`,
    "",
    renderForm(item.request),
    "",
    ...item.request.assumptions.map((a) => `ℹ️ ${a}`),
    ...checksText(item),
    "",
    waitingApprovalText(item, approver),
  ].join("\n");
}

type Command = { kind: "confirm" | "approve" | "reject"; id?: string; note: string };

const COMMAND_WORDS: [Command["kind"], RegExp][] = [
  ["reject", /^(tu choi|khong dong y|khong duyet)\b/],
  ["approve", /^(dong y|duyet|ok|oke|okay)\b/],
  ["confirm", /^(xac nhan|dung roi)\b/],
];

/**
 * Đọc lệnh ngắn: "Xác nhận", "Đồng ý YC001", "YC001 xác nhận", "từ chối yc 1 hết ghế".
 * Mã YC đứng trước hay sau đều được. Tin có mã vé thì không phải lệnh (là yêu cầu mới).
 */
export function parseCommand(content: string): Command | undefined {
  if (content.length > 150 || /\b[A-Za-z]{1,3}\d{5,8}\b/.test(content)) return undefined;
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

function handleConfirm(cmd: Command, sender: Sender, ctx: FlowContext): string {
  const item = cmd.id ? ctx.store.get(cmd.id) : ctx.store.latestDraftBy(sender.id);
  if (!item) return cmd.id ? `Không tìm thấy yêu cầu ${cmd.id}.` : "Không có yêu cầu nào đang chờ anh/chị xác nhận.";
  if (item.status !== "NHAP") return `${item.id} đã được xác nhận trước đó (${STATUS_LABEL[item.status]}).`;
  const approver = ctx.approvers[item.request.origin];
  if (item.requestedBy.id !== sender.id) {
    return `Chỉ ${item.requestedBy.name} (người gửi) xác nhận được ${item.id}. ${approver.name} có thể duyệt luôn: @bot Đồng ý ${item.id}`;
  }

  item.status = "CHO_DUYET";
  ctx.store.save(item);
  return `Đã xác nhận ${item.id} (${ticketsLabel(item.request)}).\n${waitingApprovalText(item, approver)}`;
}

function handleDecision(cmd: Command, sender: Sender, ctx: FlowContext): string {
  const approve = cmd.kind === "approve";
  let item = cmd.id ? ctx.store.get(cmd.id) : undefined;
  if (cmd.id && !item) return `Không tìm thấy yêu cầu ${cmd.id}.`;
  if (!item) {
    // Không ghi mã: lấy yêu cầu đang chờ người này duyệt, nếu chỉ có một.
    const waiting = ctx.store
      .pending()
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
  if (item.status === "DA_DUYET" || item.status === "TU_CHOI") {
    return `${item.id} đã được xử lý trước đó (${STATUS_LABEL[item.status]} bởi ${item.decidedBy}).`;
  }

  // Người duyệt quyết định luôn cả khi người gửi chưa xác nhận form.
  item.status = approve ? "DA_DUYET" : "TU_CHOI";
  item.decidedBy = sender.name;
  item.decidedAt = ctx.now ?? new Date();
  if (cmd.note) item.decisionNote = cmd.note;
  ctx.store.save(item);
  ctx.reports?.push(reportText(item));

  if (!approve) {
    return `❌ ${approver.name} đã từ chối ${item.id} (${ticketsLabel(item.request)}).${cmd.note ? `\nLý do: ${cmd.note}` : ""}`;
  }
  return [
    `✅ ${approver.name} đã đồng ý đổi ${item.id} (${ticketsLabel(item.request)}).`,
    "Bản test: bot CHƯA đổi vé thật trên hệ thống. Khi có API Hoàng Long, bước này sẽ kiểm tra ghế, tính phụ thu và đổi vé.",
  ].join("\n");
}

/** Báo cáo gửi sang nhóm báo cáo khi yêu cầu có kết quả. */
export function reportText(item: StoredRequest): string {
  const approved = item.status === "DA_DUYET";
  return [
    `${approved ? "✅ ĐÃ DUYỆT" : "❌ TỪ CHỐI"} ĐỔI VÉ ${item.id}`,
    "",
    renderForm(item.request),
    "",
    `Người gửi: ${item.requestedBy.name} lúc ${formatVn(item.requestedAt)}`,
    `${approved ? "Người duyệt" : "Người từ chối"}: ${item.decidedBy}${item.decidedAt ? ` lúc ${formatVn(item.decidedAt)}` : ""}`,
    item.decisionNote ? `Ghi chú: ${item.decisionNote}` : undefined,
    item.overdue ? "⚠️ Vé quá hạn" : undefined,
    approved ? "Trạng thái đổi vé trên hệ thống: chưa thực hiện (bản test)" : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function missingInfoReply(errors: string[]): string {
  return ["Yêu cầu đổi vé chưa đủ thông tin:", ...errors.map((e) => `• ${e}`), "", 'Gõ "@bot mẫu" để lấy mẫu.'].join("\n");
}

/** Xử lý nội dung (đã bỏ @bot) và trả về câu trả lời. */
export function respond(content: string, sender: Sender, ctx: FlowContext): string {
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
    return `${item.id}: ${STATUS_LABEL[item.status]}${by}\n\n${renderForm(item.request)}`;
  }

  const cmd = parseCommand(content);
  if (cmd) return cmd.kind === "confirm" ? handleConfirm(cmd, sender, ctx) : handleDecision(cmd, sender, ctx);

  // Mẫu điền đủ: người gửi đã tự kiểm tra, chuyển thẳng cho người duyệt.
  if (looksLikeTemplate(content)) {
    const parsed = parseExchangeRequest(content, now);
    if (!parsed.ok) return missingInfoReply(parsed.errors);
    const item = addRequest(ctx, parsed.request, sender, now, "CHO_DUYET");
    return submittedReply(item, ctx.approvers[parsed.request.origin]);
  }

  // Tin viết tự do: bot soạn form, người gửi xác nhận.
  if (looksLikeFreeText(content)) {
    const parsed = buildRequest(readFreeText(content), now);
    if (!parsed.ok) return missingInfoReply(parsed.errors);
    return draftReply(addRequest(ctx, parsed.request, sender, now, "NHAP"));
  }

  return `Em chưa hiểu yêu cầu. Gõ "@bot help" để xem hướng dẫn.`;
}

function addRequest(
  ctx: FlowContext,
  request: ExchangeRequest,
  sender: Sender,
  now: Date,
  status: RequestStatus,
): StoredRequest {
  return ctx.store.add({
    request,
    requestedBy: sender,
    requestedAt: now,
    chatId: ctx.chatId,
    overdue: request.oldDeparture.getTime() <= now.getTime(),
    status,
  });
}
