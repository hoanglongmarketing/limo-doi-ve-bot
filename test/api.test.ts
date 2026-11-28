import { looksLikeInvoice } from "../src/exchange/invoice.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApprovers } from "../src/exchange/approvers.ts";
import { RequestStore, respond } from "../src/exchange/flow.ts";
import { readFreeText } from "../src/exchange/freetext.ts";
import { routeIdOf, seatLabel, seatNumber } from "../src/exchange/codes.ts";
import { apiDate, type ChangeInput, type HoangLongApi, type ShiftInfo, type TicketResult } from "../src/hl/api.ts";

// 14:47 29/10/2026 giờ Việt Nam
const now = new Date(Date.UTC(2026, 9, 29, 7, 47));

interface FakeTicket {
  type: string;
  seat: number;
  date: string;
  start: string;
  allowed: boolean;
  message?: string;
  surcharge: number;
}

/** API giả: giữ ghế trống, ghi lại các lần đổi vé. */
function fakeApi(opts: { shifts?: ShiftInfo[]; tickets?: Record<string, FakeTicket>; free?: number[] } = {}) {
  const free = new Set(opts.free ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const tickets: Record<string, FakeTicket> = opts.tickets ?? {};
  const shifts = opts.shifts ?? [{ ShiftID: 3740, ShiftName: "18:00", FreeSeat: free.size, IsExtra: false }];
  const changes: ChangeInput[] = [];
  const shiftCalls: unknown[][] = [];
  const taxes: string[] = [];
  let failNextChange = false;

  const result = (code: string, seat?: number): TicketResult => {
    const t = tickets[code];
    if (!t) return { Status: false, Message: "Không tìm thấy vé", FreeSeats: [...free], StartTime: "18:00", Surcharge: 0, TicketInfo: null };
    const seatOk = seat === undefined || seat === 0 || free.has(seat);
    return {
      Status: t.allowed && seatOk && seat !== 0 && seat !== undefined,
      Message: !t.allowed ? t.message ?? "Không được đổi" : !seatOk ? "Ghế đã bán" : seat ? "Vé được phép đổi chuyến. Chưa phụ thu" : "Chưa chọn ghế",
      FreeSeats: [...free],
      StartTime: "18:00",
      Surcharge: t.allowed ? t.surcharge : 0,
      TicketInfo: { ChangeTicketNote: "", Date: t.date, OrderNumber: code, RouterName: "Hà Đông - Hải Phòng LIMO", Seat: t.seat, StartTime: t.start, TicketType: t.type },
    };
  };

  const api: HoangLongApi = {
    async getShifts(date, routerId, startTime) {
      shiftCalls.push([apiDate(date), routerId, startTime]);
      return shifts.length ? { Status: true, Message: "ok", ShiftInfo: shifts } : { Status: false, Message: "Không tìm thấy chuyến.", ShiftInfo: [] };
    },
    async getUser(user) {
      return user === "ngannn-tn"
        ? { Status: true, Exists: true, FullName: "Nguyễn Ngân", IsBlocked: false, Message: "Tài khoản đang hoạt động." }
        : { Status: false, Exists: false, FullName: null, IsBlocked: false, Message: "Tài khoản không tồn tại." };
    },
    async checkTicket(code, _date, _shift, seat) {
      return result(code, seat);
    },
    async markTicketTax(code) {
      taxes.push(code);
      return code === "A000001"
        ? { Status: false, Message: "Mã vé không có đầy đủ thông tin công ty: tên công ty, địa chỉ công ty, mã số thuế" }
        : { Status: true, Message: "Đánh dấu vé hóa đơn thành công" };
    },
    async changeTicket(input) {
      if (failNextChange) {
        failNextChange = false;
        // Hệ thống đã đổi nhưng bot không nhận được trả lời.
        applyChange(input);
        throw new Error("timeout");
      }
      const r = result(input.orderNumber, input.seat);
      if (!r.Status) return { ...r, TicketInfo: null };
      applyChange(input);
      return { Status: true, Message: `Vé ${input.orderNumber} đổi chuyến thành công`, FreeSeats: null, StartTime: null, Surcharge: 0, TicketInfo: null };
    },
  };
  function applyChange(input: ChangeInput) {
    changes.push(input);
    free.delete(input.seat);
    const t = tickets[input.orderNumber];
    Object.assign(t, { seat: input.seat, date: apiDate(input.date), start: "18:00", allowed: false, message: "Vé đã đổi chuyến" });
  }
  return { api, changes, shiftCalls, taxes, free, failChange: () => (failNextChange = true) };
}

const trang = { id: "u1", name: "Trang" };
const viet = { id: "id-viet", name: "Nguyễn Thanh Việt" };
const ctxWith = (api: HoangLongApi, reports: string[] = []) => ({
  store: new RequestStore(),
  approvers: loadApprovers({ APPROVER_HA_NOI_IDS: "id-viet" }),
  now,
  api,
  reports,
});

const ticket = (type: string, seat: number, surcharge: number, extra: Partial<FakeTicket> = {}): FakeTicket => ({
  type,
  seat,
  surcharge,
  date: "29-10-2026",
  start: "16:45",
  allowed: true,
  ...extra,
});

test("mã tuyến và ghế theo quy ước Hoàng Long", () => {
  assert.equal(routeIdOf("HN-HP"), 11);
  assert.equal(routeIdOf("HP - HN"), 12);
  assert.equal(routeIdOf("HP-HĐ"), 13);
  assert.equal(routeIdOf("HĐ-HP"), 14);
  assert.equal(routeIdOf("HN-HĐ"), undefined);
  assert.equal(seatNumber("5A"), 10);
  assert.equal(seatNumber("6a"), 11);
  assert.equal(seatNumber("12"), undefined);
  assert.equal(seatLabel(11), "6A");
});

test("kiểm tra vé qua API, vé lỗi để lại, người duyệt chọn thu phụ thu rồi bot đổi vé", async () => {
  const fake = fakeApi({
    tickets: {
      A711655: ticket("Vé khứ hồi", 4, 160000),
      A714050: ticket("Vé thường", 7, 0),
      A723183: ticket("Vé thường", 8, 0, { allowed: false, message: "Vé đã đổi chuyến ngoài quy định 1 lần, không thể đổi tiếp" }),
    },
    free: [1, 2, 3, 5, 7, 9],
  });
  const reports: string[] = [];
  const c = ctxWith(fake.api, reports);
  const draft = await respond(
    "A711655 A714050 A723183 , anh đổi giúp em 3 mã vé này chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP ạ (khách bận)",
    trang,
    c,
  );
  assert.deepEqual(fake.shiftCalls[0], ["29-10-2026", 11, "18:00"]);
  assert.match(draft, /📝 Em đã soạn yêu cầu ĐỔI VÉ YC001/);
  assert.match(draft, /🚐 Chuyến mới: 18:00 ngày 29-10-2026 HN-HP, còn 6 ghế trống/);
  assert.match(draft, /📝 Lý do: khách bận\n/);
  assert.match(draft, /✅ Mã vé: A711655 \(Vé khứ hồi, ghế cũ 4\)/);
  assert.match(draft, /✅ Mã vé: A714050 \(Vé thường, ghế cũ 7\)/);
  assert.match(draft, /💺 Ghế mới: A711655 ghế 3 \(phụ thu 160\.000đ\); A714050 ghế 1 \(không phụ thu\)/);
  assert.match(draft, /❌ Mã vé: A723183 \(Vé thường\): Vé đã đổi chuyến ngoài quy định 1 lần, không thể đổi tiếp → để lại/);
  assert.match(draft, /💰 Phụ thu: tổng 160\.000đ \(theo hệ thống\)/);
  assert.match(draft, /💳 Phụ thu bởi: \(chưa có\)/);
  // Form đầy đủ để sao chép, sửa (tin riêng ngay sau, ở đây gộp cuối tin)
  assert.match(draft, /\n\nĐỔI VÉ\nMã vé: A711655, A714050, A723183/);

  await respond("xác nhận", trang, c);
  assert.match(await respond("đồng ý", viet, c), /YC001 có phụ thu 160\.000đ[\s\S]*thu[\s\S]*không thu/);
  assert.equal(fake.changes.length, 0);
  assert.match(await respond("đồng ý YC001 thu ai-do", viet, c), /Tài khoản phụ thu ai-do không dùng được/);

  const done = await respond("đồng ý YC001 thu ngannn-tn", viet, c);
  assert.match(done, /✅ A711655: đã đổi sang ghế 3, phụ thu 160\.000đ/);
  assert.match(done, /✅ A714050: đã đổi sang ghế 1/);
  assert.match(done, /❌ A723183: .* → để lại/);
  assert.match(done, /YC001: đã đổi một phần/);
  assert.equal(fake.changes.length, 2);
  assert.deepEqual(
    { ...fake.changes[0], date: apiDate(fake.changes[0].date) },
    {
      orderNumber: "A711655",
      date: "29-10-2026",
      shiftId: 3740,
      seat: 3,
      surcharge: 160000,
      userSurcharge: "ngannn-tn",
      note: "YC001 - duyệt bởi Nguyễn Thanh Việt",
      requestCode: "YC001-A711655",
    },
  );
  assert.equal(fake.changes[1].surcharge, 0);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /ĐỔI MỘT PHẦN ĐỔI VÉ YC001[\s\S]*💰 Đã thu phụ thu: 160\.000đ \(tài khoản ngannn-tn\)[\s\S]*📋 Kết quả trên hệ thống:\n• A711655: đã đổi ghế 3, phụ thu 160\.000đ/);
  assert.match(await respond("đồng ý YC001", viet, c), /đã được xử lý trước đó/);
});

