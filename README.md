<div align="center">
  <img src="icons/logo.svg" alt="FB Unsend Message Viewer Logo" width="110" height="110" />
  <h1>FB Unsend Message Viewer</h1>
  <p>
    <strong>Tiện ích mở rộng trình duyệt giúp ghi nhận ngầm và khôi phục tin nhắn bị gỡ trên Facebook Messenger theo thời gian thực.</strong><br/>
    <em>Browser extension that silently captures and restores unsent messages on Facebook Messenger in real time.</em>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-2563eb?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/Version-1.2.5-7c3aed?style=flat-square" alt="Version 1.2.5" />
    <img src="https://img.shields.io/badge/Privacy-100%25%20Local-10b981?style=flat-square" alt="100% Local Privacy" />
    <img src="https://img.shields.io/badge/License-Non--Commercial%20(by%20binhake)-ef4444?style=flat-square" alt="License Non-Commercial (by binhake)" />
  </p>

  <p>
    <a href="https://github.com/binhake/fb-unsend-viewer/stargazers"><img src="https://img.shields.io/github/stars/binhake/fb-unsend-viewer?style=social" alt="GitHub stars" /></a>
  </p>

  <p>
    ⭐ <strong>Nếu thấy hữu ích, hãy cho repo 1 star để mình có động lực maintain tiếp nhé!</strong><br/>
    <em>If you find this useful, please give it a star ⭐</em><br/>
    🐞 Gặp lỗi? <a href="https://github.com/binhake/fb-unsend-viewer/issues/new?template=bug_report.yml">Tạo issue</a> / Found a bug? <a href="https://github.com/binhake/fb-unsend-viewer/issues/new?template=bug_report.yml">Open an issue</a>
  </p>

  <p>
    ☕ <a href="#-ủng-hộ-tác-giả">Ủng hộ tác giả</a> / <a href="#-support-the-author">Support the author</a>
  </p>

  <p>
    <a href="#-tiếng-việt">🇻🇳 Tiếng Việt</a> •
    <a href="#-english">🇬🇧 English</a>
  </p>
</div>

---

## 🇻🇳 Tiếng Việt

### ✨ Tính năng nổi bật

- **Hoạt động ngầm liên tục (Background WebSocket & DOM Tracking)**: Tự động bắt và lưu đệm tin nhắn ngay từ luồng dữ liệu của Facebook Messenger, kể cả khi bạn đang ở tab khác hoặc chưa mở khung chat.
- **Khôi phục đa phương tiện đầy đủ**:
  - 💬 **Văn bản & Biểu tượng cảm xúc (Emoji / Sticker)**
  - 🖼️ **Hình ảnh**: Luôn ưu tiên lấy chất lượng gốc độ phân giải cao nhất, lưu trữ bền vững (Base64) để xem lại kể cả khi link CDN Facebook hết hạn, hỗ trợ xem ảnh phóng to (Lightbox) và tải về máy.
  - 🎵 **Tin nhắn thoại (Voice / Audio clip)**: Tích hợp trình phát `<audio controls>` nghe lại trực tiếp ngay tại khung chat và trong Popup.
  - 🎬 **Video**: Luôn chọn luồng video HD/gốc chất lượng cao nhất, tích hợp trình phát `<video controls>` xem và tải về trực tiếp.
  - 📎 **Tệp đính kèm & Liên kết xem trước (File / Link preview)**
- **Hiển thị toàn bộ lịch sử chỉnh sửa tin nhắn bị gỡ**:
  - Ghi nhận và hiển thị đầy đủ nội dung gốc cùng tất cả các lần chỉnh sửa trước khi tin nhắn bị thu hồi (`Xem lịch sử chỉnh sửa` / `Ẩn lịch sử chỉnh sửa`) theo đúng giao diện của Facebook.
