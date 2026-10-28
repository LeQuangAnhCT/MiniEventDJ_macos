# MiniEventDJ — Bàn phát nhạc đen/trắng v2

- Giữ nguyên sidebar/taskbar, trang thư viện, hàng chờ và settings.
- Gỡ ảnh minh họa album, LIVE DECK, thời lượng ở khu vực Đang phát (đồng hồ vẫn được dùng nội bộ cho việc tua).
- Tên bài dùng `state.active.name` thực tế; trạng thái Đang phát/Tạm dừng/Chưa chọn bài phản ánh `state.playbackState`.
- Thêm nút Bài trước và Bài sau có chức năng dựa trên thứ tự playlist, bỏ nút chữ “Tiếp”. Bài trước vòng về cuối hàng chờ nếu đang ở đầu.
- Biểu tượng đồng hồ tốc độ, căn thẳng +/−/reset; Tempo vẫn giữ 80–120%.
- Thu hẹp hai cột L/R (vẫn đo riêng hai kênh thực tế), giảm khoảng trống dưới bằng cách bỏ stretch.
- Spectrum vùng player vẽ thanh phân đoạn trắng/xám trên nền lưới; vẫn đọc dữ liệu WebAudio thực tế, không thay đổi xử lý tín hiệu.
- Waveform khi có dữ liệu và progress khi không có dữ liệu vẫn hoạt động theo cơ chế đã có.
- Không đổi theme sang xanh; không thay các API Tauri.
