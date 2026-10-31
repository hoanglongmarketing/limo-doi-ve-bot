import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApprovers } from "../src/exchange/approvers.ts";
import { RequestStore, respond } from "../src/exchange/flow.ts";
import { parseExchangeRequest } from "../src/exchange/template.ts";
import { parseCommand } from "../src/exchange/flow.ts";
import { openFileStore } from "../src/file-store.ts";
import { cleanReason } from "../src/exchange/freetext.ts";
import { formatVn, parseVnDateTime } from "../src/exchange/time.ts";

// 10:00 29/10/2026 giờ Việt Nam
const now = new Date(Date.UTC(2026, 9, 29, 3, 0));

const sample = (origin: string, oldTrip = "08:00 30/10/2026") =>
  [
    "ĐỔI VÉ",
    "Mã vé: hl123",
    "Tên khách: Nguyễn Văn A",
    "SĐT khách: 0912345678",
    `Điểm đi: ${origin}`,
    `Chuyến cũ: ${oldTrip}`,
    "Ghế cũ: A3",
    "Chuyến mới: 14:00 30/10",
    "Ghế mới: B5",
    "Lý do: Khách bận",
  ].join("\n");

const ctx = () => ({
  store: new RequestStore(),
  approvers: loadApprovers({ APPROVER_HAI_PHONG_IDS: "id-ngoc-anh" }),
  now,
});

test("đọc giờ ngày theo giờ Việt Nam", () => {
  const f = (text: string, futureOnly = false) => formatVn(parseVnDateTime(text, now, { futureOnly })!.date);
  assert.equal(f("08:00 30/10/2026"), "08:00 30/10/2026");
  assert.equal(f("30/10 8h30"), "08:30 30/10/2026");
  assert.equal(f("8h 30/10/26"), "08:00 30/10/2026");
  assert.equal(f("16h45"), "16:45 29/10/2026");
  assert.equal(f("9h"), "09:00 29/10/2026");
  assert.equal(f("9h", true), "09:00 30/10/2026");
  assert.equal(parseVnDateTime("mai", now), undefined);
});

test("đọc mẫu đổi vé đủ thông tin", () => {
  const r = parseExchangeRequest(sample("Hải Phòng"), now);
  assert.ok(r.ok);
  assert.deepEqual(r.request.ticketCodes, ["HL123"]);
  assert.equal(r.request.origin, "HAI_PHONG");
  assert.equal(r.request.newSeat, "B5");
});

test("báo thiếu thông tin", () => {
  const r = parseExchangeRequest("ĐỔI VÉ\nMã vé: X\nĐiểm đi: Đà Nẵng", now);
  assert.ok(!r.ok);
  assert.equal(r.errors.length, 3);
});

test("vé Hải Phòng chờ Ms Ngọc Anh, người khác không duyệt được", () => {
  const c = ctx();
  const reply = respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c);
  assert.match(reply, /YC001/);
  assert.match(reply, /Chờ Ms Ngọc Anh duyệt/);
  assert.match(respond("Đồng ý YC001", { id: "u1", name: "Trang" }, c), /chỉ Ms Ngọc Anh được duyệt/);
  assert.match(respond("đồng ý yc001", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC001/);
  assert.match(respond("xem YC001", { id: "u1", name: "Trang" }, c), /đã duyệt bởi Ngoc Anh/);
});

test("vé Hà Nội chờ Mr Thanh Việt, tạm nhận theo tên khi chưa cấu hình id", () => {
  const c = ctx();
  respond(sample("HN"), { id: "u1", name: "Trang" }, c);
  assert.match(
    respond("Từ chối YC001 hết ghế", { id: "u9", name: "Thanh Việt" }, c),
    /Mr Thanh Việt đã từ chối YC001[\s\S]*Lý do: hết ghế/,
  );
});

test("vé quá hạn vẫn nhận, có cảnh báo", () => {
  const reply = respond(sample("Hải Phòng", "08:00 28/10/2026"), { id: "u1", name: "Trang" }, ctx());
  assert.match(reply, /QUÁ HẠN/);
});

