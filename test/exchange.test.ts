import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApprovers } from "../src/exchange/approvers.ts";
import { RequestStore, respond } from "../src/exchange/flow.ts";
import { buildRequest, parseExchangeRequest } from "../src/exchange/template.ts";
import { parseCommand } from "../src/exchange/flow.ts";
import { openFileStore } from "../src/file-store.ts";
import { cleanReason, readFreeText } from "../src/exchange/freetext.ts";
import { formatVn, parseVnDateTime } from "../src/exchange/time.ts";
import { routeIdOf } from "../src/exchange/codes.ts";
import { findRoute, parseOrigin } from "../src/exchange/trip.ts";

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

test("đọc giờ ngày theo giờ Việt Nam", async () => {
  const f = (text: string, futureOnly = false) => formatVn(parseVnDateTime(text, now, { futureOnly })!.date);
  assert.equal(f("08:00 30/10/2026"), "08:00 30/10/2026");
  assert.equal(f("30/10 8h30"), "08:30 30/10/2026");
  assert.equal(f("8h 30/10/26"), "08:00 30/10/2026");
  assert.equal(f("16h45"), "16:45 29/10/2026");
  assert.equal(f("9h"), "09:00 29/10/2026");
  assert.equal(f("9h", true), "09:00 30/10/2026");
  assert.equal(parseVnDateTime("mai", now), undefined);
});

test("đọc ngày thiếu năm, thiếu tháng, viết bằng chữ", async () => {
  // now = 14:47 29/10/2026
  const f = (text: string, futureOnly = false, at = now) => formatVn(parseVnDateTime(text, at, { futureOnly })!.date);
  assert.equal(f("7h ngày 15"), "07:00 15/10/2026");
  assert.equal(f("7h ngày 15", true), "07:00 15/11/2026");
  assert.equal(f("ngày 2 7h", true), "07:00 02/11/2026");
  assert.equal(f("ng 30 18h", true), "18:00 30/10/2026");
  assert.equal(f("8h 15 tháng 11"), "08:00 15/11/2026");
  assert.equal(f("8h ngày 15 thg 11 năm 2026"), "08:00 15/11/2026");
  assert.equal(f("10-11-2026 7h"), "07:00 10/11/2026");
  // Cuối năm ghi 02/01 là năm sau, đầu năm ghi 28/12 là năm trước.
  const dec30 = new Date(Date.UTC(2026, 11, 30, 3));
  assert.equal(f("8h 02/01", true, dec30), "08:00 02/01/2027");
  assert.equal(f("8h ngày 3", true, dec30), "08:00 03/01/2027");
  const jan2 = new Date(Date.UTC(2027, 0, 2, 3));
  assert.equal(f("8h 28/12", false, jan2), "08:00 28/12/2026");
  assert.equal(parseVnDateTime("8h 31/11", now), undefined);
});

test("TP, Trần Phú là Hà Đông; chuyến không ghi ngày lấy cùng ngày chuyến kia", async () => {
  const r = buildRequest(readFreeText("A711655 đổi chuyến 7h TP-HP ngày 15/11 sang chuyến 11h"), now);
  assert.ok(r.ok);
  assert.equal(r.request.origin, "HA_NOI");
  assert.equal(formatVn(r.request.oldDeparture), "07:00 15/11/2026");
  assert.equal(formatVn(r.request.newDeparture), "11:00 15/11/2026");
  assert.ok(r.request.assumptions.some((a) => a.includes("cùng ngày với chuyến cũ")));
  assert.equal(routeIdOf("Trần Phú - Hải Phòng"), 14);
  assert.equal(routeIdOf("HP-TP"), 13);
});

test("HP = Hải Phòng, HN = Hà Nội, HĐ = Hà Đông, viết kiểu nào cũng hiểu", () => {
  for (const s of ["HP", "Hải Phòng", "hải phòng", "Hai Phong", "Haiphong", "H.Phòng", "từ Hải Phòng"]) assert.equal(parseOrigin(s), "HAI_PHONG", s);
  for (const s of ["HN", "Hà Nội", "Ha Noi", "Hanoi", "HaNoi", "H.Noi", "68 TND", "Trần Nhật Duật", "68 Trần Nhật Duật", "HĐ", "HÐ", "Hà Đông", "Ha Dong", "H.Đông"]) assert.equal(parseOrigin(s), "HA_NOI", s);
  assert.equal(routeIdOf("Hà Nội - Hải Phòng"), 11);
  assert.equal(routeIdOf("HN đi HP"), 11);
  assert.equal(routeIdOf("Hải Phòng về Hà Nội"), 12);
  assert.equal(routeIdOf("HP > Hà Đông"), 13);
  assert.equal(routeIdOf("Hà Đông/HP"), 14);
  assert.equal(routeIdOf("HÐ-HP"), 14);
  assert.equal(routeIdOf("68 TND - HP"), 11);
  assert.equal(routeIdOf("Hải Phòng - Trần Nhật Duật"), 12);
  assert.equal(findRoute("A711655 7h Haiphong-Hanoi ngày 15/11")?.text, "Haiphong-Hanoi");
});

