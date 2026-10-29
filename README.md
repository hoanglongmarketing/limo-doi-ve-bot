# limo-doi-ve-bot

Bot Zalo (Zalo Bot Platform, không cần OA) hỗ trợ đổi vé LIMO Hoàng Long trong nhóm chat nhân viên.

## Trạng thái

**Bản test hiện tại:** bot nhận tin khi được @nhắc trong nhóm, đọc yêu cầu đổi vé theo mẫu và chuyển cho đúng người duyệt.

| Lệnh (kèm @bot) | Bot làm gì |
| --- | --- |
| `mẫu` | Gửi mẫu yêu cầu đổi vé trống |
| Tin viết tự do có mã vé và chữ "đổi", vd `A711655 A714050 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP (lý do)` | Bot soạn form, người gửi `Xác nhận` rồi mới chuyển người duyệt |
| Mẫu đã điền (bắt đầu bằng `ĐỔI VÉ`) | Kiểm tra đủ thông tin, cấp mã `YC001`, báo vé quá hạn, gọi người duyệt |
| `Xác nhận` | Người gửi xác nhận form bot đã soạn |
| `Đồng ý YC001` / `Từ chối YC001 <lý do>` | Người duyệt quyết định |
| `xem YC001` | Xem trạng thái |
| `id` | Bot trả ID của nhóm đang nhắn (để cấu hình nhóm) |
| `help`, `ping` | Hướng dẫn, kiểm tra bot |

Mẫu yêu cầu:

```
ĐỔI VÉ
Mã vé: HL123
Tên khách: Nguyễn Văn A
SĐT khách: 0912345678
Điểm đi: Hải Phòng
Chuyến cũ: 08:00 30/10
Ghế cũ: A3
Chuyến mới: 14:00 30/10
Ghế mới: B5
Lý do: Khách bận việc
```

Quy định duyệt: vé đi từ **Hải Phòng (HP)** do **Ms Ngọc Anh** duyệt, vé đi từ **Hà Nội (HN) hoặc Hà Đông (HĐ)** do **Mr Thanh Việt** duyệt. Điểm đi lấy theo tuyến của chuyến cũ (vd `HĐ-HP` là đi từ Hà Đông). Tin không ghi ngày thì bot hiểu là hôm nay (chuyến mới đã qua giờ thì hiểu là ngày mai) và ghi chú để người gửi kiểm tra. Vé quá hạn (chuyến cũ đã chạy) vẫn nhận nếu được duyệt. Chuyến mới phải sau thời điểm gửi yêu cầu.

Sửa mẫu, nhãn trường ở `src/exchange/template.ts`; mã điểm đón ở `src/exchange/trip.ts`; cách đọc tin tự do ở `src/exchange/freetext.ts`; người duyệt ở `src/exchange/approvers.ts`.

**Hai nhóm Zalo:** `REQUEST_GROUP_IDS` là nhóm nhận yêu cầu đổi vé (để trống thì nhận ở mọi nhóm), `REPORT_GROUP_ID` là nhóm nhận báo cáo khi yêu cầu được duyệt hoặc từ chối. Lấy ID bằng cách thêm bot vào nhóm và nhắn `@Bot HL Support id`.

**Lưu dữ liệu:** mọi yêu cầu (người gửi, thời gian, form, người duyệt, ghi chú) được ghi vào `data/requests.json` sau mỗi thay đổi, khởi động lại bot không mất.

**Chưa có (chờ API Hoàng Long):** kiểm tra ghế trống, chênh lệch giá/phụ thu, đổi vé thật.

## Cài đặt

Cần Node.js 20 trở lên.

```bash
npm install
cp .env.example .env   # rồi điền ZALO_BOT_TOKEN
npm run check-token    # kiểm tra token (gọi getMe)
npm run dev            # chạy bot, tự tải lại khi sửa code
```

Chạy bản build:

```bash
npm run build
npm start
```

## Hai chế độ nhận tin

| Chế độ | Khi nào dùng | Cấu hình |
| --- | --- | --- |
| `polling` (mặc định) | Chạy trên máy tính hoặc máy chủ không có URL public | `BOT_MODE=polling` |
| `webhook` | Máy chủ có URL https public | `BOT_MODE=webhook`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `PORT` |

Ở chế độ webhook, Zalo gửi kèm header `X-Bot-Api-Secret-Token`; bot từ chối các yêu cầu sai secret. `GET /health` trả `ok` để kiểm tra máy chủ.

## Bảo mật

Token bot nằm trong `.env` (đã có trong `.gitignore`). Không đưa token vào code hay commit. Nếu token bị lộ, tạo token mới trong Zalo Bot Creator.

## Cấu trúc

```
src/
  index.ts        khởi động bot, chọn polling hoặc webhook
  config.ts       đọc biến môi trường
  zalo.ts         client gọi Zalo Bot API
  handler.ts      nhận tin, bỏ @bot, gọi luồng đổi vé
  exchange/       mẫu yêu cầu, người duyệt, luồng duyệt, lưu dữ liệu
  polling.ts      nhận tin bằng getUpdates
  webhook.ts      nhận tin qua webhook
  check-token.ts  kiểm tra token
test/             kiểm thử (npm test)
```
