# MiniEventDJ — Sidebar đen/trắng + giao diện chính nguyên bản

- **Khôi phục giao diện chính**: giữ các màu đen/xám/trắng từ `src/tokens.css` và `src/style.css` của dự án, không còn nền xanh, card xanh hay thanh điều khiển xanh.
- **Chỉ sidebar đổi giao diện**: thanh điều hướng đen/trắng, mục được chọn nền trắng/chữ đen, tìm kiếm nhanh, nút thu gọn và mini player.
- Giữ nguyên giao diện, bố cục player, queue, preview, spectrum và EQ của `src/style.css`.
- Chỉ giữ chuyển trang fade/translate nhẹ; không làm lại layout nội dung.
- Các chức năng nhạc không thay đổi; source JS và Rust giữ như bản trước.
- Kiểm tra bằng Chromium không thay thế kiểm thử native Tauri/WebView2 trên Windows.

## File thay đổi so với gói BlackWhite trước
- `src/polish.css`: bỏ toàn bộ biến màu xanh toàn cục và các rule tô màu xanh phần nội dung; chỉ để rule sidebar cùng animation nhẹ.