test("không thu phụ thu thì gửi phụ thu 0", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 160000) } });
  const c = ctxWith(fake.api);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(await respond("đồng ý YC001 không thu khách quen", viet, c), /^✅ Mr Thanh Việt đã đồng ý YC001\.\n_+\n✅ A711655: đã đổi sang ghế \d+$/);
  assert.equal(fake.changes[0].surcharge, 0);
  assert.equal(fake.changes[0].userSurcharge, "");
  assert.equal(c.store.get("YC001")?.decisionNote, "khách quen");
});

test("không có chuyến thì báo lỗi, không tạo yêu cầu", async () => {
  const fake = fakeApi({ shifts: [], tickets: { A711655: ticket("Vé thường", 7, 0) } });
  const c = ctxWith(fake.api);
  const reply = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(reply, /Không có chuyến 18:00 ngày 29-10-2026 tuyến HN-HP/);
  assert.equal(c.store.lastSeq, 0);
});

test("nhiều chuyến cùng giờ thì người gửi chọn", async () => {
  const fake = fakeApi({
    shifts: [
      { ShiftID: 1, ShiftName: "18:00", FreeSeat: 3, IsExtra: false },
      { ShiftID: 2, ShiftName: "18:00", FreeSeat: 9, IsExtra: true },
    ],
    tickets: { A711655: ticket("Vé thường", 7, 0) },
  });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(draft, /Có 2 chuyến 18:00[\s\S]*2\. 18:00 ngày 29-10-2026 \(xe tăng cường\), còn 9 ghế trống/);
  assert.match(draft, /👉 Trang chọn chuyến: @bot chọn 1, @bot chọn 2/);
  assert.doesNotMatch(draft, /\n\nĐỔI VÉ\n/);
  assert.match(await respond("xác nhận", trang, c), /cần chọn chuyến trước/);
  const chosen = await respond("chọn 2", trang, c);
  assert.match(chosen, /Chuyến mới: 18:00 ngày 29-10-2026 HN-HP, còn 9 ghế trống \(xe tăng cường\)/);
  assert.match(chosen, /✅ Mã vé: A711655/);
  await respond("đồng ý YC001", viet, c);
  assert.equal(fake.changes[0].shiftId, 2);
});