test("tên tài khoản phụ thu lấy từ \"vào tài khoản ...\", \"cho ...\"", () => {
  const acc = (t: string) => readFreeText(`đổi vé A323857 7h HN-HP sang 11h ${t}`);
  assert.equal(acc("phụ thu 100k vào tài khoản trangph-it").surchargeAccount, "trangph-it");
  assert.equal(acc("phụ thu 100k vào trangph-it").surchargeAccount, "trangph-it");
  assert.equal(acc("phụ thu 100k vào tk ngocanh (khách bận)").surchargeAccount, "ngocanh");
  const late = acc("vì khách bận, phụ thu 50k. Cho lanhnt-dhtt");
  assert.equal(late.surchargeAccount, "lanhnt-dhtt");
  assert.equal(late.reason, "khách bận");
  const far = acc("phụ thu 100k, vào tài khoản trangph-it vì khách bận");
  assert.equal(far.surchargeAccount, "trangph-it");
  assert.equal(far.reason, "khách bận");
  assert.equal(acc("cho khách, phụ thu 50k").surchargeAccount, undefined);
  assert.equal(acc("vào tài khoản của khách, phụ thu 50k").surchargeAccount, undefined);
});

test("\"lên chuyến\", \"xuống chuyến\" tách chuyến cũ và mới; bỏ @nhắc trong lý do", () => {
  const f = readFreeText(
    "đổi vé mã vé A718934  chuyến 17h HN-HP ngày 17/11 ghế 6A lên chuyến 16h HN-HP ngày 17/11 ghế 4 , do khách đi khám bệnh đã xong xin đổi vé lên  chuyến sớm để đi về luôn @Đet Vit",
  );
  assert.equal(f.oldDeparture, "17h 17/11 HN-HP");
  assert.equal(f.newDeparture, "16h 17/11 HN-HP");
  assert.equal(f.oldSeat, "6A");
  assert.equal(f.newSeat, "4");
  assert.equal(f.reason, "khách đi khám bệnh đã xong xin đổi vé lên chuyến sớm để đi về luôn");
  const later = readFreeText("A718934 đổi vé chuyến 9h HP-HN xuống chuyến 11h");
  assert.equal(later.oldDeparture, "9h HP-HN");
  assert.equal(later.newDeparture, "11h");
});

test("mã vé là chữ A + 6 số; tuyến ghi cách nhau dấu cách (hp hn)", () => {
  const f = readFreeText("Đổi giúp a 2mã vé hp hn 21h lên chuyến 5h30 hp hdong A720374 và A722698");
  assert.equal(f.ticketCodes, "A720374, A722698");
  assert.equal(f.oldDeparture, "21h hp hn");
  assert.equal(f.newDeparture, "5h30 hp hdong");
  assert.equal(routeIdOf("hp hn"), 12);
  assert.equal(routeIdOf("hp hdong"), 13);
  assert.equal(readFreeText("đổi vé B720374 HL12345 a7203741 sang 16h HN-HP").ticketCodes, undefined);
  assert.equal(readFreeText("đổi vé a720374 sang 16h HN-HP").ticketCodes, "A720374");
});

test("đọc mẫu đổi vé đủ thông tin", async () => {
  const r = parseExchangeRequest(sample("Hải Phòng"), now);
  assert.ok(r.ok);
  assert.deepEqual(r.request.ticketCodes, ["HL123"]);
  assert.equal(r.request.origin, "HAI_PHONG");
  assert.equal(r.request.newSeat, "B5");
});

test("báo thiếu thông tin", async () => {
  const r = parseExchangeRequest("ĐỔI VÉ\nMã vé: X\nĐiểm đi: Đà Nẵng", now);
  assert.ok(!r.ok);
  // Điểm đi sai, thiếu chuyến mới. Chuyến cũ không bắt buộc (bot lấy từ hệ thống).
  assert.equal(r.errors.length, 2);
});

