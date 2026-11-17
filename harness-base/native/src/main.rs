#![windows_subsystem = "windows"]

mod update;

use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, INVALID_HANDLE_VALUE},
    Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    },
    UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::{MB_ICONERROR, MessageBoxW, SW_SHOWNORMAL},
    },
};
use wry::{
    NewWindowResponse, WebContext, WebViewBuilder,
    http::{HeaderMap, HeaderValue, Uri},
};

type Error = Box<dyn std::error::Error>;

enum WindowAction {
    Quit,
    Ready,
    Install { version: String, sha256: String },
}

enum StartupEvent {
    Phase(String),
    Ready(u16),
    Closed,
}

const STARTUP_PHASE_TIMEOUT: Duration = Duration::from_secs(90);
const STARTUP_TOTAL_TIMEOUT: Duration = Duration::from_secs(180);

fn host_log(home: &Path) -> io::Result<File> {
    let path = home.join("native-host.log");
    if fs::metadata(&path).is_ok_and(|info| info.len() > 1024 * 1024) {
        fs::rename(&path, home.join("native-host.previous.log"))?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

fn capability() -> Result<String, Error> {
    let mut bytes = [0u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::other("Не удалось создать ключ локального подключения").into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct ProfileLock(PathBuf);
impl ProfileLock {
    fn acquire(profile: &Path) -> Result<Self, Error> {
        let path = profile.join("lock");
        let create = || OpenOptions::new().write(true).create_new(true).open(&path);
        let mut file = match create() {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let owner = fs::read_to_string(&path)?
                    .trim()
                    .parse::<u32>()
                    .ok()
                    .filter(|pid| *pid > 0);
                let stale = owner.is_some_and(|pid| unsafe {
                    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                    if process.is_null() {
                        GetLastError() == ERROR_INVALID_PARAMETER
                    } else {
                        CloseHandle(process);
                        false
                    }
                });
                if !stale {
                    return Err(
                        "Профиль уже открыт в QCoderI. Закройте окно перед повторным запуском."
                            .into(),
                    );
                }
                // Serialize stale lock replacement across native launchers.
                let repair = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(profile.join("lock.repair"))?;
                let repair_guard = Self(profile.join("lock.repair"));
                if fs::read_to_string(&path)?.trim().parse::<u32>().ok() != owner {
                    return Err("Профиль уже открывается в другом окне.".into());
                }
                fs::remove_file(&path)?;
                let result = create();
                drop(repair);
                drop(repair_guard);
                result?
            }
            Err(error) => return Err(error.into()),
        };
        let guard = Self(path);
        writeln!(file, "{}", std::process::id())?;
        file.sync_data()?;
        Ok(guard)
    }
}
impl Drop for ProfileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct Sidecar(Child);
impl Drop for Sidecar {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_host(
    base: &Path,
    root: &Path,
    home: &Path,
    profile: &Path,
    token: &str,
    stage: &Path,
    proxy: tao::event_loop::EventLoopProxy<WindowAction>,
) -> Result<(Sidecar, u16), Error> {
    let mut log = host_log(home)?;
    let started = Instant::now();
    writeln!(
        log,
        "\n[startup pid={} time={}] launching engine",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
    )?;
    let child = Command::new(base.join("app/resources/runtime/node/node.exe"))
        .arg(base.join("native/desktop-server.mjs"))
        .arg(base.join("source/dsh"))
        .arg(profile)
        .current_dir(profile)
        .env("DSH_HOME", home)
        .env("QCODERI_WINDOW_CAPABILITY", token)
        .env("QCODERI_INSTALL_ROOT", root)
        .env("QCODERI_UPDATE_STAGE", stage)
        .env("QCODERI_NATIVE_VERSION", env!("CARGO_PKG_VERSION"))
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log.try_clone()?)
        .spawn()
        .map_err(|error| {
            let _ = writeln!(log, "[startup] could not spawn Node.js: {error}");
            format!(
                "Не удалось запустить Node.js: {error}. Журнал: {}",
                home.join("native-host.log").display()
            )
        })?;
    let mut host = Sidecar(child);
    let stdout = host
        .0
        .stdout
        .take()
        .ok_or("Служба не предоставила канал запуска")?;
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut log = log;
        for result in BufReader::new(stdout).lines() {
            let line = match result {
                Ok(line) => line,
                Err(error) => {
                    let _ = writeln!(log, "[startup] stdout failed: {error}");
                    break;
                }
            };
            if let Some(port) = line
                .strip_prefix("QCODERI_READY ")
                .and_then(|port| port.parse::<u16>().ok())
                .filter(|port| *port > 0)
            {
                let _ = writeln!(
                    log,
                    "[startup +{}ms] engine ready",
                    started.elapsed().as_millis()
                );
                let _ = send.send(StartupEvent::Ready(port));
            } else if let Some(phase) = line.strip_prefix("QCODERI_BOOT ") {
                let _ = writeln!(
                    log,
                    "[startup +{}ms] {phase}",
                    started.elapsed().as_millis()
                );
                let _ = send.send(StartupEvent::Phase(phase.to_owned()));
            } else if let Some((version, sha256)) = line
                .strip_prefix("QCODERI_UPDATE ")
                .and_then(|value| value.split_once(' '))
            {
                let _ = proxy.send_event(WindowAction::Install {
                    version: version.to_owned(),
                    sha256: sha256.to_owned(),
                });
            } else {
                let _ = writeln!(log, "{line}");
            }
        }
        let _ = send.send(StartupEvent::Closed);
    });
    let port = wait_for_host(&mut host, receive, home, started)?;
    Ok((host, port))
}

fn wait_for_host(
    host: &mut Sidecar,
    receive: mpsc::Receiver<StartupEvent>,
    home: &Path,
    started: Instant,
) -> Result<u16, Error> {
    let mut phase = String::from("запуск Node.js");
    let mut phase_started = started;
    loop {
        match receive.recv_timeout(Duration::from_millis(200)) {
            Ok(StartupEvent::Ready(port)) => return Ok(port),
            Ok(StartupEvent::Phase(next)) if next != phase => {
                phase = next;
                phase_started = Instant::now();
            }
            Ok(StartupEvent::Phase(_)) => {}
            Ok(StartupEvent::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = host.0.try_wait()?;
                return Err(format!(
                    "Движок QCoderI завершился при запуске ({}). Этап: {phase}. Журнал: {}",
                    status.map_or_else(
                        || "канал запуска закрыт".to_owned(),
                        |value| value.to_string()
                    ),
                    home.join("native-host.log").display()
                )
                .into());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some(status) = host.0.try_wait()? {
            return Err(format!(
                "Движок QCoderI завершился при запуске ({status}). Этап: {phase}. Журнал: {}",
                home.join("native-host.log").display()
            )
            .into());
        }
        if phase_started.elapsed() >= STARTUP_PHASE_TIMEOUT
            || started.elapsed() >= STARTUP_TOTAL_TIMEOUT
        {
            let mut log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(home.join("native-host.log"))?;
            writeln!(
                log,
                "[startup +{}ms] timeout at {phase}",
                started.elapsed().as_millis()
            )?;
            return Err(format!(
                "Движок QCoderI не завершил запуск за {} с. Этап: {phase}. Журнал: {}",
                started.elapsed().as_secs(),
                home.join("native-host.log").display()
            )
            .into());
        }
    }
}

fn same_origin(url: &str, authority: &str) -> bool {
    url.parse::<Uri>().is_ok_and(|url| {
        url.scheme_str() == Some("http")
            && url
                .authority()
                .is_some_and(|value| value.as_str() == authority)
    })
}

fn open_external(url: &str) {
    if url
        .parse::<Uri>()
        .is_ok_and(|url| matches!(url.scheme_str(), Some("https" | "http")) && url.host().is_some())
    {
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                wide("open").as_ptr(),
                wide(url).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
}

fn legacy_window_active(base: &Path) -> bool {
    let legacy = base.join("app/QCoderI.exe");
    let expected = legacy.to_string_lossy();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry);
        let mut image = [0u16; 32768];
        let mut found = false;
        while more != 0 {
            let end = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("QCoderI.exe")
            {
                let process =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !process.is_null() {
                    let mut length = image.len() as u32;
                    let queried =
                        QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length);
                    CloseHandle(process);
                    if queried != 0
                        && String::from_utf16_lossy(&image[..length as usize])
                            .eq_ignore_ascii_case(&expected)
                    {
                        found = true;
                        break;
                    }
                }
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        found
    }
}

fn run() -> Result<(), Error> {
    let executable = env::current_exe()?;
    let parent = executable.parent().ok_or("Не найдена папка QCoderI")?;
    let root = if parent.join("harness-base").is_dir() {
        parent.to_path_buf()
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .ok_or("Не найдена папка QCoderI")?
            .to_path_buf()
    };
    let installation = update::lock_running(&root)
        .map_err(|_| "QCoderI устанавливает обновление. Дождитесь окончания установки.")?;
    let base = update::base_path(&root);
    let home = env::var_os("DSH_HOME")
        .filter(|path| !path.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("harness-base/data"));
    let home = std::path::absolute(home)?;
    if home == root.join("harness-base/data") && legacy_window_active(&root.join("harness-base")) {
        return Err("Закройте старое окно QCoderI перед первым запуском новой версии. Оба окна используют одну историю чатов.".into());
    }
    let profile = home.join("profiles/desktop");
    fs::create_dir_all(&profile)?;
    let profile_lock = ProfileLock::acquire(&profile)?;
    let token = capability()?;
    let stage = root.join(".qcoderi-update").join(&token[..24]);
    let event_loop = EventLoopBuilder::<WindowAction>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (host, port) = start_host(&base, &root, &home, &profile, &token, &stage, proxy.clone())?;
    let mut title = String::from("QCoderI");
    title.push_str(" · ");
    title.push_str(env!("CARGO_PKG_VERSION"));
    let authority = format!("127.0.0.1:{port}");
    let mut headers = HeaderMap::new();
    headers.insert("x-qcoderi-window", HeaderValue::from_str(&token)?);
    let window = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(tao::dpi::LogicalSize::new(1240.0, 830.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(480.0, 420.0))
        .with_visible(false)
        .build(&event_loop)?;
    let mut context = WebContext::new(Some(home.join("webview2")));
    let navigation_authority = authority.clone();
    let ipc_authority = authority.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_background_color((18, 15, 28, 255))
        .with_initialization_script_for_main_only(include_str!("../window.js"), true)
        .with_url_and_headers(format!("http://{authority}/index.html"), headers)
        .with_navigation_handler(move |url| same_origin(&url, &navigation_authority))
        .with_new_window_req_handler(|url, _| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .with_ipc_handler(move |request| {
            if same_origin(&request.uri().to_string(), &ipc_authority) {
                let action = match request.body().as_str() {
                    "quit" => WindowAction::Quit,
                    "window-ready" => WindowAction::Ready,
                    _ => return,
                };
                let _ = proxy.send_event(action);
            }
        })
        .build(&window)?;
    window.set_visible(true);
    let mut resources = Some((webview, host, profile_lock, installation));
    event_loop.run(move |event, _, control| {
        *control = ControlFlow::Wait;
        let close = match event {
            Event::UserEvent(WindowAction::Ready) => {
                update::confirm_start();
                update::clean_staging(&root);
                false
            }
            Event::UserEvent(WindowAction::Install { version, sha256 }) => {
                match update::start_installer(&executable, &stage, &version, &sha256, &home) {
                    Ok(()) => true,
                    Err(error) => {
                        let _ = fs::write(home.join("native-update.log"), error.to_string());
                        if let Some((_, host, ..)) = &mut resources {
                            if let Some(stdin) = &mut host.0.stdin {
                                let _ = writeln!(stdin, "QCODERI_INSTALLER_FAILED");
                            }
                        }
                        false
                    }
                }
            }
            Event::UserEvent(WindowAction::Quit)
            | Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => true,
            _ => false,
        };
        if close {
            window.set_visible(false);
            drop(resources.take());
            *control = ControlFlow::Exit;
        }
    });
}

fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let result = if args.first().is_some_and(|value| value == "--apply-update") {
        update::apply(&args[1..])
    } else {
        run()
    };
    if let Err(error) = result {
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide(&error.to_string()).as_ptr(),
                wide("QCoderI").as_ptr(),
                MB_ICONERROR,
            );
        }
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    fn test_home() -> PathBuf {
        let home = env::temp_dir().join(format!(
            "qcoderi-native-startup-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&home).unwrap();
        home
    }

    fn exit_child(code: u32) -> Sidecar {
        Sidecar(
            Command::new(env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()))
                .args(["/D", "/C", &format!("exit {code}")])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    #[test]
    fn failed_child_is_reported_without_waiting_for_startup_timeout() {
        let home = test_home();
        let mut child = exit_child(17);
        let (_send, receive) = mpsc::channel();
        let started = Instant::now();
        let error = wait_for_host(&mut child, receive, &home, started)
            .unwrap_err()
            .to_string();
        assert!(error.contains("17"), "{error}");
        assert!(error.contains("native-host.log"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        fs::remove_dir(home).unwrap();
    }

    #[test]
    fn startup_progress_preserves_readiness_handshake() {
        let home = test_home();
        let node =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../app/resources/runtime/node/node.exe");
        let mut child = Sidecar(
            Command::new(node)
                .args(["-e", "process.stdin.resume()"])
                .creation_flags(0x08000000)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let (send, receive) = mpsc::channel();
        send.send(StartupEvent::Phase("загрузка модулей".to_owned()))
            .unwrap();
        send.send(StartupEvent::Ready(12345)).unwrap();
        assert_eq!(
            wait_for_host(&mut child, receive, &home, Instant::now()).unwrap(),
            12345
        );
        fs::remove_dir(home).unwrap();
    }

    #[test]
    fn startup_log_keeps_previous_attempts_and_rotates_large_logs() {
        let home = test_home();
        writeln!(host_log(&home).unwrap(), "first attempt").unwrap();
        writeln!(host_log(&home).unwrap(), "second attempt").unwrap();
        let path = home.join("native-host.log");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "first attempt\nsecond attempt\n"
        );
        fs::write(&path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        writeln!(host_log(&home).unwrap(), "new attempt").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new attempt\n");
        assert_eq!(
            fs::metadata(home.join("native-host.previous.log"))
                .unwrap()
                .len(),
            1024 * 1024 + 1
        );
        fs::remove_file(path).unwrap();
        fs::remove_file(home.join("native-host.previous.log")).unwrap();
        fs::remove_dir(home).unwrap();
    }
}