- **Mở khóa ảnh / video "Xem 1 lần" (View once)**:
  - Xem trực tiếp trên trình duyệt máy tính các tin ảnh/video xem 1 lần mà Facebook thường chỉ cho xem trên ứng dụng di động.
  - Hoạt động cả trong đoạn chat **mã hóa đầu cuối (E2EE)**, kể cả nhóm chat E2EE.
  - Ảnh/video được hiện ngay tại bong bóng chat và lưu vào lịch sử Popup với nhãn `① Ảnh (Xem 1 lần)` / `① Video (Xem 1 lần)`.
- **Hiển thị trực tiếp tại vị trí bị gỡ trên khung chat**:
  - Thay thế dòng báo *"đã thu hồi một tin nhắn"* bằng khung nội dung gốc kèm nhãn `[ĐÃ GỠ]`.
  - Bám đúng vị trí tin nhắn ngay cả sau khi tải lại trang (F5) thông qua thuật toán neo ngữ cảnh (`anchorText`, `prevAnchorText`, `nextAnchorText`) và thời gian thực.
  - Hỗ trợ đầy đủ **Chat cá nhân (1-1)**, **Nhóm chat thường**, và **Đoạn chat cộng đồng (Community Chat)** trên Facebook.
- **Giao diện quản lý Popup & Side Panel hiện đại (Hỗ trợ Sáng / Tối tự động)**:
  - Mở nhanh bảng lịch sử ở **Thanh bên (Chrome Side Panel)** để vừa nhắn tin vừa theo dõi song song.
  - Tự động trích xuất và hiển thị **Avatar thật của người gửi** (chuẩn xác theo UID và ngữ cảnh đoạn chat).
  - Quản lý dung lượng ảnh/video/audio bị gỡ đã lưu kèm nút dọn dẹp riêng (giữ nguyên lịch sử văn bản).
  - **Tự động kiểm tra bản cập nhật mới từ GitHub Releases**: Hiển thị huy hiệu `NEW` và thanh thông báo *"Đã có phiên bản mới → Tải ngay"* ngay trong Popup (hoặc nhấn trực tiếp vào số phiên bản ở góc dưới để kiểm tra).
  - Tìm kiếm tức thì theo nội dung hoặc tên người gửi.
  - Lọc nhanh theo cuộc trò chuyện / nhóm chat, hoặc theo phân loại (*Tất cả*, *Người khác*, *Bạn gỡ*, *Có ảnh*).
  - Sao lưu (Export), Khôi phục (Import) toàn bộ lịch sử qua tệp `.json` và xuất nhanh tệp chẩn đoán lỗi (`Debug`).
- **Quyền riêng tư tuyệt đối (100% Offline / Local)**:
  - Không máy chủ trung gian, không thu thập dữ liệu, không gửi bất kỳ thông tin nào ra bên ngoài. Toàn bộ dữ liệu chỉ nằm trong bộ nhớ trình duyệt (`chrome.storage.local`) trên máy của bạn.

---

### 🚀 Hướng dẫn cài đặt

Bạn có thể cài đặt trên **Google Chrome**, **Microsoft Edge**, **Brave**, **Cốc Cốc**, hoặc bất kỳ trình duyệt nhân Chromium nào.

#### Cách 1: Tải bản đóng gói sẵn (Khuyên dùng)
1. Truy cập mục [**Releases**](../../releases) ở góc phải trang GitHub này và tải tệp `fb-unsend-viewer-v1.2.5.zip` mới nhất.
2. Giải nén tệp `.zip` ra một thư mục cố định trên máy tính.
3. Mở trình duyệt và truy cập đường dẫn quản lý tiện ích:
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
   - **Brave**: `brave://extensions/`