test("vé Hải Phòng chờ Ms Ngọc Anh, người khác không duyệt được", async () => {
  const c = ctx();
  const reply = await respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c);
  assert.match(reply, /YC001/);
  assert.match(reply, /Chờ Ms Ngọc Anh duyệt/);
  assert.match(await respond("Đồng ý YC001", { id: "u1", name: "Trang" }, c), /chỉ Ms Ngọc Anh được duyệt/);
  assert.match(await respond("đồng ý yc001", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC001/);
  assert.match(await respond("xem YC001", { id: "u1", name: "Trang" }, c), /đã duyệt bởi Ngoc Anh/);
});

test("vé Hà Nội chờ Mr Thanh Việt, tạm nhận theo tên khi chưa cấu hình id", async () => {
  const c = ctx();
  await respond(sample("HN"), { id: "u1", name: "Trang" }, c);
  assert.match(
    await respond("Từ chối YC001 hết ghế", { id: "u9", name: "Thanh Việt" }, c),
    /Mr Thanh Việt đã từ chối YC001[\s\S]*Lý do: hết ghế/,
  );
});

test("chuyến cũ quá giờ trong ngày vẫn nhận, có cảnh báo đỏ; quá giờ từ ngày trước thì không nhận", async () => {
  const reply = await respond(sample("Hải Phòng", "08:00 29/10/2026"), { id: "u1", name: "Trang" }, ctx());
  assert.match(reply, /🔴 CHUYẾN CŨ ĐÃ QUÁ GIỜ/);
  const old = await respond(sample("Hải Phòng", "08:00 28/10/2026"), { id: "u1", name: "Trang" }, ctx());
  assert.match(old, /đã chạy từ ngày trước, không đổi được \(chuyến cũ chỉ được quá giờ trong cùng ngày\)/);
});

test("đọc tin viết tự do thành form, người gửi xác nhận rồi mới tới người duyệt", async () => {
  // 14:47 29/10/2026 giờ Việt Nam
  const c = { ...ctx(), approvers: loadApprovers({ APPROVER_HA_NOI_IDS: "id-viet" }), now: new Date(Date.UTC(2026, 9, 29, 7, 47)) };
  const msg =
    "@Nguyễn Thanh Việt A711655 A714050 A723183 , anh đổi giúp em 3 mã vé này chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP ạ ( xe TC đón khách không về kịp xin hỗ trợ đổi chuyến , em đã gọi khách ạ )";
  const draft = await respond(msg, { id: "u1", name: "Trang" }, c);
  assert.match(draft, /Mã vé: A711655, A714050, A723183/);
  assert.match(draft, /Điểm đi: Hà Nội/);
  assert.match(draft, /Chuyến cũ: 16:45 29\/10\/2026 HĐ-HP/);
  assert.match(draft, /Chuyến mới: 18:00 29\/10\/2026 HN-HP/);
  assert.match(draft, /Lý do: xe TC đón khách không về kịp xin hỗ trợ đổi chuyến\n/);
  assert.match(draft, /@bot Xác nhận/);

  assert.match(await respond("Xác nhận", { id: "u2", name: "Lan" }, c), /Không có yêu cầu/);
  assert.match(await respond("xác nhận", { id: "u1", name: "Trang" }, c), /Chờ Mr Thanh Việt duyệt/);
  assert.match(await respond("Đồng ý YC001", { id: "id-viet", name: "Nguyễn Thanh Việt" }, c), /đã đồng ý đổi YC001 \(3 vé/);
});

test("form bot soạn ra gửi lại được như mẫu", async () => {
  const c = ctx();
  const draft = await respond("A711655 đổi chuyến 7h 30/10 HP-HN sang 9h 30/10 HP-HN", { id: "u1", name: "Trang" }, c);
  const form = draft.split("\n\n")[1];
  const resent = await respond(form, { id: "u1", name: "Trang" }, c);
  assert.match(resent, /Đã nhận yêu cầu YC002/);
  assert.match(resent, /Chờ Ms Ngọc Anh duyệt/);
});

test("lý do chỉ giữ nội dung chính", async () => {
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
  await respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c);

  const reloaded = { ...c, store: openFileStore(file) };
  assert.match(await respond("Đồng ý YC001 khách quen", { id: "id-ngoc-anh", name: "Ngoc Anh" }, reloaded), /đã đồng ý/);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /ĐÃ DUYỆT ĐỔI VÉ YC001[\s\S]*Người duyệt: Ngoc Anh[\s\S]*Ghi chú: khách quen/);
  assert.equal(openFileStore(file).get("YC001")?.status, "DA_DUYET");
  assert.equal(openFileStore(file).get("YC001")?.requestedAt.getTime(), now.getTime());
  await respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, { ...c, store: openFileStore(file) });
  assert.ok(openFileStore(file).get("YC002"));
});