test("ghế vừa bị bán thì bot đề xuất ghế khác, duyệt lại mới đổi", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0) }, free: [7, 8, 9] });
  const c = ctxWith(fake.api);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  fake.free.delete(7); // có người mua ghế 7 trong lúc chờ duyệt
  const first = await respond("đồng ý YC001", viet, c);
  assert.match(first, /ghế 7 vừa có người đặt, bot đề xuất ghế 8[\s\S]*gõ lại: @bot Đồng ý YC001/);
  assert.equal(fake.changes.length, 0);
  assert.match(await respond("đồng ý", viet, c), /đã đổi sang ghế 8/);
  assert.equal(c.store.get("YC001")?.status, "DA_DOI");
});

test("mất kết nối khi đổi: lần sau kiểm tra lại, không đổi hai lần", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0) } });
  const c = ctxWith(fake.api);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  fake.failChange();
  assert.match(await respond("đồng ý YC001", viet, c), /Chưa rõ đã đổi chưa/);
  assert.match(await respond("đồng ý YC001", viet, c), /đã đổi sang ghế 1/);
  assert.equal(fake.changes.length, 1);
  assert.equal(c.store.get("YC001")?.status, "DA_DOI");
});

test("đọc phụ thu và tài khoản phụ thu trong tin", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 160000) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP, phụ thu 120k phụ thu bởi ngannn-tn", trang, c);
  assert.match(draft, /Phụ thu: 120\.000đ\/1 mã vé\nPhụ thu bởi: ngannn-tn/);
  assert.match(draft, /💰 Phụ thu: 160\.000đ\/1 mã vé, tổng 160\.000đ \(theo hệ thống\)/);
  assert.match(draft, /💳 Phụ thu bởi: ngannn-tn \(Nguyễn Ngân\)/);
  assert.match(await respond("đồng ý YC001", viet, c), /đã đồng ý YC001\.\n_+\n✅ A711655: đã đổi sang ghế/);
  assert.equal(fake.changes[0].userSurcharge, "ngannn-tn");
  assert.equal(fake.changes[0].surcharge, 160000);
});

