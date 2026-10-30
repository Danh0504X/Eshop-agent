# FixIt AI Agent — Bối cảnh, nhật ký và hướng đi

> Cập nhật: 30/10/2026 · Nhánh: `feature/scan-first-flow` (tách từ `development`).
> Đây là tài liệu sống: cập nhật sau mỗi phase. Chi tiết kỹ thuật của từng thay đổi nằm ở [CHANGELOG_AGENT.md](CHANGELOG_AGENT.md).
> Lưu ý: [FIXIT_AGENT_OVERVIEW.md](FIXIT_AGENT_OVERVIEW.md) viết trước đợt thiết kế lại này nên **đã lỗi thời** ở nhiều chỗ (xem mục 6).

---

## 1. Bối cảnh và mục tiêu

- **Sản phẩm chính là AI Agent:** tự động hóa việc kiểm tra hàng hoàn bằng cách so sánh **video đóng gói** (lúc gửi hàng) với **video mở hàng hoàn** (lúc nhận hàng trả về), rồi đưa ra kết luận và việc cần làm cho chủ shop.
- **Agent sẽ được phát triển tiếp trong cuộc thi AI Agent chính thức.** Vì vậy code của agent phải dễ hiểu và dễ debug, không chỉ chạy được.
- Backend thông thường (CRUD, upload, quét mã, claim), frontend cũ `frontend/` và frontend mới `web/` là phần hạ tầng để chạy và trình diễn agent.

### Nguyên tắc làm việc

| Nguyên tắc | Cách áp dụng |
|---|---|
| Ưu tiên AI Agent | Công sức tập trung vào `backend/src/agent/` và các service vision, so sánh, kiểm tra bằng chứng |
| Backend thông thường giữ đơn giản | Không chồng thêm ràng buộc hay kiểm tra phòng thủ nếu không cần; chỉ ghi chú những chỗ có thể làm chặt hơn |
| Agent phải log rõ ra terminal | Mọi bước của agent in ra console qua [agentTrace.ts](../backend/src/agent/agentTrace.ts) (`AGENT_TRACE=true`). Khi đổi hành vi agent thì thêm hoặc chỉnh trace tương ứng |
| Quy trình git | Làm trên nhánh riêng, commit nhỏ theo từng tính năng; người phát triển tự `git add` và `git commit` |

---

## 2. Luồng AI Agent hiện tại (tóm tắt)

Luồng **mặc định** (`AGENT_PLANNER=deterministic`, `AI_PROVIDER=gemini`) theo thứ tự cố định trong [deterministicPlanner.ts](../backend/src/agent/planners/deterministicPlanner.ts):

```
1. lookup_order            lấy "chuẩn" từ đơn: sản phẩm, số lượng, phụ kiện
2. validate_evidence (1)   đủ 2 video? đúng đơn? đọc được? video có đi qua phiên quét nhãn không?
3-4. extract_frames ×2     FFmpeg: 8 frame/video, đo sáng/nét, tính liên tục → cổng chất lượng sớm
5-6. analyze_item ×2       Gemini mô tả TỪNG video riêng (JSON có cấu trúc, mỗi thuộc tính observed/uncertain/not_visible)
7. compare_items           CODE so sánh 2 bản mô tả → findings
8. validate_evidence (2)   kiểm tra cuối: confidence, ảnh dùng được, thuộc tính then chốt
9. build_claim_pack        chỉ khi không có lý do chặn và có sai lệch đáng kể
10. notify_human           khi có lý do chặn hoặc advisory
→ guardrail → chốt kết quả bằng cách đọc lại DB (completed | needs_review | failed)
```

- **Chuẩn so sánh:**
  - Video đóng gói là mốc cho video hoàn.
  - Đơn hàng chỉ làm mốc cho số lượng thấy trong video đóng gói.
  - Chỉ so một thuộc tính khi **cả hai bên đều `observed`**.
  - **Sai lệch đáng kể** = mức ≥ medium **và** `observed`. Logic nằm ở [comparisonService.ts](../backend/src/services/comparisonService.ts).
- **Gemini chỉ được gọi ở bước 5–6.** Mọi so sánh và quyết định đều là quy tắc trong code.
- **Chế độ `AGENT_PLANNER=llm`:** Gemini tự chọn tool qua function calling ([geminiPlanner.ts](../backend/src/agent/planners/geminiPlanner.ts)), và có thêm **vòng soi lại** `inspect_video_segment` (tối đa 3 đoạn, mỗi đoạn ≤ 10 s; tối đa 16 lượt AI). Chế độ `deterministic` **không** bao giờ soi lại.
- **Log terminal:** mỗi lần kiểm tra in ra:
  - `START`
  - từng quyết định của planner, kèm `why`
  - `OK` / `FAIL` của từng tool, kèm kết quả tóm tắt
  - từng lượt gọi Gemini, kèm thời gian và số token
  - `GUARDRAIL`
  - `RESULT`

---

