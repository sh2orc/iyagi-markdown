//! PDF 내보내기 — 숨은 WKWebView에서 완성된 HTML을 벡터 PDF로 변환한다(§4-4).
//!
//! - HTML은 `loadHTMLString:`로 메모리에서 직접 올린다 — 임시 파일을 만들지 않는다.
//! - 로드 완료 대기는 WKNavigationDelegate 대신 `isLoading` 폴링: 런루프를
//!   돌리며 주기적으로 검사한다(델리게이트 클래스 등록이 필요 없다).
//! - 페이지 크기는 WKPDFConfiguration.rect로 준다 — WebKit이 인쇄용으로
//!   콘텐츠를 페이지로 나눠 벡터로 뽑는다(코드블록·표 분할 포함).
//! - mermaid 인라인 SVG·KaTeX 수식은 WebKit PDF 경로에서 벡터로 그대로
//!   살아남는다(§4-3 — 래스터화 없음).
//!
//! 모든 Objective-C 호출은 메인 스레드에서(`run_on_main_thread`) 일어나며,
//! 오토릴리즈 풀 하나 안에서 끝낸다. 실패는 그대로 Err 문자열로 반환.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyClass;
use objc2::{class, msg_send};
use objc2_foundation::{NSData, NSString, NSPoint, NSRect, NSSize};
use tauri::AppHandle;

use crate::commands::PdfOptions;

// WebKit 심볼(class! 조회)이 로드되게 링커에 지시한다.
#[link(name = "WebKit", kind = "framework")]
extern "C" {}

/// 종이 규격(px @96dpi — CSS 픽셀과 WKWebView 좌표가 일치).
fn paper_px(paper: &str, orientation: &str) -> (f64, f64) {
    let mm = match paper {
        "letter" => (215.9, 279.4),
        "a5" => (148.0, 210.0),
        _ => (210.0, 297.0), // a4 기본
    };
    let (w, h) = (mm.0 / 25.4 * 96.0, mm.1 / 25.4 * 96.0);
    if orientation.eq_ignore_ascii_case("landscape") {
        (h, w)
    } else {
        (w, h)
    }
}