test("máy chủ API báo lỗi thì coi như chưa kiểm tra, duyệt sẽ kiểm tra lại", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0) } });
  const real = fake.api.checkTicket;
  let broken = true;
  fake.api.checkTicket = async (...args) =>
    broken
      ? { Status: false, Message: "Có lỗi xảy ra: Object reference not set to an instance of an object.", FreeSeats: null, StartTime: null, Surcharge: 0, TicketInfo: null }
      : real(...args);
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(draft, /A711655: Chưa kiểm tra được: máy chủ API báo lỗi: Object reference/);
  assert.match(draft, /Bot sẽ kiểm tra lại khi duyệt/);
  assert.doesNotMatch(draft, /Không vé nào đổi được/);
  broken = false;
  assert.match(await respond("đồng ý YC001", viet, c), /đã đổi sang ghế 1/);
});

test("không vé nào đổi được thì báo ngay, không chờ duyệt", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0, { allowed: false, message: "Vé đã đổi chuyến" }) } });
  const c = ctxWith(fake.api);
  const reply = await respond("ĐỔI VÉ\nMã vé: A711655\nChuyến cũ: 16:45 29/10 HĐ-HP\nChuyến mới: 18:00 29/10 HN-HP", trang, c);
  assert.match(reply, /❌ Mã vé: A711655[\s\S]*Không vé nào đổi được theo hệ thống/);
  assert.doesNotMatch(reply, /Chờ Mr Thanh Việt duyệt/);
});

test("hệ thống không tính phụ thu mà người gửi ghi phụ thu thì mặc định thu theo người gửi", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0), A714050: ticket("Vé thường", 8, 0) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 A714050 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP, phụ thu 50k phụ thu bởi ngannn-tn", trang, c);
  assert.match(draft, /💰 Phụ thu: 50\.000đ\/1 mã vé, tổng 100\.000đ \(theo người gửi\)/);
  const done = await respond("đồng ý", viet, c);
  assert.match(done, /đã đổi sang ghế 1, phụ thu 50\.000đ/);
  assert.deepEqual(fake.changes.map((x) => [x.surcharge, x.userSurcharge]), [[50000, "ngannn-tn"], [50000, "ngannn-tn"]]);
});