test("hiểu hôm nay / ngày mai và báo khi ngày ghi mâu thuẫn", async () => {
  // 15:09 29/10/2026 giờ Việt Nam
  const c = { ...ctx(), now: new Date(Date.UTC(2026, 9, 29, 8, 9)) };
  const ok = await respond("đổi giúp mã vé A715964 chuyến 18h HN-HP hôm nay sang ngày mai chuyến 18h HN-HP, do khách nhìn nhầm ngày", { id: "u1", name: "Trang" }, c);
  assert.match(ok, /Chuyến cũ: 18:00 29\/10\/2026 HN-HP/);
  assert.match(ok, /Chuyến mới: 18:00 30\/10\/2026 HN-HP/);
  assert.match(ok, /Lý do: khách nhìn nhầm ngày/);

  const conflict = await respond("hỗ trợ đổi giúp chị mã vé khứu hồi này A715964 chuyến 18h HN-HP hôm nay sang ngày mai 29/10 chuyến 18h HN-HP, do khách báo nhìn nhầm ngày", { id: "u1", name: "Trang" }, c);
  assert.match(conflict, /Chuyến mới trùng chuyến cũ/);
  assert.match(conflict, /ghi "ngày mai" nhưng lại ghi ngày 29\/10/);
});

test("hiểu lệnh ngắn, mã YC trước hay sau đều được", async () => {
  assert.deepEqual(parseCommand("YC001 xác nhận"), { kind: "confirm", id: "YC001", note: "" });
  assert.deepEqual(parseCommand("xác nhận"), { kind: "confirm", id: undefined, note: "" });
  assert.deepEqual(parseCommand("đồng ý YC001"), { kind: "approve", id: "YC001", note: "" });
  assert.deepEqual(parseCommand("yc 1 ok"), { kind: "approve", id: "YC001", note: "" });
  assert.deepEqual(parseCommand("Từ chối YC002, hết ghế"), { kind: "reject", id: "YC002", note: "hết ghế" });
  assert.deepEqual(parseCommand("YC002 không đồng ý vì xe đầy"), { kind: "reject", id: "YC002", note: "vì xe đầy" });
  assert.equal(parseCommand("A711655 đổi chuyến 16h sang 18h, ok"), undefined);
});

