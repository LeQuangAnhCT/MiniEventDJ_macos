# MiniEventDJ — bản nguồn macOS

Bản nguồn này được tách riêng từ MiniEventDJ Windows. Mục Chỉnh sửa MP3 và công cụ cắt MP3 đã được bỏ khỏi bản Mac; phần phát các file MP3 vẫn được giữ. Đây là mã nguồn chuẩn bị cho macOS, chưa được build hoặc chạy thử trên Mac.

## Build cho Intel và Apple Silicon

Trên máy Mac, cài Xcode, Rust và Node.js theo [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), rồi mở Terminal tại thư mục dự án và chạy:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm run mac:universal
```

Lệnh yêu cầu Tauri tạo `.app` và `.dmg` Universal cho hai kiến trúc. Cần kiểm thử thực tế trên cả Intel và Apple Silicon, đặc biệt là phát/đổi bài, thiết bị âm thanh, nghe thử, định dạng âm thanh, thư viện và cửa sổ điều khiển nhanh. Một số chức năng Web Audio và codec phụ thuộc phiên bản macOS/WebKit. Bản Universal không đảm bảo chạy trên mọi phiên bản macOS hoặc mọi thiết bị.

## Ký và xác thực ứng dụng

Để phân phối ngoài App Store và hạn chế cảnh báo Gatekeeper, chủ sở hữu cần một tài khoản Apple Developer đủ điều kiện, chứng chỉ Developer ID Application và notarization. Làm theo [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) để cấu hình chứng chỉ và thông tin xác thực trên máy Mac hoặc CI. Không lưu khóa hay mật khẩu trong dự án. Bản chưa ký/notarize có thể bị cảnh báo hoặc từ chối mở.

Không có bảo đảm tuyệt đối rằng mọi máy đều không cảnh báo hoặc gặp lỗi: phiên bản macOS, chính sách bảo mật và trạng thái chứng chỉ có thể khác nhau.

## Build thử bằng GitHub Actions

Workflow `.github/workflows/build-macos.yml` chạy thủ công trên máy macOS do GitHub cung cấp. Đưa thư mục dự án lên một repository GitHub riêng, mở Actions, chọn **Build macOS Universal (test)** và **Run workflow**. Khi chạy thành công, tải artifact `MiniEventDJ-macOS-Universal-test` ở trang của lượt chạy.

Workflow này ký ad-hoc để thử nghiệm, không dùng chứng chỉ Developer ID và không notarize. File tải về vẫn có thể bị Gatekeeper cảnh báo/chặn. Để phân phối chính thức, cần cấu hình ký và notarization theo hướng dẫn phía trên. Workflow chưa được chạy thử trong môi trường này.