test("hệ thống có phụ thu mà người gửi không ghi thì người duyệt quyết định", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 160000) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(draft, /💰 Phụ thu: tổng 160\.000đ \(theo hệ thống\)/);
  assert.match(await respond("đồng ý", viet, c), /thu[\s\S]*không thu/);
  assert.equal(fake.changes.length, 0);
  await respond("đồng ý YC001 không thu", viet, c);
  assert.equal(fake.changes[0].surcharge, 0);
});

test("cả hệ thống và người gửi đều có phụ thu thì lấy số lớn hơn", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 100000), A714050: ticket("Vé khứ hồi", 3, 200000) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 A714050 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP, phụ thu 150k phụ thu bởi ngannn-tn", trang, c);
  assert.match(draft, /💰 Phụ thu: 200\.000đ\/1 mã vé, tổng 350\.000đ \(theo người gửi và hệ thống\)/);
  await respond("đồng ý", viet, c);
  assert.deepEqual(fake.changes.map((x) => x.surcharge), [150000, 200000]);
});

test("có phụ thu mà chưa ghi tài khoản thì form có dòng Phụ thu bởi để điền", async () => {
  const fake = fakeApi({ tickets: { A323857: ticket("Vé khứ hồi", 3, 0) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A323857 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP, phụ thu 120k", trang, c);
  assert.match(draft, /Phụ thu: 120\.000đ\/1 mã vé\nPhụ thu bởi: \(chưa có, điền tài khoản thu phụ thu\)/);
  // Người gửi sao chép form, điền tài khoản rồi gửi lại
  const form = draft.split("\n\n")[1].replace("(chưa có, điền tài khoản thu phụ thu)", "ngannn-tn");
  const resent = await respond(form, trang, c);
  assert.match(resent, /Phụ thu bởi: ngannn-tn/);
  assert.match(resent, /💳 Phụ thu bởi: ngannn-tn \(Nguyễn Ngân\)/);
  // Gửi lại mà chưa điền thì không coi chỗ trống là tài khoản
  const unfilled = await respond(draft.split("\n\n")[1], trang, c);
  assert.match(unfilled, /💳 Phụ thu bởi: \(chưa có\) Người duyệt ghi khi đồng ý/);
  assert.doesNotMatch(unfilled, /Tài khoản phụ thu \(/);

  // Chỉ hệ thống có phụ thu cũng hiện dòng này
  const fake2 = fakeApi({ tickets: { A711655: ticket("Vé khứ hồi", 4, 160000) } });
  const draft2 = await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, ctxWith(fake2.api));
  assert.match(draft2, /Phụ thu bởi: \(chưa có/);
});

test("đọc tài khoản phụ thu viết sau số tiền: \"phụ thu 120k cho lanhnt-dhtt\"", () => {
  const f = readFreeText("hỗ trợ đổi vé A323857 7h HN-HP ngày 10-11-2026 sang chuyến 11h ngày 10-11-2026,phụ thu 120k cho lanhnt-dhtt");
  assert.equal(f.proposedSurcharge, "120k");
  assert.equal(f.surchargeAccount, "lanhnt-dhtt");
  assert.equal(f.ticketCodes, "A323857");
  assert.match(f.newDeparture ?? "", /^11h 10-11-2026/);
  assert.equal(readFreeText("A711655 đổi 16h45 HĐ-HP sang 18h HN-HP, phụ thu 50k bởi ngannn-tn").surchargeAccount, "ngannn-tn");
  // "cho khách" không phải tài khoản
  assert.equal(readFreeText("A711655 đổi 16h45 HĐ-HP sang 18h HN-HP, phụ thu 50k cho khách").surchargeAccount, undefined);
});

test("phụ thu nằm trong lý do: \"cho tài khoản trangph-it\" không lẫn vào lý do", () => {
  const f = readFreeText("đổi vé A308451 15h TP-HP ngày 16/11 sang chuyến 9h45 vì khách muốn về sớm, phụ thu 100k cho tài khoản trangph-it");
  assert.equal(f.proposedSurcharge, "100k");
  assert.equal(f.surchargeAccount, "trangph-it");
  assert.equal(f.reason, "khách muốn về sớm");
  const p = readFreeText("đổi vé A308451 15h TP-HP ngày 16/11 sang chuyến 9h45 (khách muốn về sớm, phụ thu 100.000đ tk trangph-it)");
  assert.equal(p.proposedSurcharge, "100.000đ");
  assert.equal(p.surchargeAccount, "trangph-it");
  assert.equal(p.reason, "khách muốn về sớm");
  assert.match(p.newDeparture ?? "", /^9h45/);
});

test("chỉ ghi chuyến mới: chuyến cũ lấy từ hệ thống và hiện trong form xác nhận", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0, { start: "16:45", date: "29-10-2026" }) } });
  const c = ctxWith(fake.api);
  const draft = await respond("A711655 đổi vé chuyến 18h HN-HP", trang, c);
  assert.deepEqual(fake.shiftCalls[0], ["29-10-2026", 11, "18:00"]);
  assert.match(draft, /Chuyến cũ: 16:45 29\/10\/2026 Hà Đông - Hải Phòng \(theo hệ thống\)/);
  assert.match(draft, /Ghế cũ: 7/);
  assert.match(draft, /Chuyến mới: 18:00 29\/10\/2026 HN-HP/);
  assert.match(draft, /✅ Mã vé: A711655 \(Vé thường, ghế cũ 7\)/);
  assert.match(draft, /🚐 Chuyến cũ: 16:45 29-10-2026 HĐ-HP/);
  assert.doesNotMatch(draft, /Hệ thống ghi chuyến cũ của vé/);
  assert.match(await respond("xác nhận", trang, c), /Đã xác nhận YC001/);
  assert.match(await respond("đồng ý YC001", viet, c), /đã đồng ý YC001\.\n_+\n✅ A711655: đã đổi sang ghế/);
  assert.equal(fake.changes.length, 1);
});

