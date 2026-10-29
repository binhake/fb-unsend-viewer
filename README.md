<div align="center">
  <img src="icons/logo.svg" alt="FB Unsend Message Viewer Logo" width="110" height="110" />
  <h1>FB Unsend Message Viewer</h1>
  <p>
    <strong>Tiện ích mở rộng trình duyệt giúp ghi nhận ngầm và khôi phục tin nhắn bị gỡ trên Facebook Messenger theo thời gian thực.</strong><br/>
    <em>Browser extension that silently captures and restores unsent messages on Facebook Messenger in real time.</em>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-2563eb?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/Version-1.2.4-7c3aed?style=flat-square" alt="Version 1.2.4" />
    <img src="https://img.shields.io/badge/Privacy-100%25%20Local-10b981?style=flat-square" alt="100% Local Privacy" />
    <img src="https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square" alt="License MIT" />
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
  - 🖼️ **Hình ảnh**: Tự động nén lưu đệm sang chuẩn WebP nhẹ, xem ảnh phóng to (Lightbox) và tải về máy.
  - 🎵 **Tin nhắn thoại (Voice / Audio clip)**: Tích hợp trình phát `<audio controls>` nghe lại trực tiếp ngay tại khung chat và trong Popup.
  - 🎬 **Video**: Tích hợp trình phát `<video controls>` xem và tải về trực tiếp.
  - 📎 **Tệp đính kèm & Liên kết xem trước (File / Link preview)**
- **Hiển thị trực tiếp tại vị trí bị gỡ trên khung chat**:
  - Thay thế dòng báo *"đã thu hồi một tin nhắn"* bằng khung nội dung gốc kèm nhãn `[ĐÃ GỠ]`.
  - Bám đúng vị trí tin nhắn ngay cả sau khi tải lại trang (F5) thông qua thuật toán neo ngữ cảnh (`anchorText`, `prevAnchorText`, `nextAnchorText`) và thời gian thực.
  - Hỗ trợ đầy đủ **Chat cá nhân (1-1)**, **Nhóm chat thường**, và **Đoạn chat cộng đồng (Community Chat)** trên Facebook.
- **Giao diện quản lý Popup hiện đại (Hỗ trợ Sáng / Tối tự động)**:
  - Tìm kiếm tức thì theo nội dung hoặc tên người gửi.
  - Lọc nhanh theo cuộc trò chuyện / nhóm chat, hoặc theo phân loại (*Tất cả*, *Người khác*, *Bạn gỡ*, *Có ảnh*).
  - Sao lưu (Export) và Khôi phục (Import) toàn bộ lịch sử qua tệp `.json`.
- **Quyền riêng tư tuyệt đối (100% Offline / Local)**:
  - Không máy chủ trung gian, không thu thập dữ liệu, không gửi bất kỳ thông tin nào ra bên ngoài. Toàn bộ dữ liệu chỉ nằm trong bộ nhớ trình duyệt (`chrome.storage.local`) trên máy của bạn.

---

### 🚀 Hướng dẫn cài đặt

Bạn có thể cài đặt trên **Google Chrome**, **Microsoft Edge**, **Brave**, **Cốc Cốc**, hoặc bất kỳ trình duyệt nhân Chromium nào.

#### Cách 1: Tải bản đóng gói sẵn (Khuyên dùng)
1. Truy cập mục [**Releases**](../../releases) ở góc phải trang GitHub này và tải tệp `fb-unsend-viewer-v1.2.4.zip` mới nhất.
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

Nếu bạn gặp trường hợp tin nhắn bị gỡ chưa hiển thị đúng tên nhóm hoặc vị trí trên một giao diện Facebook mới:
1. Tại tab Facebook đang mở, nhấn tổ hợp phím **`Alt + Shift + D`**.
2. Trình duyệt sẽ tự động tải xuống tệp `fb-unsend-debug-<timestamp>.json` chứa thông tin cấu trúc DOM/WebSocket liên quan đến bộ nhớ đệm.
3. Mở một [**Issue mới**](../../issues) trên GitHub và đính kèm tệp log này (hoặc ảnh chụp màn hình) để mình hỗ trợ xử lý nhanh nhất.

---

## 🇬🇧 English

### ✨ Key Features

- **Real-Time Background Interception (WebSocket & DOM Tracking)**: Passively caches incoming messages and detects unsend events on Facebook Messenger—even when the tab is in the background or the chat box is closed.
- **Full Multimedia Restoration**:
  - 💬 **Text, Emojis & Stickers**
  - 🖼️ **Images**: Automatically cached in lightweight WebP format with built-in Lightbox preview and one-click download.
  - 🎵 **Voice Messages & Audio Clips**: Embedded `<audio controls>` player right inside the chat bubble and extension popup.
  - 🎬 **Videos**: Embedded `<video controls>` player with direct download option.
  - 📎 **File Attachments & Link Previews**
- **In-Place Chat DOM Restoration**:
  - Replaces the *"unsent a message"* placeholder directly inside the conversation with the original message content and an `[UNSENT]` badge.
  - Persists across page reloads (`F5`) using smart context-anchoring (`anchorText`, `prevAnchorText`, `nextAnchorText`) and timestamp matching.
  - Supports **1-on-1 Chats**, **Standard Group Chats**, and **Facebook Community Chats**.
- **Modern Popup Dashboard (Auto Light / Dark Mode)**:
  - Instant search by message content or sender name.
  - Filter by conversation/thread or category (*All*, *Others*, *Self*, *With Media*).
  - Full JSON **Export & Import** for easy backup and migration.
- **100% Local & Private**:
  - Zero external servers, zero analytics, zero tracking. All cached messages and media stay strictly inside your browser's local storage (`chrome.storage.local`).

---

### 🚀 Installation

Compatible with **Google Chrome**, **Microsoft Edge**, **Brave**, **Opera**, and all Chromium-based browsers.

#### Option 1: Download from Releases (Recommended)
1. Go to the [**Releases**](../../releases) page and download the latest `fb-unsend-viewer-v1.2.4.zip`.
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

If an unsent message does not restore in the expected position due to a Facebook UI update:
1. While on the Facebook tab, press **`Alt + Shift + D`**.
2. A diagnostic file named `fb-unsend-debug-<timestamp>.json` will be downloaded automatically.
3. Open a [**GitHub Issue**](../../issues) and attach the debug file or screenshot so we can investigate and fix it quickly.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) © 2026 [binhake](https://github.com/binhake).