const LOAD_START_TIMEOUT: Duration = Duration::from_secs(5);
const LOAD_TIMEOUT: Duration = Duration::from_secs(45);
const JS_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn export_pdf(
    app: &AppHandle,
    html: String,
    options: &PdfOptions,
    out_path: &Path,
) -> Result<(), String> {
    // margin_mm·scale는 프런트가 HTML(CSS)에 이미 반영했다 — 여기선 로그만.
    tracing::debug!(
        paper = %options.paper,
        orientation = %options.orientation,
        margin_mm = options.margin_mm,
        scale = options.scale,
        "PDF 내보내기"
    );
    let (page_w, page_h) = paper_px(&options.paper, &options.orientation);
    let opts = (page_w, page_h);
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let html_out = out_path.to_path_buf();

    app.run_on_main_thread(move || {
        let result = autoreleasepool(|_| run_on_main(&html, opts));
        let outcome = match result {
            Ok(b) => md_core::io::write_bytes_atomic(&html_out, &b)
                .map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        let _ = tx.send(outcome);
    })
    .map_err(|e| format!("메인 스레드 작업 예약 실패: {e}"))?;

    rx.recv().map_err(|_| "PDF 생성이 중단되었습니다")?
}

/// 메인 스레드에서 실제 WebKit 작업을 수행한다.
fn run_on_main(html: &str, (page_w, page_h): (f64, f64)) -> Result<Vec<u8>, String> {
    unsafe {
        let wk_class: &AnyClass = class!(WKWebView);
        let cfg_class: &AnyClass = class!(WKWebViewConfiguration);
        let pdf_cfg_class: &AnyClass = class!(WKPDFConfiguration);

        let cfg: *mut objc2::runtime::AnyObject = msg_send![cfg_class, alloc];
        let cfg: *mut objc2::runtime::AnyObject = msg_send![cfg, init];

        // 폭은 종이 폭, 높이는 일단 한 페이지 — 로드 뒤 내용 높이로 늘린다.
        let frame = rect(0.0, 0.0, page_w, page_h);
        let webview: *mut objc2::runtime::AnyObject = msg_send![wk_class, alloc];
        let webview: *mut objc2::runtime::AnyObject =
            msg_send![webview, initWithFrame: frame, configuration: cfg];
        if webview.is_null() {
            return Err("WKWebView를 만들지 못했습니다".into());
        }

        let html_str = NSString::from_str(html);
        let nil_url: *const objc2::runtime::AnyObject = std::ptr::null();
        let _: *mut objc2::runtime::AnyObject =
            msg_send![webview, loadHTMLString: &*html_str, baseURL: nil_url];

        // 1) 로드 시작 대기 → 2) 완료 대기. isLoading 폴링.
        //    아주 작은 문서는 시작 신호를 놓칠 수 있어 최소 한 틱은 돈다.
        run_loop_tick();
        let mut saw_loading = false;
        let start_deadline = Instant::now() + LOAD_START_TIMEOUT;
        while Instant::now() < start_deadline {
            let loading: bool = msg_send![webview, isLoading];
            if loading {
                saw_loading = true;
                break;
            }
            run_loop_tick();
        }
        if saw_loading {
            spin_until(LOAD_TIMEOUT, || {
                let loading: bool = msg_send![webview, isLoading];
                !loading
            })?;
        } else {
            // 시작도 관측 못 했다면 이미 끝났을 가능성 — 레이아웃 정정 시간만 준다.
            let settle = Instant::now() + Duration::from_millis(250);
            while Instant::now() < settle {
                run_loop_tick();
            }
        }

        // 내용 높이 측정 → 프레임 확장(스크롤 영역 전체가 PDF 대상이 되게).
        let height = eval_number(
            webview,
            "Math.ceil(Math.max(document.body.scrollHeight, \
             document.documentElement.scrollHeight, document.body.offsetHeight || 0))",
        )?;
        let full_h = height.max(page_h);
        let full_frame = rect(0.0, 0.0, page_w, full_h);
        let _: () = msg_send![webview, setFrame: full_frame];
        // 프레임 변경 레이아웃이 정리될 시간을 조금 준다.
        spin_until(Duration::from_millis(300), || false).ok();

        // PDF 생성 — rect가 페이지 크기, WebKit이 페이지 단위로 나눈다.
        let pdf_cfg: *mut objc2::runtime::AnyObject = msg_send![pdf_cfg_class, alloc];
        let pdf_cfg: *mut objc2::runtime::AnyObject = msg_send![pdf_cfg, init];
        let page_rect = rect(0.0, 0.0, page_w, page_h);
        let _: () = msg_send![pdf_cfg, setRect: page_rect];

        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let block = RcBlock::new(move |data: *mut NSData, error: *mut objc2::runtime::AnyObject| {
            if !error.is_null() {
                // localizedDescription는 자동해제 반환 — 오토릴리즈 풀 안에서만 쓴다.
                let desc: *mut NSString = msg_send![error, localizedDescription];
                let _ = tx.send(Err(format!("PDF 생성 실패: {}", &*desc)));
                return;
            }
            if data.is_null() {
                let _ = tx.send(Err("PDF 생성 실패: 결과가 비었습니다".into()));
                return;
            }
            let len = (*data).len();
            let raw: *const std::ffi::c_void = msg_send![data, bytes];
            let bytes = std::slice::from_raw_parts(raw as *const u8, len);
            let _ = tx.send(Ok(bytes.to_vec()));
        });
        let _: () = msg_send![webview, createPDFWithConfiguration: pdf_cfg, completionHandler: &*block];
        // 블록은 WebKit 쪽에서 곧 부르지만, 우리가 runloop을 돌려야 실행된다.
        let deadline = Instant::now() + JS_TIMEOUT;
        let result = loop {
            if let Ok(res) = rx.try_recv() {
                break res;
            }
            if Instant::now() > deadline {
                break Err("PDF 생성 시간 초과".into());
            }
            run_loop_tick();
        };
        // 명시적 정리(alloc으로 얻은 소유분 — 오토릴리즈 풀이 대신해 주지 않는다).
        let _: () = msg_send![webview, stopLoading];
        let _: () = msg_send![webview, release];
        let _: () = msg_send![cfg, release];
        let _: () = msg_send![pdf_cfg, release];
        result
    }
}

/// 런루프를 짧게 굴려 대기 중인 블록/타이머가 실행되게 한다.
unsafe fn run_loop_tick() {
    let rl_class: &AnyClass = class!(NSRunLoop);
    let rl: *mut objc2::runtime::AnyObject = msg_send![rl_class, currentRunLoop];
    let date_class: &AnyClass = class!(NSDate);
    let date: *mut objc2::runtime::AnyObject =
        msg_send![date_class, dateWithTimeIntervalSinceNow: 0.05f64];
    extern "C" {
        static NSDefaultRunLoopMode: *const objc2::runtime::AnyObject;
    }
    let mode = NSDefaultRunLoopMode;
    let _: bool = msg_send![rl, runMode: mode, beforeDate: date];
}

/// 조건이 참이 되거나 시간이 지날 때까지 런루프를 돌린다.
unsafe fn spin_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    // 조건이 이미 참이면(로드 시작 대기 등) 즉시 통과.
    while !cond() {
        if Instant::now() > deadline {
            return Err("페이지 로드 시간 초과".into());
        }
        run_loop_tick();
    }
    Ok(())
}

/// JavaScript를 돌려 숫자 결과를 얻는다(내용 높이 측정).
unsafe fn eval_number(webview: *mut objc2::runtime::AnyObject, js: &str) -> Result<f64, String> {
    let (tx, rx) = mpsc::channel::<Result<f64, String>>();
    let js_str = NSString::from_str(js);
    let block = RcBlock::new(
        move |result: *mut objc2::runtime::AnyObject, error: *mut objc2::runtime::AnyObject| {
            if !error.is_null() {
                let _ = tx.send(Err("스크립트 평가 실패".into()));
                return;
            }
            if result.is_null() {
                let _ = tx.send(Ok(page_h_default()));
                return;
            }
            let ns_number_class: &AnyClass = class!(NSNumber);
            let is_number: bool = msg_send![result, isKindOfClass: ns_number_class];
            if is_number {
                let v: f64 = msg_send![result, doubleValue];
                let _ = tx.send(Ok(v));
            } else {
                let _ = tx.send(Ok(page_h_default()));
            }
        },
    );
    let _: () = msg_send![webview, evaluateJavaScript: &*js_str, completionHandler: &*block];
    let deadline = Instant::now() + JS_TIMEOUT;
    loop {
        if let Ok(res) = rx.try_recv() {
            return res;
        }
        if Instant::now() > deadline {
            return Err("스크립트 평가 시간 초과".into());
        }
        run_loop_tick();
    }
}

fn page_h_default() -> f64 {
    1123.0
}

/// CGRect 조립 헬퍼(포인트·크기).
fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
}