## 3. Các quyết định đã chốt (đợt thiết kế lại "quét mã trước")

| Quyết định | Lý do / ghi chú |
|---|---|
| **Bỏ việc AI đọc mã vận đơn trong video** | Việc gắn video với đơn chuyển sang thao tác quét nhãn; giảm số ca "cần người xem" chỉ vì không đọc rõ chữ trên nhãn |
| **Mọi video bắt buộc đi qua phiên quét nhãn** | Video không có phiên quét bị chặn với `EVIDENCE_NOT_SCANNED`, trước khi gọi AI |
| **Bỏ toàn bộ phần tiền** (giá trị đơn, quy tắc đơn giá trị cao, theo dõi hoàn tiền) | Việc kiểm tra chỉ tập trung so sánh sản phẩm. Tình huống bắt buộc #9 (hoàn tiền thấp hơn yêu cầu) bị bỏ có chủ đích |
| **Mã đơn do backend tự sinh**: `ORD-YYMMDD-XXXX` | Bỏ các ký tự dễ nhầm 0/O/1/I/L; mỗi mã vận đơn chỉ thuộc một đơn |
| **Cho nhập tay khi nhãn hỏng**, có gắn nhãn "Mã nhập tay" | Chỉ là nhãn hiển thị, không ép chuyển cho người duyệt |
| **Quét mã bằng camera và ảnh tải lên**; không hỗ trợ máy quét cầm tay | Ảnh tải lên chỉ có ở bản demo |
| **`ALLOW_FILE_EVIDENCE`**: cho phép đính kèm video có sẵn từ máy (bản demo) | Mặc định `false`; production chỉ cho quay trực tiếp trong app |
| **Kiểm tra "video không dài hơn thời gian từ lúc quét"**: **tạm tắt** (đã comment) | Để còn upload được video cũ trong lúc thử nghiệm. Cách bật lại có ghi trong `mediaService.uploadEvidence` |
| **Quét `packing` một mã đã có đơn → trả về đơn đó** | Để vẫn bổ sung hoặc thay được video đóng gói; không tạo được đơn thứ hai |
| **Frontend mới `web/`** (giao diện thực tế, không hiện log); **`frontend/` cũ chỉ sửa tối thiểu** | `frontend/` vẫn là bản demo, mọi thứ tạo từ đó đều bị gắn nhãn "nhập tay" |

---

## 4. Nhật ký công việc trên nhánh `feature/scan-first-flow`

| Commit | Nội dung |
|---|---|
| `73117d3` | docs: thêm tài liệu tổng quan agent (trước đợt thiết kế lại) |
| `f62663d` | B1: bỏ giá trị đơn, quy tắc đơn giá trị cao và theo dõi hoàn tiền |
| `0271c2c` | style: format Prettier các file của B1 |
| `c3f318d` | B2: AI không đọc mã đơn / mã vận đơn trong video nữa |
| `c441046` | B3: phiên quét nhãn (`POST /api/scans`) + tạo đơn từ phiên quét, mã đơn tự sinh |
| `170b8d3` | B4: mọi upload video bắt buộc có phiên quét; `EVIDENCE_NOT_SCANNED`; `ALLOW_FILE_EVIDENCE`; đo được độ dài video WebM quay từ trình duyệt |
| `d70fe62` | Frontend cũ: sửa tối thiểu cho luồng quét mã |
| `9a4cf15` | `web/`: khung app, đăng nhập, layout responsive, chip chế độ AI |
| `0684774` | `web/`: quét mã (camera, ảnh), quay video bằng webcam, trang thử thiết bị `/dev/devices` |
| `43cbc9c` | `web/`: màn hình Thêm đơn 3 bước |

**Phát hiện quan trọng trong quá trình làm:**
- **Lỗ hổng của B3, đã sửa ở B4:** quét `packing` một mã đã có đơn từng trả lỗi 409, nên không còn cách nào bổ sung video đóng gói cho đơn đó.
- **Video WebM quay bằng `MediaRecorder` không ghi độ dài trong header** (`duration=N/A`). `probeVideo` giờ tính độ dài từ timestamp của packet; đã kiểm chứng với file Chrome quay thật: 3,2 s.
- **Chrome báo hỗ trợ codec VP9 nhưng quay ra file rỗng (0 byte).** App giờ ưu tiên VP8, và không cho dùng bản quay rỗng.
- **Backend:** 175 test pass, 3 skip (2 test gọi API thật, 1 test kiểm tra thời gian quay đang tắt).

---

## 5. Hướng đi tiếp theo

### 5.1 Ngay tiếp theo: quay về AI Agent

1. **Chạy kiểm tra thật với Gemini và đọc log trace.**
   - Chỉnh trace cho dễ theo dõi và debug, ví dụ: khối tóm tắt quyết định cuối, chi tiết từng finding khi so sánh, thời gian của từng bước.
   - **Còn chờ:** dùng cặp video thật hay video seed. Video seed chỉ là hình mẫu tổng hợp, nên kết quả gần như chắc chắn là "cần người xem". Lần chạy này tốn quota Gemini, khoảng 2 lượt AI với planner `deterministic`.
