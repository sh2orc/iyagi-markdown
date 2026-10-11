//! PDF 내보내기 — 숨은 WKWebView에서 완성된 HTML을 벡터 PDF로 변환한다(§4-4).
//!
//! 페이지 분할 방식(2026-10-11 실패 시행에 따라 확정):
//! 1. HTML을 메모리에서 바로 올린다(`loadHTMLString:`) — 임시 파일 없음.
//! 2. 로드 뒤 **CSS 다단 컬럼 페이지네이션**을 주입한다: 내용을 페이지 폭의
//!    컬럼·페이지 높이로 흘려 보내면 문서가 **가로로** 이어지는 컬럼들이 된다.
//!    컬럼 경계 = 페이지 경계라서 텍스트가 경계 중간에 잘리지 않는다.
//! 3. `createPDF`로 전체 컬럼 폭을 **한 넓은 페이지**로 받는다(전부 벡터).
//! 4. CoreGraphics로 그 넓은 페이지를 페이지 폭마다 잘라 여러 페이지 PDF으로
//!    재조립한다(소스 PDF를 페이지 객체로 삽입 — 2차 전부 벡터, 래스터화 없음 §4-3).
//! 5. 결과는 최종 파일에 곧바로 쓴다(`CGPDFContextCreateWithURL`).
//!
//! 크기: WebKit은 CSS px를 PDF point처럼 내보낸다(실측). 종이 물리 크기(pt =
//! mm/25.4×72)에 맞추려면 재조립 단계에서 CTM을 축소한다.
//!
//! 로드 완료 대기는 `isLoading` 폴링(델리게이트 클래스 등록이 필요 없다).
//! 모든 Objective-C 호출은 메인 스레드에서(`run_on_main_thread`) 일어나며
//! 오토릴리즈 풀 하나 안에서 끝난다.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyClass;
use objc2::{class, msg_send};
use objc2_foundation::{NSData, NSPoint, NSRect, NSSize, NSString};
use tauri::AppHandle;

use crate::commands::PdfOptions;

// WebKit 심볼(class! 조회)이 로드되게 링커에 지시한다.
#[link(name = "WebKit", kind = "framework")]
extern "C" {}

const LOAD_START_TIMEOUT: Duration = Duration::from_secs(5);
const LOAD_TIMEOUT: Duration = Duration::from_secs(45);
const JS_TIMEOUT: Duration = Duration::from_secs(10);
const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

/// 종이 규격(px @96dpi — CSS 픽셀과 WKWebView 좌표가 일치) + 물리 크기(pt).
fn paper_px(paper: &str, orientation: &str) -> (f64, f64, f64, f64) {
    let mm = match paper {
        "letter" => (215.9, 279.4),
        "a5" => (148.0, 210.0),
        _ => (210.0, 297.0), // a4 기본
    };
    let (w, h) = if orientation.eq_ignore_ascii_case("landscape") {
        (mm.1, mm.0)
    } else {
        (mm.0, mm.1)
    };
    let px = |x: f64| x / 25.4 * 96.0;
    let pt = |x: f64| x / 25.4 * 72.0;
    (px(w), px(h), pt(w), pt(h))
}

pub async fn export_pdf(
    app: &AppHandle,
    html: String,
    options: &PdfOptions,
    out_path: &Path,
) -> Result<(), String> {
    let margin_px = options.margin_mm.max(0.0) / 25.4 * 96.0;
    let dims = paper_px(&options.paper, &options.orientation);
    let config = (
        dims.0.round() as i64,
        dims.1.round() as i64,
        dims.2,
        dims.3,
        margin_px.round() as i64,
    );
    tracing::debug!(
        paper = %options.paper,
        orientation = %options.orientation,
        margin_mm = options.margin_mm,
        scale = options.scale,
        "PDF 내보내기(컬럼 페이지네이션)"
    );
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let html_out = out_path.to_path_buf();

    app.run_on_main_thread(move || {
        let result = autoreleasepool(|_| run_on_main(&html, config, &html_out));
        let _ = tx.send(result);
    })
    .map_err(|e| format!("메인 스레드 작업 예약 실패: {e}"))?;

    rx.recv().map_err(|_| "PDF 생성이 중단되었습니다")?
}