test("người duyệt đồng ý luôn khi người gửi chưa xác nhận; không ghi mã thì lấy yêu cầu đang chờ", async () => {
  const reports: string[] = [];
  const c = { ...ctx(), reports };
  await respond(sample("Hải Phòng"), { id: "u1", name: "Trang" }, c); // YC001 chờ duyệt (mẫu)
  await respond("A711655 đổi chuyến 7h 30/10 HP-HN sang 9h 30/10 HP-HN", { id: "u1", name: "Trang" }, c); // YC002 nháp
  assert.match(await respond("YC002 xác nhận", { id: "u9", name: "Tyra" }, c), /Chỉ Trang \(người gửi\)[\s\S]*Đồng ý YC002/);
  assert.match(await respond("đồng ý", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /2 yêu cầu chờ duyệt \(YC001, YC002\)/);
  assert.match(await respond("YC002 đồng ý", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC002/);
  assert.match(await respond("ok", { id: "id-ngoc-anh", name: "Ngoc Anh" }, c), /đã đồng ý đổi YC001/);
  assert.equal(reports.length, 2);
});

test("nhận các từ đồng nghĩa với đổi vé: chuyển vé, sửa vé, dời chuyến, lùi chuyến", async () => {
  const { looksLikeFreeText } = await import("../src/exchange/freetext.ts");
  const { looksLikeTemplate } = await import("../src/exchange/template.ts");
  for (const t of [
    "A711655 chuyển vé chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP",
    "Chuyển A711655 từ 16h45 HĐ-HP sang 18h",
    "sửa vé A711655 16h45 HĐ-HP sang 18h",
    "A711655 dời chuyến 16h45 HĐ-HP sang 18h",
    "A711655 lùi chuyến 16h45 HĐ-HP sang 18h",
    "A711655 chuyen ve 16h45 HD-HP sang 18h",
    "A711655 ĐỔI VÉ 16h45 HĐ-HP sang 18h",
  ]) assert.ok(looksLikeFreeText(t), t);
  // "chuyến" (có dấu sắc) không phải từ khóa
  assert.ok(!looksLikeFreeText("A711655 chuyến 16h45 HĐ-HP đã đón khách"));
  assert.ok(looksLikeTemplate("CHUYỂN VÉ\nMã vé A711655"));
  assert.ok(looksLikeTemplate("Sửa vé\nTên khách: An"));
  const r = buildRequest(readFreeText("Chuyển vé A711655 chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP (khách bận)"), now);
  assert.ok(r.ok);
  assert.deepEqual(r.request.ticketCodes, ["A711655"]);
});

test("chuyến mới được phép đã chạy tối đa 50 phút", async () => {
  // 10:10 12/11/2026 giờ Việt Nam
  const at = new Date(Date.UTC(2026, 10, 12, 3, 10));
  const req = (newTrip: string) => buildRequest(readFreeText(`A711655 đổi chuyến 7h HĐ-HP ngày 12/11 sang chuyến ${newTrip} HN-HP`), at);
  const ok920 = req("9h20");
  assert.ok(ok920.ok);
  assert.equal(formatVn(ok920.request.newDeparture), "09:20 12/11/2026");
  // Quá 50 phút vẫn nhận yêu cầu, chỉ cảnh báo đỏ (xem test bên dưới)
  assert.ok(req("9h19").ok);
  // Không ghi ngày: 9h25 vẫn là hôm nay, 9h là ngày mai
  assert.equal(formatVn(parseVnDateTime("9h25", at, { futureOnly: true })!.date), "09:25 12/11/2026");
  assert.equal(formatVn(parseVnDateTime("9h", at, { futureOnly: true })!.date), "09:00 13/11/2026");
});

test("khi yêu cầu chờ duyệt, bot nhắn riêng cho người duyệt", async () => {
  const notices: { chatId: string; text: string }[] = [];
  const c = { ...ctx(), approvers: loadApprovers({ APPROVER_HA_NOI_IDS: "id-viet" }), now: new Date(Date.UTC(2026, 9, 29, 7, 47)), notices };
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP (khách bận)", { id: "u1", name: "Trang" }, c);
  assert.equal(notices.length, 0, "bản nháp chưa báo người duyệt");
  await respond("xác nhận", { id: "u1", name: "Trang" }, c);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].chatId, "id-viet");
  assert.match(notices[0].text, /YC001 \(vé A711655\) của Trang đang chờ Mr Thanh Việt duyệt/);
  assert.match(notices[0].text, /@bot Đồng ý YC001/);
});

test("chuyến cũ hoặc chuyến mới quá giờ: cảnh báo đỏ, người duyệt đồng ý thì vẫn duyệt", async () => {
  // 10:10 12/11/2026 giờ Việt Nam
  const c = { ...ctx(), approvers: loadApprovers({ APPROVER_HA_NOI_IDS: "id-viet" }), now: new Date(Date.UTC(2026, 10, 12, 3, 10)) };
  // Chuyến mới 8h39 đã chạy quá 1 tiếng 30 phút: không nhận
  assert.match(
    await respond("A711655 đổi chuyến 7h HĐ-HP ngày 12/11 sang chuyến 8h39 HN-HP ngày 12/11", { id: "u1", name: "Trang" }, c),
    /đã chạy quá 1 tiếng 30 phút, không đổi được sang chuyến này/,
  );
  const draft = await respond("A711655 đổi chuyến 7h HĐ-HP ngày 12/11 sang chuyến 8h50 HN-HP ngày 12/11 (khách lỡ xe)", { id: "u1", name: "Trang" }, c);
  assert.match(draft, /🔴 CHUYẾN CŨ ĐÃ QUÁ GIỜ/);
  assert.match(draft, /🔴 CHUYẾN MỚI ĐÃ QUÁ GIỜ \(đã chạy hơn 50 phút\)/);
  assert.match(draft, /🔴 Quy định: chuyến mới chỉ được quá giờ tối đa 1 tiếng 30 phút, còn chuyến cũ chỉ được quá giờ trong cùng ngày\./);
  assert.match(await respond("xác nhận", { id: "u1", name: "Trang" }, c), /Chờ Mr Thanh Việt duyệt/);
  const done = await respond("đồng ý YC001", { id: "id-viet", name: "Việt" }, c);
  assert.doesNotMatch(done, /không|lỗi/i);
  assert.equal(c.store.get("YC001")?.status, "DA_DUYET");
});