2. **Sửa lỗi bất đối xứng tên sản phẩm.** Gemini mô tả 2 video trong 2 lần gọi độc lập, nên cùng một sản phẩm có thể bị gọi bằng hai tên khác nhau và bị tính là sai lệch. Code hiện so chuỗi tuyệt đối ở [comparisonService.ts](../backend/src/services/comparisonService.ts).
   - **Lớp 1, prompt:** `productType` chỉ là một danh từ chung tiếng Anh; `model` chỉ chép từ chữ in thấy trong frame, không lấy từ checklist.
   - **Lớp 2, code so sánh:** ưu tiên khớp model; bỏ tên brand ở đầu model; so `productType` theo từ; bỏ dấu tiếng Việt bằng chuẩn hóa Unicode thay vì xóa ký tự. Không cho phép kiểu "chuỗi này chứa chuỗi kia" với model, để `SW-200` và `SW-200-LITE` vẫn bị bắt là sai lệch.
   - **Lớp 3, xác minh bằng hình:** khi vẫn thấy khác, thêm tool `verify_product_match` cho Gemini xem ảnh của cả 2 video trong cùng một lần gọi, trả về `same` / `different` / `uncertain`. Code vẫn là bên quyết định mức độ và có tạo claim hay không.
3. **Giảm chi phí AI:**
   - đặt thinking level riêng cho vision (hiện `GEMINI_THINKING_LEVEL` đang để trống, dùng mặc định của model)
   - không gửi frame tối hoặc mờ cho Gemini (hiện vẫn gửi cả 8 frame)
   - dừng sớm nếu video đóng gói đã dính lỗi chặn
   - cache kết quả phân tích khi retry
4. **Planner hybrid:** code chạy các bước bắt buộc 1–7; chỉ gọi Gemini planner khi kết quả so sánh còn điểm chưa rõ. Ca rõ ràng chỉ tốn 2 lượt AI.
5. **Cân nhắc sau:**
   - bật lại kiểm tra thời gian quay
   - tool `link_media` gần như không dùng được với planner (upload đã tự gắn video vào đơn)
   - chọn planner cho bản thi: `deterministic`, `llm` hay `hybrid`

### 5.2 Frontend `web/` còn lại

| Bước | Nội dung |
|---|---|
| 9 | Danh sách đơn + chi tiết đơn + thẻ kết quả kiểm tra (câu tiếng Việt, ảnh frame làm căn cứ) |
| 10 | Nhận hàng hoàn: quét → quay video mở hàng → gửi và kiểm tra → tiến trình → kết quả |
| 11 | Khiếu nại: danh sách, chi tiết, PDF, duyệt / từ chối |
| 12 | `web/README.md` + cập nhật tài liệu |

### 5.3 Tài liệu

- Cập nhật [FIXIT_AGENT_OVERVIEW.md](FIXIT_AGENT_OVERVIEW.md), hiện còn ghi Claude, 9 tool, việc đọc mã trên nhãn, phần tiền và chưa có vòng soi lại.

---

## 6. Ghi chú vận hành

- **`backend/.env` ở máy dev:**
  - thêm `ALLOW_FILE_EVIDENCE=true`
  - có thể xóa `REQUIRE_VISIBLE_ORDER_ID` và `HIGH_VALUE_THRESHOLD` (hai biến này giờ bị bỏ qua)
  - chạy `npm run seed -- --reset` để làm sạch dữ liệu cũ, vì video cũ không có phiên quét sẽ bị chặn
- **`backend.zip` ở gốc repo chứa `backend/.env`** (có API key và JWT secret). **Không được commit**; nên chuyển ra ngoài repo hoặc thêm `*.zip` vào `.gitignore`.
- **Chạy app:**
  - backend: `cd backend` → `npm run dev` (cổng 4000)
  - web: `cd web` → `npm run dev` (cổng 5174)
  - frontend cũ: `cd frontend` → `npm run dev` (cổng 5173)
- **Thử camera:** đăng nhập rồi mở `http://localhost:5174/dev/devices`. Trên điện thoại: `npm run dev:https`, rồi mở địa chỉ `https://<IP-máy>:5174` và chấp nhận chứng chỉ tự ký.
- **Theo dõi agent:** để `AGENT_TRACE=true` rồi xem terminal của backend; mỗi dòng có dạng `[FixIt <mã đơn> +<giây>s] ...`.

---

## 7. Câu hỏi còn mở

1. Lần chạy Gemini thật sắp tới dùng video thật hay video seed?
2. Đề bài cuộc thi có bắt buộc phát hiện "thiếu / sai mã đơn" **từ nội dung video** không? (Hiện đã bỏ, thay bằng kiểm tra ở bước quét.)
3. Bản dự thi dùng planner nào: `deterministic`, `llm` hay `hybrid`?