test("đọc tin viết tự do thành form, người gửi xác nhận rồi mới tới người duyệt", () => {
  // 14:47 29/10/2026 giờ Việt Nam
  const c = { ...ctx(), approvers: loadApprovers({ APPROVER_HA_NOI_IDS: "id-viet" }), now: new Date(Date.UTC(2026, 9, 29, 7, 47)) };
  const msg =
    "@Nguyễn Thanh Việt A711655 A714050 A723183 , anh đổi giúp em 3 mã vé này chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP ạ ( xe TC đón khách không về kịp xin hỗ trợ đổi chuyến , em đã gọi khách ạ )";
  const draft = respond(msg, { id: "u1", name: "Trang" }, c);
  assert.match(draft, /Mã vé: A711655, A714050, A723183/);
  assert.match(draft, /Điểm đi: Hà Nội/);
  assert.match(draft, /Chuyến cũ: 16:45 29\/10\/2026 HĐ-HP/);
  assert.match(draft, /Chuyến mới: 18:00 29\/10\/2026 HN-HP/);
  assert.match(draft, /Lý do: xe TC đón khách không về kịp xin hỗ trợ đổi chuyến\n/);
  assert.match(draft, /@bot Xác nhận/);

  assert.match(respond("Xác nhận", { id: "u2", name: "Lan" }, c), /Không có yêu cầu/);
  assert.match(respond("xác nhận", { id: "u1", name: "Trang" }, c), /Chờ Mr Thanh Việt duyệt/);
  assert.match(respond("Đồng ý YC001", { id: "id-viet", name: "Nguyễn Thanh Việt" }, c), /đã đồng ý đổi YC001 \(3 vé/);
});

test("form bot soạn ra gửi lại được như mẫu", () => {
  const c = ctx();
  const draft = respond("A711655 đổi chuyến 7h 30/10 HP-HN sang 9h 30/10 HP-HN", { id: "u1", name: "Trang" }, c);
  const form = draft.split("\n\n")[1];
  const resent = respond(form, { id: "u1", name: "Trang" }, c);
  assert.match(resent, /Đã nhận yêu cầu YC002/);
  assert.match(resent, /Chờ Ms Ngọc Anh duyệt/);
});

test("lý do chỉ giữ nội dung chính", () => {
  assert.equal(cleanReason(" xe TC đón khách không về kịp xin hỗ trợ đổi chuyến , em đã gọi khách ạ "), "xe TC đón khách không về kịp xin hỗ trợ đổi chuyến");
  assert.equal(cleanReason("khách bận việc đột xuất nhé, cảm ơn anh"), "khách bận việc đột xuất");
  assert.equal(cleanReason("xe hỏng, e đã báo khách rồi ạ"), "xe hỏng");
});

test("lưu ra file, khởi động lại vẫn còn, có báo cáo khi duyệt", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "doive-")), "requests.json");
  const reports: string[] = [];
  const c = { store: openFileStore(file), approvers: loadApprovers({ APPROVER_HAI_PHONG_IDS: "id-ngoc-anh" }), now, reports };
  respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c);

  const reloaded = { ...c, store: openFileStore(file) };
  assert.match(respond("Đồng ý YC001 khách quen", { id: "id-ngoc-anh", name: "Ngoc Anh" }, reloaded), /đã đồng ý/);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /ĐÃ DUYỆT ĐỔI VÉ YC001[\s\S]*Người duyệt: Ngoc Anh[\s\S]*Ghi chú: khách quen/);
  assert.equal(openFileStore(file).get("YC001")?.status, "DA_DUYET");
  assert.equal(openFileStore(file).get("YC001")?.requestedAt.getTime(), now.getTime());
  respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, { ...c, store: openFileStore(file) });
  assert.ok(openFileStore(file).get("YC002"));
});

test("hiểu hôm nay / ngày mai và báo khi ngày ghi mâu thuẫn", () => {
  // 15:09 29/10/2026 giờ Việt Nam
  const c = { ...ctx(), now: new Date(Date.UTC(2026, 9, 29, 8, 9)) };
  const ok = respond("đổi giúp mã vé A715964 chuyến 18h HN-HP hôm nay sang ngày mai chuyến 18h HN-HP, do khách nhìn nhầm ngày", { id: "u1", name: "Trang" }, c);
  assert.match(ok, /Chuyến cũ: 18:00 29\/10\/2026 HN-HP/);
  assert.match(ok, /Chuyến mới: 18:00 30\/10\/2026 HN-HP/);
  assert.match(ok, /Lý do: khách nhìn nhầm ngày/);

  const conflict = respond("hỗ trợ đổi giúp chị mã vé khứu hồi này A715964 chuyến 18h HN-HP hôm nay sang ngày mai 29/10 chuyến 18h HN-HP, do khách báo nhìn nhầm ngày", { id: "u1", name: "Trang" }, c);
  assert.match(conflict, /Chuyến mới trùng chuyến cũ/);
  assert.match(conflict, /ghi "ngày mai" nhưng lại ghi ngày 29\/10/);
});

test("hiểu lệnh ngắn, mã YC trước hay sau đều được", () => {
  assert.deepEqual(parseCommand("YC001 xác nhận"), { kind: "confirm", id: "YC001", note: "" });
  assert.deepEqual(parseCommand("xác nhận"), { kind: "confirm", id: undefined, note: "" });
  assert.deepEqual(parseCommand("đồng ý YC001"), { kind: "approve", id: "YC001", note: "" });
  assert.deepEqual(parseCommand("yc 1 ok"), { kind: "approve", id: "YC001", note: "" });
  assert.deepEqual(parseCommand("Từ chối YC002, hết ghế"), { kind: "reject", id: "YC002", note: "hết ghế" });
  assert.deepEqual(parseCommand("YC002 không đồng ý vì xe đầy"), { kind: "reject", id: "YC002", note: "vì xe đầy" });
  assert.equal(parseCommand("A711655 đổi chuyến 16h sang 18h, ok"), undefined);
});

test("người duyệt đồng ý luôn khi người gửi chưa xác nhận; không ghi mã thì lấy yêu cầu đang chờ", () => {
  const reports: string[] = [];
  const c = { ...ctx(), reports };
  respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c); // YC001 chờ duyệt (mẫu)
  respond("A711655 đổi chuyến 7h 30/10 HP-HN sang 9h 30/10 HP-HN", { id: "u1", name: "Trang" }, c); // YC002 nháp
  assert.match(respond("YC002 xác nhận", { id: "u9", name: "Tyra" }, c), /Chỉ Trang \(người gửi\)[\s\S]*Đồng ý YC002/);
  assert.match(respond("đồng ý", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /2 yêu cầu chờ duyệt \(YC001, YC002\)/);
  assert.match(respond("YC002 đồng ý", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC002/);
  assert.match(respond("ok", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC001/);
  assert.equal(reports.length, 2);
});