test("\"sang chuyến\" không có chuyến cũ cũng được; chuyến cũ hệ thống từ hôm trước thì từ chối", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0, { start: "16:45", date: "28-10-2026" }) } });
  const c = ctxWith(fake.api);
  const reply = await respond("đổi vé A711655 sang chuyến 18h HN-HP", trang, c);
  assert.match(reply, /Chuyến cũ theo hệ thống \(16:45 28\/10\/2026[^)]*\) đã chạy từ ngày trước/);
  assert.equal(c.store.get("YC001"), undefined);
});

test("mẫu để trống chuyến cũ vẫn gửi được", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0, { start: "19:00" }) } });
  const c = ctxWith(fake.api);
  const reply = await respond(
    ["ĐỔI VÉ", "Mã vé: A711655", "Chuyến cũ: (không bắt buộc, bot lấy từ hệ thống theo mã vé)", "Chuyến mới: 18:00 29/10 HN-HP", "Lý do: khách bận"].join("\n"),
    trang,
    c,
  );
  assert.match(reply, /Đã nhận yêu cầu ĐỔI VÉ YC001/);
  assert.match(reply, /🚐 Chuyến cũ: 19:00 29-10-2026 HĐ-HP\n/);
  assert.match(reply, /✅ Mã vé: A711655 \(Vé thường, ghế cũ 7\)\n/);
  assert.match(reply, /🚐 Chuyến mới: 18:00 ngày 29-10-2026 HN-HP, còn 11 ghế trống\n💺 Ghế mới: 1, không phụ thu\n/);
  assert.doesNotMatch(reply, /QUÁ GIỜ|bot hiểu là/);
});

