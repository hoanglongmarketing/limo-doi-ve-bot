# Chạy bot trên Cloudflare Workers

Trên Cloudflare, mặc định bot chạy kiểu polling: mỗi phút Cloudflare chạy Worker một lần (Cron Trigger), Worker hỏi Zalo có tin mới liên tục trong khoảng 50 giây, nên tin được trả lời gần như ngay. Chế độ webhook (`BOT_MODE=webhook`, Zalo gọi `/webhook`) vẫn còn trong code nhưng khi thử thì Zalo không gửi tin tới workers.dev. Dữ liệu đổi vé lưu trong một Durable Object (`BotState`) và ghi thêm sang Google Sheet nếu đã cấu hình. Gói miễn phí của Cloudflare là đủ dùng.

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

   Thêm loại **Text** nếu cần: `REQUEST_GROUP_IDS` (nhóm nhận yêu cầu), `REPORT_GROUP_ID` (nhóm nhận báo cáo).
5. Mở trên trình duyệt (một lần): `https://limo-doi-ve-bot.<tên-tài-khoản>.workers.dev/setup?secret=<WEBHOOK_SECRET>`. Thấy `"ok": true` là xong (ở chế độ polling, bước này xoá webhook cũ nếu có).
6. Vào nhóm Zalo, nhắn `@Bot HL Support ping`, bot trả `pong`.

## Về sau

- Mỗi lần code mới được gộp vào `main`, Cloudflare tự deploy lại. Không cần mở lại `/setup`.
- Xem log: Worker → **Observability** (hoặc **Logs**).
- Người duyệt (Zalo id) nằm trong `wrangler.jsonc`, phần `vars`.
- Khi đã chạy trên Cloudflare thì đừng chạy bản Node cùng lúc: hai nơi cùng hỏi Zalo sẽ tranh nhau tin.
- Xem các tin bot nhận gần nhất và lỗi nếu có: `/debug?secret=<WEBHOOK_SECRET>`.
