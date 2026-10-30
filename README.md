# MiniEventDJ — bản nguồn macOS

Bản nguồn này được tách riêng từ MiniEventDJ Windows. Mục Chỉnh sửa MP3 và công cụ cắt MP3 đã được bỏ khỏi bản Mac; phần phát các file MP3 vẫn được giữ. Bản 2.2.8 đã được build và chạy thử trên Mac Apple Silicon. Yêu cầu macOS 15.4 trở lên; bản Intel/Universal cần được kiểm thử riêng.

## Cập nhật trong 2.2.8

- Mở file và quét thư mục nhạc trên luồng nền để tránh chặn giao diện.
- Bổ sung khai báo microphone trong `Info.plist` và entitlement `audio-input` cho Hardened Runtime. Microphone chỉ được mở tạm để liệt kê thiết bị, không ghi âm.
- Định tuyến nhạc chính sau EQ qua bộ phát riêng trên WebKit khi `AudioContext.setSinkId` không khả dụng; nghe thử dùng bộ phát độc lập.
- Hiển thị thời gian hiện tại và tổng thời lượng bên dưới thanh phát; hiển thị phút:giây tại vị trí rê chuột/kéo tua và giữ thời gian ổn định trong lúc kéo.

## Build và đóng gói trên Mac Apple Silicon

Cài Xcode Command Line Tools, Rust và Node.js, rồi chạy tại thư mục dự án:

```sh
npm ci
npm test
npm run build -- --target aarch64-apple-darwin --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
mkdir -p release
pkgbuild --component src-tauri/target/aarch64-apple-darwin/release/bundle/macos/MiniEventDJ.app --identifier vn.lequanganh.minieventdj.pkg --version 2.2.8 --install-location /Applications release/MiniEventDJ_2.2.8_AppleSilicon.pkg
```

Bộ cài `.pkg` cài ứng dụng vào `/Applications`. Máy nhận không cần Node.js, Rust hoặc `node_modules`. Cấp quyền microphone khi cần liệt kê thiết bị rồi chọn riêng đầu ra nhạc chính và nghe thử trong Cài đặt của MiniEventDJ. Bản thử ký ad-hoc chưa được notarize.

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

Workflow `.github/workflows/build-macos.yml` chạy thủ công trên máy macOS do GitHub cung cấp. Trong repository này, mở Actions, chọn **Build macOS Universal (test)** và **Run workflow**. Khi chạy thành công, tải artifact `MiniEventDJ-macOS-Universal-test` ở trang của lượt chạy.

Workflow này ký ad-hoc để thử nghiệm, không dùng chứng chỉ Developer ID và không notarize. File tải về vẫn có thể bị Gatekeeper cảnh báo/chặn. Để phân phối chính thức, cần cấu hình ký và notarization theo hướng dẫn phía trên. Workflow chưa được chạy thử trong môi trường này.