/// 메인 스레드에서 실제 WebKit 작업을 수행한다.
/// config = (페이지폭px, 페이지높이px, 폭pt, 높이pt, 여백px).
fn run_on_main(html: &str, config: (i64, i64, f64, f64, i64), out: &Path) -> Result<(), String> {
    let (page_w, page_h, pt_w, pt_h, margin) = config;
    unsafe {
        let wk_class: &AnyClass = class!(WKWebView);
        let cfg_class: &AnyClass = class!(WKWebViewConfiguration);
        let pdf_cfg_class: &AnyClass = class!(WKPDFConfiguration);

        let cfg: *mut objc2::runtime::AnyObject = msg_send![cfg_class, alloc];
        let cfg: *mut objc2::runtime::AnyObject = msg_send![cfg, init];

        let frame = rect(0.0, 0.0, page_w as f64, page_h as f64);
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

        // 1) 로드 시작 대기 → 완료 대기(isLoading 폴링).
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
            let settle = Instant::now() + Duration::from_millis(250);
            while Instant::now() < settle {
                run_loop_tick();
            }
        }

        // 2) 컬럼 페이지네이션 주입 — 문서가 가로 컬럼들로 흐른다.
        let inject = format!(
            r#"(function() {{
  var W = {W}, H = {H}, M = {M};
  var body = document.body;
  var bg = getComputedStyle(body).backgroundColor || '#fff';
  var wrap = document.createElement('div');
  wrap.id = 'iyagi-page-wrap';
  while (body.firstChild) wrap.appendChild(body.firstChild);
  body.appendChild(wrap);
  var st = document.createElement('style');
  st.textContent = 'html,body{{margin:0!important;padding:0!important;}}' +
    // 컬럼 간격을 여백의 2배로 둬야 W 폭 창이 페이지 경계에 정확히 타일링된다.
    '#iyagi-page-wrap{{box-sizing:border-box;padding:' + M + 'px;height:' + H + 'px;width:' + W + 'px;' +
    'column-width:' + (W - 2 * M) + 'px;column-gap:' + (2 * M) + 'px;column-fill:auto;background:' + bg + ';}}' +
    '#iyagi-page-wrap pre,#iyagi-page-wrap table,#iyagi-page-wrap .diagram,' +
    '#iyagi-page-wrap .katex-display{{break-inside:avoid;}}';
  document.head.appendChild(st);
}})();"#,
            W = page_w,
            H = page_h,
            M = margin,
        );
        eval_js(webview, &inject)?;
        // 폰트/이미지 자리잡기를 위한 짧은 정산.
        let settle = Instant::now() + Duration::from_millis(350);
        while Instant::now() < settle {
            run_loop_tick();
        }

        // 3) 전체 컬럼 폭 측정 → 프레임 확장.
        let total_w = eval_number(
            webview,
            "Math.ceil(Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0))",
        )?;
        if !(1.0..=200_000.0).contains(&total_w) {
            return Err(format!("페이지 폭 측정 실패: {total_w}"));
        }
        let full_frame = rect(0.0, 0.0, total_w, page_h as f64);
        let _: () = msg_send![webview, setFrame: full_frame];
        let settle = Instant::now() + Duration::from_millis(300);
        while Instant::now() < settle {
            run_loop_tick();
        }

        // 4) createPDF — 전체 폭을 한 페이지로(전부 벡터).
        let pdf_cfg: *mut objc2::runtime::AnyObject = msg_send![pdf_cfg_class, new];
        let page_rect = rect(0.0, 0.0, total_w, page_h as f64);
        let _: () = msg_send![pdf_cfg, setRect: page_rect];

        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let block = RcBlock::new(
            move |data: *mut NSData, error: *mut objc2::runtime::AnyObject| {
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
            },
        );
        let _: () =
            msg_send![webview, createPDFWithConfiguration: pdf_cfg, completionHandler: &*block];
        let deadline = Instant::now() + RENDER_TIMEOUT;
        let wide = loop {
            if let Ok(res) = rx.try_recv() {
                break res;
            }
            if Instant::now() > deadline {
                break Err("PDF 생성 시간 초과".into());
            }
            run_loop_tick();
        };
        let _: () = msg_send![webview, stopLoading];
        let _: () = msg_send![webview, release];
        let _: () = msg_send![cfg, release];
        let _: () = msg_send![pdf_cfg, release];
        let wide = wide?;

        // 5) 슬라이스 재조립 — 소스는 그대로 벡터로 삽입된다.
        slice_pdf_pages(&wide, total_w, page_w as f64, pt_w, pt_h, out)
    }
}

