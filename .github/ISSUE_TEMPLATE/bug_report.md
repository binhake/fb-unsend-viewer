---
name: 🐞 Báo lỗi / Bug report
about: Tin nhắn bị gỡ không được khôi phục, hiển thị sai, popup lỗi... / Something isn't working
title: "[Lỗi] "
labels: bug
assignees: binhake
---

<!--
⚠️ Nhớ CHE tên, avatar và nội dung tin nhắn riêng tư trong ảnh chụp / file log trước khi đăng.
⚠️ Please BLUR names, avatars and private message content in screenshots / logs before posting.
-->

### Mô tả lỗi / What happened?
<!-- Ví dụ: Người kia gỡ một tin có ảnh nhưng bong bóng không hiện lại nội dung -->


### Các bước tái hiện / Steps to reproduce
1. 
2. 
3. 

### Kết quả mong đợi / Expected behavior


### Môi trường / Environment
- Phiên bản extension / Extension version: <!-- xem ở góc dưới popup, ví dụ v1.2.4 -->
- Trình duyệt / Browser: <!-- Chrome 130, Edge, Brave, Cốc Cốc... -->
- Hệ điều hành / OS: <!-- Windows 11, macOS... -->
- Lỗi xảy ra ở / Where:
  - [ ] Khung chat nhỏ trên facebook.com / Chat tab on facebook.com
  - [ ] Messenger toàn màn hình (facebook.com/messages) / Full-screen Messenger
  - [ ] Popup của extension / Extension popup
- Loại đoạn chat / Chat type:
  - [ ] Chat 1-1
  - [ ] Nhóm chat / Group chat
  - [ ] Đoạn chat cộng đồng / Community chat
  - [ ] Có mã hóa đầu cuối (E2EE) / End-to-end encrypted
- Loại tin bị gỡ / Unsent content: <!-- văn bản, ảnh, sticker, voice, video... -->

### Đã thử chưa? / Checklist
- [ ] Đã F5 lại tab Facebook sau khi cài / cập nhật extension / Refreshed the Facebook tab after installing/updating
- [ ] Tin nhắn được gửi đến **sau khi** đã mở Facebook có extension / The message arrived **while** Facebook was open with the extension running

### Ảnh chụp & Debug log / Screenshots & debug log
<!--
CÁCH XUẤT DEBUG LOG / HOW TO EXPORT THE DEBUG LOG
1. Ở đúng tab Facebook vừa bị lỗi, ĐỪNG F5 (tải lại là mất log).
   Stay on the tab where the bug happened, DO NOT refresh (the log is lost on reload).
2. Bấm vào chỗ trống trên trang → nhấn Alt + Shift + D.
   Click an empty spot on the page → press Alt + Shift + D.
3. File fb-unsend-debug-<số>.json được tải về thư mục Downloads.
   A fb-unsend-debug-<number>.json file is saved to Downloads.
4. File log có nội dung tin nhắn, tên và ID Facebook của bạn: mở bằng Notepad, Ctrl + H thay chỗ nhạy cảm bằng xxx.
   Không muốn đăng công khai thì ghi "có log, cần gửi riêng".
   The log contains message text, names and your Facebook ID: open it in Notepad, Ctrl + H to replace sensitive parts with xxx.
   If you'd rather not post it publicly, write "have a log, need to send privately".
5. Kéo thả file .json vào đây (GitHub không nhận thì nén .zip).
   Drag and drop the .json file here (zip it if GitHub rejects it).

Thêm ảnh chụp màn hình lỗi (đã che thông tin) và lỗi đỏ trong F12 → Console nếu có.
Also add screenshots (blurred) and any red errors from F12 → Console.
-->

- [ ] Đã đính kèm debug log / Debug log attached
- [ ] Có log nhưng cần gửi riêng / Have a log, need to send it privately

