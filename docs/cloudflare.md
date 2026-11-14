# Chạy bot trên Cloudflare Workers

Trên Cloudflare, mặc định bot chạy kiểu polling: mỗi phút Cloudflare chạy Worker một lần (Cron Trigger), Worker hỏi Zalo có tin mới liên tục trong khoảng 57 giây, nên tin được trả lời gần như ngay. Chế độ webhook (`BOT_MODE=webhook`, Zalo gọi `/webhook`) vẫn còn trong code nhưng khi thử thì Zalo không gửi tin tới workers.dev. Dữ liệu đổi vé lưu trong một Durable Object (`BotState`) và ghi thêm sang Google Sheet nếu đã cấu hình. Gói miễn phí của Cloudflare là đủ dùng.

## Cài lần đầu

1. Gộp (merge) code vào nhánh `main` trên GitHub.
2. Vào [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Import a repository**. Kết nối GitHub, chọn repo `limo-doi-ve-bot`.
3. Ở phần cài đặt build, giữ mặc định (Deploy command: `npx wrangler deploy`). Bấm **Deploy**.
4. Sau khi deploy xong, vào Worker vừa tạo → **Settings** → **Variables and Secrets** → **Add**, chọn loại **Secret** cho từng biến:

   | Tên | Giá trị |
   | --- | --- |
   | `ZALO_BOT_TOKEN` | Token bot Zalo |
   | `WEBHOOK_SECRET` | Một chuỗi ngẫu nhiên, dùng để Zalo chứng minh tin là thật |
   | `SHEET_WEBHOOK_URL` | Link `/exec` của Apps Script (xem [google-sheet.md](google-sheet.md)) |
   | `SHEET_WEBHOOK_SECRET` | Mật khẩu `SECRET` trong Apps Script |

   Thêm loại **Text** (đặt trên trang Cloudflare, không ghi vào `wrangler.jsonc` vì biến trong file sẽ ghi đè trang mỗi lần deploy):

   | Tên | Giá trị |
   | --- | --- |
   | `REQUEST_GROUP_IDS` | ID các nhóm nhận yêu cầu đổi vé, cách nhau dấu phẩy. Lấy ID: trong nhóm nhắn `@Bot HL Support id` |
   | `REPORT_GROUP_ID` | ID nhóm nhận báo cáo |
   | `APPROVER_HAI_PHONG_IDS` | Zalo id Ms Ngọc Anh (duyệt vé đi từ Hải Phòng) |
   | `APPROVER_HA_NOI_IDS` | Zalo id Mr Thanh Việt (duyệt vé đi từ Hà Nội, Hà Đông) |
   | `HL_API_URL` | Địa chỉ API Hoàng Long (máy chủ test hoặc thật) |
5. Mở trên trình duyệt (một lần): `https://limo-doi-ve-bot.<tên-tài-khoản>.workers.dev/setup?secret=<WEBHOOK_SECRET>`. Thấy `"ok": true` là xong (ở chế độ polling, bước này xoá webhook cũ nếu có).
6. Vào nhóm Zalo, nhắn `@Bot HL Support ping`, bot trả `pong`.

## Về sau

- Mỗi lần code mới được gộp vào `main`, Cloudflare tự deploy lại. Không cần mở lại `/setup`.
- Xem log: Worker → **Observability** (hoặc **Logs**).
- Nhóm Zalo, người duyệt, địa chỉ API đều sửa trên trang Cloudflare (Settings > Variables and Secrets). `wrangler.jsonc` có `keep_vars` nên deploy lại không làm mất các giá trị này.
- Khi đã chạy trên Cloudflare thì đừng chạy bản Node cùng lúc: hai nơi cùng hỏi Zalo sẽ tranh nhau tin.
- Xem các tin bot nhận gần nhất và lỗi nếu có: `/debug?secret=<WEBHOOK_SECRET>`.

## Nối API Hoàng Long

1. Trên trang Worker `limo-doi-ve-bot` > **Settings** > **Variables and Secrets** > **Add**, thêm 2 biến loại **Secret**:
   - `HL_API_USERNAME`: username Hoàng Long cấp
   - `HL_API_KEY`: key Hoàng Long cấp
2. Kiểm tra kết nối (chỉ đọc, không đổi vé), mở trên trình duyệt:
   `https://limo-doi-ve-bot.<tên-tài-khoản>.workers.dev/hl-check?secret=<WEBHOOK_SECRET>&route=11&date=06-11-2026&time=18:00`
   Thêm `&ticket=<mã vé>` để kiểm tra một vé, `&user=<tài khoản>` để kiểm tra tài khoản phụ thu.
   Thấy `"Status": true` và danh sách chuyến là được.
3. Đổi sang máy chủ thật: sửa `HL_API_URL` trên trang Cloudflare, cùng `HL_API_USERNAME` và `HL_API_KEY` của máy chủ thật.

Mã tuyến: 11 HN-HP, 12 HP-HN, 13 HP-HĐ, 14 HĐ-HP. Ghế 5A, 6A là ghế 10, 11 trên hệ thống.

Khi có API, luồng đổi vé:
- Bot tìm chuyến mới, kiểm tra từng vé, tự chọn ghế trống cùng hạng nếu tin không ghi ghế, hiện phụ thu hệ thống tính.
- Vé không đổi được thì để lại, các vé khác vẫn đổi.
- Phụ thu: hệ thống không tính mà người gửi ghi `Phụ thu: 50k` thì mặc định thu theo người gửi (mỗi vé); hệ thống có phụ thu và người gửi cũng ghi thì mặc định thu theo số lớn hơn (từng vé); hệ thống có mà người gửi không ghi thì người duyệt gõ `@bot Đồng ý YC001 thu <tài khoản>` hoặc `@bot Đồng ý YC001 không thu`.
- Ngay trước khi đổi bot kiểm tra lại; ghế vừa bị bán thì bot đề xuất ghế khác và chờ người duyệt đồng ý lại.

## Khi gộp PR mà Cloudflare không tự build

Vào **Deployments** > **View all builds**. Nếu không thấy build của commit mới nhất trên `main`, gộp thêm một PR bất kỳ để Cloudflare nhận lại sự kiện từ GitHub. Lần gộp PR #9 từng gặp trường hợp này.