test("lấy hóa đơn: bot soạn, người gửi xác nhận rồi mới tích; báo người gửi, nhóm đổi vé và nhóm báo cáo", async () => {
  const fake = fakeApi({ tickets: { A711655: ticket("Vé thường", 7, 0) } });
  const reports: string[] = [];
  const notices: { chatId: string; text: string }[] = [];
  const c = { ...ctxWith(fake.api, reports), notices, chatId: "u1", privateChat: true, approvalGroupId: "group-1" };
  const draft = await respond("Lấy hóa đơn giúp em vé A716617 và A000001 (khách công ty ABC)", trang, c);
  assert.match(draft, /^🧾 Em đã soạn yêu cầu LẤY HÓA ĐƠN \(2 vé\):\n_+\n🎫 Mã vé: A716617, A000001\n📝 Ghi chú: khách công ty ABC\n_+\n👉 Trang kiểm tra giúp em: đúng thì trả lời Xác nhận/);
  assert.deepEqual(fake.taxes, [], "chưa tích khi chưa xác nhận");
  assert.equal(c.store.lastSeq, 0, "không tạo yêu cầu đổi vé");

  // Người khác xác nhận không tích được bản của Trang
  assert.doesNotMatch(await respond("xác nhận", viet, c), /LẤY HÓA ĐƠN/);
  assert.deepEqual(fake.taxes, []);

  const reply = await respond("xác nhận", trang, c);
  assert.deepEqual(fake.taxes, ["A716617", "A000001"]);
  assert.match(reply, /^🧾 Kết quả LẤY HÓA ĐƠN \(2 vé\):\n_+\n✅ A716617: đã tích hóa đơn\n❌ A000001: Mã vé không có đầy đủ thông tin công ty/);
  assert.match(reply, /Tích được 1\/2 vé/);
  const group = notices.find((m) => m.chatId === "group-1")!.text;
  assert.match(group, /^🧾 Y\/c LẤY HÓA ĐƠN\ntừ Trang \(ib lúc [\d:]+ [\d-]+\):\n_+\n✅ A716617: đã tích hóa đơn\n❌ A000001/);
  assert.equal(reports.length, 1);
  // Xác nhận lần nữa không tích lại
  assert.doesNotMatch(await respond("xác nhận", trang, c), /LẤY HÓA ĐƠN/);
  assert.equal(fake.taxes.length, 2);

  // Mẫu điền sẵn
  fake.taxes.length = 0;
  assert.match(await respond("LẤY HÓA ĐƠN\nMã vé: A711655, A714050\nGhi chú: ", trang, c), /Em đã soạn yêu cầu LẤY HÓA ĐƠN \(2 vé\)/);
  assert.match(await respond("xác nhận", trang, c), /Đã tích hóa đơn tất cả vé/);
  assert.deepEqual(fake.taxes, ["A711655", "A714050"]);

  // Bản soạn mới nhất được xác nhận: đổi vé gửi sau hóa đơn thì "xác nhận" là cho đổi vé
  fake.taxes.length = 0;
  await respond("lấy hóa đơn A711655", trang, c);
  c.now = new Date(now.getTime() + 60_000);
  await respond("A711655 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP", trang, c);
  assert.match(await respond("xác nhận", trang, c), /Đã chuyển YC001/);
  assert.match(await respond("xác nhận", trang, c), /Kết quả LẤY HÓA ĐƠN/);

  // "mẫu hóa đơn" gửi mẫu thành tin riêng
  notices.length = 0;
  assert.match(await respond("mẫu hóa đơn", trang, c), /Mẫu lấy hóa đơn ở tin bên dưới/);
  assert.match(notices[0].text, /^LẤY HÓA ĐƠN\nMã vé:/);
});

test("hóa đơn không nhầm với đổi vé, HĐ là Hà Đông", () => {
  assert.equal(looksLikeInvoice("A711655 đổi chuyến 16h45 HĐ-HP sang 18h HN-HP"), false);
  assert.equal(looksLikeInvoice("A711655 lấy hđ"), false);
  assert.equal(looksLikeInvoice("xuất hoá đơn VAT cho A711655"), true);
  assert.equal(looksLikeInvoice("A711655 đổi sang 18h và lấy hóa đơn"), false);
  assert.equal(looksLikeInvoice("HÓA ĐƠN\nMã vé: A711655"), true);
});