/// 넓은 한 페이지 PDF를 종이 크기 여러 페이지로 자른다.
/// NSData·NSURL는 CFData·CFURL과 무료 브리지(toll-free)라 포인터 그대로 쓴다.
fn slice_pdf_pages(
    wide: &[u8],
    total_w: f64,
    page_w: f64,
    pt_w: f64,
    pt_h: f64,
    out: &Path,
) -> Result<(), String> {
    use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGDataProvider, CGPDFContextBeginPage, CGPDFContextClose, CGPDFContextEndPage, CGContext,
        CGPDFDocument, CGPDFPage,
    };

    unsafe {
        let nsdata = NSData::with_bytes(wide);
        let cf_data: &objc2_core_foundation::CFData =
            &*(&*nsdata as *const NSData as *const objc2_core_foundation::CFData);
        let provider =
            CGDataProvider::with_cf_data(Some(cf_data)).ok_or("PDF 데이터 공급자 생성 실패")?;
        let doc = CGPDFDocument::with_provider(Some(&provider)).ok_or("PDF 문서 해석 실패")?;
        let src_page: CFRetained<CGPDFPage> =
            CGPDFDocument::page(Some(&doc), 1).ok_or("원본 PDF에 페이지가 없습니다")?;

        // 출력 PDF 컨텍스트 — 최종 파일에 직접 쓴다.
        let url = {
            let s = NSString::from_str(&out.to_string_lossy());
            let url_class: &AnyClass = class!(NSURL);
            let u: *mut objc2::runtime::AnyObject = msg_send![url_class, fileURLWithPath: &*s];
            if u.is_null() {
                return Err("출력 파일 URL 생성 실패".into());
            }
            &*(u as *const objc2_core_foundation::CFURL)
        };
        // mediaBox는 물리 pt 단위.
        let scale = pt_w / page_w;
        let media: CGRect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(pt_w, pt_h));
        let ctx: CFRetained<CGContext> = objc2_core_graphics::CGPDFContextCreateWithURL(
            Some(url),
            &media as *const CGRect,
            None,
        )
        .ok_or("PDF 컨텍스트 생성 실패")?;

        let page_count = (total_w / page_w).ceil().max(1.0) as i64;
        for i in 0..page_count {
            CGPDFContextBeginPage(Some(&ctx), None);
            // 소스(px 좌표) → 종이(pt): 배율 + 페이지별 가로 이동.
            CGContext::scale_ctm(Some(&ctx), scale, scale);
            CGContext::translate_ctm(Some(&ctx), -(i as f64) * page_w, 0.0);
            CGContext::draw_pdf_page(Some(&ctx), Some(&src_page));
            CGPDFContextEndPage(Some(&ctx));
        }
        CGPDFContextClose(Some(&ctx));
        // ctx는 CFRetained — drop이 해제한다.
        Ok(())
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
    while !cond() {
        if Instant::now() > deadline {
            return Err("페이지 로드 시간 초과".into());
        }
        run_loop_tick();
    }
    Ok(())
}

/// JavaScript를 실행하고 완료를 기다린다(결과 무시).
unsafe fn eval_js(webview: *mut objc2::runtime::AnyObject, js: &str) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let js_str = NSString::from_str(js);
    let block = RcBlock::new(
        move |_result: *mut objc2::runtime::AnyObject, error: *mut objc2::runtime::AnyObject| {
            let _ = tx.send(if error.is_null() {
                Ok(())
            } else {
                Err("스크립트 실패".into())
            });
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

/// JavaScript를 돌려 숫자 결과를 얻는다.
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
                let _ = tx.send(Err("스크립트 결과 없음".into()));
                return;
            }
            let ns_number_class: &AnyClass = class!(NSNumber);
            let is_number: bool = msg_send![result, isKindOfClass: ns_number_class];
            let _ = tx.send(if is_number {
                let v: f64 = msg_send![result, doubleValue];
                Ok(v)
            } else {
                Err("스크립트 결과가 숫자가 아님".into())
            });
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

/// CGRect 조립 헬퍼(포인트·크기).
fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
}