4. Bật công tắc **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
5. Nhấn nút **Tải tiện ích đã giải nén (Load unpacked)** và chọn thư mục vừa giải nén.
6. Mở hoặc tải lại trang [facebook.com](https://www.facebook.com/) để tiện ích bắt đầu hoạt động.

#### Cách 2: Dành cho nhà phát triển (Clone từ Git)
```bash
git clone https://github.com/binhake/fb-unsend-viewer.git
```
Sau đó vào `chrome://extensions/` → Bật **Developer mode** → Chọn **Load unpacked** và trỏ tới thư mục vừa clone.

---

### 🛠️ Báo lỗi & Xuất nhật ký gỡ lỗi (Debug Log)

Extension có sẵn phím tắt xuất file log để mình biết chính xác chuyện gì đã xảy ra. Gửi kèm file này trong issue thì lỗi sẽ được sửa nhanh hơn nhiều so với chỉ mô tả bằng lời.

**Bước 1. Xuất file log ngay khi gặp lỗi**
1. Ở **đúng tab Facebook vừa xảy ra lỗi** (đang mở đoạn chat có tin bị gỡ), **đừng F5**: log được giữ trong bộ nhớ của tab, tải lại trang là mất.
2. Bấm chuột vào một chỗ trống trên trang để trang đang được chọn (không phải thanh địa chỉ).
3. Nhấn **`Alt + Shift + D`**.
4. Trình duyệt tải về tệp `fb-unsend-debug-<số>.json` (thường nằm trong thư mục **Downloads**).

> Không thấy file tải về? Kiểm tra Chrome có đang chặn tải xuống (biểu tượng ở góc phải thanh địa chỉ) không. Nếu extension vừa được cập nhật thì tab cũ không còn nhận phím tắt: F5 tab, chờ lỗi xảy ra lại rồi mới xuất log.

**Bước 2. Che thông tin riêng tư trong file log**

File log chứa **nội dung các tin nhắn gần đây, tên người trong đoạn chat, ID Facebook của bạn** và đường dẫn đoạn chat. Trước khi đăng công khai:
- Mở file bằng Notepad / VS Code, dùng **Ctrl + H** thay các tên và nội dung nhạy cảm bằng `xxx` (đừng xóa dấu `"` hay `,` để file vẫn đọc được).
- Hoặc không đính kèm công khai: ghi trong issue là *"có file log, cần gửi riêng"*, mình sẽ liên hệ lại.

**Bước 3. Tạo issue**
1. Mở [**Issue mới**](https://github.com/binhake/fb-unsend-viewer/issues/new?template=bug_report.yml) (đã có sẵn mẫu báo lỗi, chỉ cần điền).
2. Mô tả lỗi, các bước tái hiện, tick môi trường.
3. **Kéo thả file `.json`** và ảnh chụp màn hình vào khung soạn thảo. Nếu GitHub không nhận file `.json` thì nén thành `.zip` rồi kéo vào.

> ⚠️ Nhớ **che tên, avatar và nội dung tin nhắn riêng tư** trong ảnh chụp và tệp log trước khi đăng lên issue.
>
> 💡 Trước khi báo lỗi, hãy thử **F5 lại tab Facebook**: sau khi cài hoặc cập nhật extension, các tab đang mở sẵn sẽ không ghi nhận tin nhắn cho tới khi được tải lại.

---

### ☕ Ủng hộ tác giả

Extension miễn phí và không có quảng cáo. Nếu thấy hữu ích, bạn có thể mời mình một ly cà phê để mình có thêm động lực duy trì và cập nhật mỗi khi Facebook thay đổi 🙏

<p align="center">
  <img src=".github/assets/donate-qr.png" alt="Mã QR ủng hộ binhake (MoMo / VietQR)" width="240" /><br/>
  <sub>Quét bằng app <b>MoMo</b> hoặc bất kỳ app ngân hàng nào (VietQR / napas 247)</sub><br/><br/>
  <a href="https://me.momo.vn/binhake" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Ủng%20hộ%20qua-MoMo-ae2070?style=for-the-badge" alt="Ủng hộ qua MoMo" /></a>
</p>

Không tiện ủng hộ thì cho repo 1 ⭐ cũng là động lực lớn rồi!

---

### 📄 Bản quyền & Giấy phép (License)

Dự án thuộc quyền sở hữu trí tuệ và bản quyền của **[binhake](https://github.com/binhake)** — phát hành theo **[Giấy phép Phi thương mại & Bắt buộc Ghi danh Tác giả (Non-Commercial & Strict Attribution License)](LICENSE)**:

- ✅ **Sử dụng cá nhân miễn phí**: Bạn được phép tải về và cài đặt sử dụng cho mục đích cá nhân, phi thương mại.
- 🔒 **Bắt buộc giữ nguyên 100% tên tác giả**: Mọi bản sao bắt buộc phải giữ nguyên tên tác giả **`binhake`**, liên kết kho lưu trữ gốc và nhãn bản quyền trên giao diện (`© binhake`). **Nghiêm cấm** xóa tên tác giả, đổi tên nhận vơ hoặc mạo danh chủ sở hữu dưới mọi hình thức.
- 🚫 **Nghiêm cấm thương mại hóa trái phép**: Không được phép bán, cho thuê, thu phí, gắn quảng cáo hoặc đăng tải lại lên các kho tiện ích (Chrome Web Store, Edge Add-ons...) khi chưa có sự đồng ý bằng văn bản và thỏa thuận chia sẻ quyền lợi/doanh thu (%) với tác giả **[binhake](https://github.com/binhake)**.

---

## 🇬🇧 English

### ✨ Key Features

- **Real-Time Background Interception (WebSocket & DOM Tracking)**: Passively caches incoming messages and detects unsend events on Facebook Messenger—even when the tab is in the background or the chat box is closed.
- **Full Multimedia Restoration**:
  - 💬 **Text, Emojis & Stickers**
  - 🖼️ **Images**: Always selects the highest-resolution original image, archives unsent media permanently as Base64 so it remains viewable even after Facebook CDN links expire, with built-in Lightbox preview and one-click download.
  - 🎵 **Voice Messages & Audio Clips**: Embedded `<audio controls>` player right inside the chat bubble and extension popup.
  - 🎬 **Videos**: Always selects the highest-quality HD/original video stream with an embedded `<video controls>` player and direct download option.
  - 📎 **File Attachments & Link Previews**
- **Full Message Edit History on Unsend**:
  - Captures and displays the original message along with every intermediate edit (`View edit history` / `Hide edit history`) in Facebook's native bubble style when an edited message is unsent.
- **Unlock "View Once" Photos & Videos**:
  - View once photos/videos that Facebook normally only lets you open in the mobile app, right in your desktop browser.
  - Works in **end-to-end encrypted (E2EE)** chats, including E2EE group chats.
  - Media is shown directly in the chat bubble and saved to the popup history with a `① Ảnh (Xem 1 lần)` / `① Video (Xem 1 lần)` (view once photo / video) label.
- **In-Place Chat DOM Restoration**:
  - Replaces the *"unsent a message"* placeholder directly inside the conversation with the original message content and an `[UNSENT]` badge.
  - Persists across page reloads (`F5`) using smart context-anchoring (`anchorText`, `prevAnchorText`, `nextAnchorText`) and timestamp matching.
  - Supports **1-on-1 Chats**, **Standard Group Chats**, and **Facebook Community Chats**.
- **Modern Popup & Side Panel Dashboard (Auto Light / Dark Mode)**:
  - Open history in **Chrome's Side Panel** to browse unsent messages alongside your chats.
  - Automatically extracts and displays **real sender avatars** (strictly matched by UID and thread context).
  - Built-in **Unsent Media Storage Manager** showing total archived media size with one-click cleanup (while keeping text messages intact).
  - **Automatic GitHub Releases Update Checker**: Displays a `NEW` badge and an in-app update banner when a newer release is available on GitHub (or click the version tag in the footer to check manually).
  - Instant search by message content or sender name.
  - Filter by conversation/thread or category (*All*, *Others*, *Self*, *With Media*).
  - Full JSON **Export & Import** for easy backup and migration, plus a one-click **Debug** log export button.
- **100% Local & Private**:
  - Zero external servers, zero analytics, zero tracking. All cached messages and media stay strictly inside your browser's local storage (`chrome.storage.local`).

---

### 🚀 Installation

Compatible with **Google Chrome**, **Microsoft Edge**, **Brave**, **Opera**, and all Chromium-based browsers.

#### Option 1: Download from Releases (Recommended)
1. Go to the [**Releases**](../../releases) page and download the latest `fb-unsend-viewer-v1.2.5.zip`.
2. Extract the `.zip` archive to a permanent folder on your computer.
3. Open your browser's extensions page:
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
   - **Brave**: `brave://extensions/`
4. Enable **Developer mode** in the top-right corner.
5. Click **Load unpacked** and select the extracted folder.
6. Open or refresh [facebook.com](https://www.facebook.com/) to start capturing messages.

#### Option 2: Clone via Git
```bash
git clone https://github.com/binhake/fb-unsend-viewer.git
```
Then navigate to `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the cloned directory.

---

### 🛠️ Troubleshooting & Debug Log Export

The extension has a built-in shortcut that exports a debug log. Attaching it to your issue makes bugs much faster to fix than a description alone.

**Step 1. Export the log right after the bug happens**
1. Stay on **the same Facebook tab where the bug happened** and **do not refresh**: the log lives in the tab's memory and is lost on reload.
2. Click an empty spot on the page so the page (not the address bar) has focus.
3. Press **`Alt + Shift + D`**.
4. The browser downloads `fb-unsend-debug-<number>.json` (usually into your **Downloads** folder).

> No file? Check whether Chrome blocked the download (icon on the right of the address bar). If the extension was just updated, old tabs no longer respond to the shortcut: refresh, wait for the bug to happen again, then export.

**Step 2. Remove private data from the log**

The log contains **recent message content, names of people in the chat, your Facebook ID** and the chat URL. Before posting publicly:
- Open it in Notepad / VS Code and use **Ctrl + H** to replace names and sensitive text with `xxx` (keep the `"` and `,` characters so the file stays valid).
- Or don't attach it publicly: write *"I have a log, need to send it privately"* in the issue and I'll get back to you.

**Step 3. Open an issue**
1. Open a [**new issue**](https://github.com/binhake/fb-unsend-viewer/issues/new?template=bug_report.yml) (a bug report template is provided).
2. Describe the bug, the steps to reproduce, and tick your environment.
3. **Drag and drop the `.json` file** and your screenshots into the editor. If GitHub rejects `.json`, zip it first.

> ⚠️ Please **blur names, avatars and private message content** in screenshots and logs before posting.
>
> 💡 Before reporting, try **refreshing the Facebook tab**: after installing or updating the extension, already-open tabs won't capture messages until they are reloaded.

---

### ☕ Support the author

This extension is free and ad-free. If it helps you, consider buying me a coffee so I can keep it working whenever Facebook changes things 🙏

<p align="center">
  <img src=".github/assets/donate-qr.png" alt="binhake donation QR code (MoMo / VietQR)" width="240" /><br/>
  <sub>Scan with <b>MoMo</b> or any Vietnamese banking app (VietQR / napas 247)</sub><br/><br/>
  <a href="https://me.momo.vn/binhake" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Donate%20via-MoMo-ae2070?style=for-the-badge" alt="Donate via MoMo" /></a>
</p>

A ⭐ on the repo helps a lot too!

---

## 📄 License & Copyright

Copyright © 2026 **[binhake](https://github.com/binhake)**. All rights reserved under the **[Non-Commercial & Strict Attribution License (CC BY-NC-ND 4.0 + Commercial Revenue-Sharing Clause)](LICENSE)**:

- **Personal Use Only**: Free to download and use strictly for personal, non-commercial purposes.
- **100% Mandatory Attribution**: You must retain 100% of the author's name (**`binhake`**), repository links, source code copyright headers, and in-app UI attribution (`© binhake`). Removing author credits or claiming this project as your own is strictly prohibited and subject to DMCA Takedown.
- **No Commercial Use Without Agreement**: Selling, paywalling, monetizing, or redistributing this extension on any store/marketplace without prior written consent, explicit author attribution, and a revenue-sharing (%) agreement with **[binhake](https://github.com/binhake)** is strictly forbidden.
