# MiniEventDJ — giao diện Bàn phát nhạc được duyệt

- Giữ nguyên sidebar/taskbar đen-trắng, thanh trạng thái đáy, Thư viện, Cài đặt và logic phát nhạc.
- Bố cục LIVE DECK mới: album minh họa monochrome, tên bài, waveform/thanh tua, nút Play ở giữa, Tempo gọn, âm lượng tổng.
- Stereo Output 2 cột L/R thẳng đứng, bar lớn như mockup. Sử dụng analyser âm thanh đã có, không phát sinh audio engine mới.
- Waveform chỉ xuất hiện khi dữ liệu `activeAnalysis.peaks` có mẫu. Không có mẫu (đang tải / track dài / lỗi phân tích) sẽ có thanh tiến trình thay thế cùng chiều rộng; cả hai có thể nhấn/kéo để tua.
- Xem trước bài tiếp theo: cơ chế fallback tương tự.
- Đã giới hạn màu ở trắng/xám/đen; không thay đổi sidebar hay token màu chung.
- Các hiệu ứng CSS sử dụng transform/opacity, có hỗ trợ prefers-reduced-motion.
- Đây là mã nguồn, chưa được build thành .exe trên Windows.
