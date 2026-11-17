use crate::Error;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::{self, BufReader, Write},
    os::windows::fs::OpenOptionsExt,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, WaitForSingleObject},
};
use zip::ZipArchive;

const RELEASES: &str = ".qcoderi-releases";
const MAX_EXPANDED_BYTES: u64 = 3 * 1024 * 1024 * 1024;

pub fn base_path(root: &Path) -> PathBuf {
    let versioned = root
        .join(RELEASES)
        .join(env!("CARGO_PKG_VERSION"))
        .join("harness-base");
    if versioned.join("native/desktop-server.mjs").is_file() {
        versioned
    } else {
        root.join("harness-base")
    }
}

pub fn lock_running(root: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".qcoderi-window.lock"))
}

fn lock_exclusive(root: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join(".qcoderi-window.lock"))
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|n| {
            !n.is_empty()
                && n.len() <= 9
                && n.bytes().all(|ch| ch.is_ascii_digit())
                && (n.len() == 1 || !n.starts_with('0'))
        })
}

fn clean_relative(name: &str) -> bool {
    name.trim_end_matches('/').split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.ends_with(['.', ' '])
            && !part
                .chars()
                .any(|ch| ch.is_control() || "\\:*?\"<>|".contains(ch))
            && !matches!(
                part.split('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_uppercase()
                    .as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "CONIN$"
                    | "CONOUT$"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
    })
}

fn allowed_path(name: &str) -> bool {
    name == "QCoderI.exe"
        || name == "harness-base/native/desktop-server.mjs"
        || name == "harness-base/native/updates.mjs"
        || name.starts_with("harness-base/source/dsh/")
        || name.starts_with("harness-base/app/resources/runtime/")
}

fn extract(stage: &Path, sha256: &str) -> Result<PathBuf, Error> {
    let archive_path = stage.join("release.zip");
    use std::io::{Seek, SeekFrom};
    let mut file = BufReader::new(File::open(&archive_path)?);
    let mut hash = Sha256::new();
    io::copy(&mut file, &mut hash)?;
    if format!("{:x}", hash.finalize()) != sha256 {
        return Err("Контрольная сумма пакета изменилась перед установкой.".into());
    }
    file.seek(SeekFrom::Start(0))?;
    let mut archive = ZipArchive::new(file)?;
    if archive.len() > 35_000 {
        return Err("Слишком много файлов в пакете обновления.".into());
    }
    let output = stage.join("payload");
    fs::create_dir(&output)?;
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name();
        if !allowed_path(name) || !clean_relative(name) || entry.is_symlink() {
            return Err(format!("Недопустимый путь в пакете: {name}").into());
        }
        let path = output.join(entry.enclosed_name().ok_or("Недопустимый путь в ZIP")?);
        if entry.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .filter(|size| *size <= MAX_EXPANDED_BYTES)
            .ok_or("Пакет превышает допустимый размер после распаковки")?;
        fs::create_dir_all(path.parent().ok_or("Недопустимый путь в ZIP")?)?;
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        let size = entry.size();
        let copied = io::copy(&mut std::io::Read::take(&mut entry, size + 1), &mut file)?;
        if copied != size {
            return Err("Размер распакованного файла не совпадает с записью ZIP.".into());
        }
    }
    for file in [
        "QCoderI.exe",
        "harness-base/native/desktop-server.mjs",
        "harness-base/native/updates.mjs",
        "harness-base/source/dsh/package.json",
        "harness-base/app/resources/runtime/node/node.exe",
    ] {
        if !output.join(file).is_file() {
            return Err(format!("В пакете обновления отсутствует {file}").into());
        }
    }
    Ok(output)
}

fn wait_for_window(pid: u32) -> Result<(), Error> {
    const SYNCHRONIZE: u32 = 0x00100000;
    let result = unsafe {
        let process = OpenProcess(SYNCHRONIZE, 0, pid);
        if process.is_null() {
            GetLastError() == ERROR_INVALID_PARAMETER
        } else {
            let result = WaitForSingleObject(process, 60_000);
            CloseHandle(process);
            result == WAIT_OBJECT_0
        }
    };
    if !result {
        return Err("Окно QCoderI не закрылось вовремя.".into());
    }
    Ok(())
}

fn launch(exe: &Path, health: Option<&Path>) -> io::Result<std::process::Child> {
    let mut command = Command::new(exe);
    command
        .current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
        .creation_flags(0x08000000);
    if let Some(health) = health {
        command.env("QCODERI_UPDATE_HEALTH", health);
    } else {
        command.env_remove("QCODERI_UPDATE_HEALTH");
    }
    command.spawn()
}

pub fn start_installer(
    exe: &Path,
    stage: &Path,
    version: &str,
    sha256: &str,
    home: &Path,
) -> Result<(), Error> {
    let installer = stage.join("installer.exe");
    fs::copy(exe, &installer)?;
    Command::new(installer)
        .args([
            "--apply-update",
            version,
            sha256,
            &std::process::id().to_string(),
        ])
        .env("DSH_HOME", home)
        .creation_flags(0x08000000)
        .spawn()?;
    Ok(())
}

pub fn apply(args: &[String]) -> Result<(), Error> {
    let [version, sha256, pid] = args else {
        return Err("Аргументы обновления повреждены.".into());
    };
    if !valid_version(version)
        || sha256.len() != 64
        || !sha256.bytes().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err("Метаданные обновления повреждены.".into());
    }
    let current = env::current_exe()?;
    let stage = current.parent().ok_or("Нет папки обновления")?;
    let staging_root = stage
        .parent()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name == ".qcoderi-update")
        })
        .ok_or("Некорректная папка обновления")?;
    let root = staging_root.parent().ok_or("Нет папки QCoderI")?;
    let exe = root.join("QCoderI.exe");
    let journal = root.join("harness-base/update-result.txt");
    wait_for_window(pid.parse()?)?;
    let result = install(root, &exe, stage, version, sha256);
    if let Err(error) = &result {
        let _ = fs::write(
            &journal,
            format!("Не удалось установить обновление {version}: {error}"),
        );
        if exe.is_file() {
            let _ = launch(&exe, None);
        }
    } else {
        let _ = fs::remove_file(journal);
    }
    let _ = fs::remove_file(stage.join("release.zip"));
    let _ = fs::remove_dir_all(stage.join("payload"));
    Ok(())
}

fn install(
    root: &Path,
    exe: &Path,
    stage: &Path,
    version: &str,
    sha256: &str,
) -> Result<(), Error> {
    let _transaction = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join(".qcoderi-update/transaction.lock"))?;
    let output = extract(stage, sha256)?;
    let running = lock_exclusive(root)
        .map_err(|_| "Закройте остальные окна QCoderI и повторите установку.")?;
    let releases = root.join(RELEASES);
    fs::create_dir_all(&releases)?;
    let new_release = releases.join(version);
    fs::create_dir(&new_release)?;
    let old_exe = stage.join("previous.exe");
    let health = stage.join("ready");
    let mut preserve_release = false;
    let result = (|| -> Result<(), Error> {
        fs::rename(
            output.join("harness-base"),
            new_release.join("harness-base"),
        )?;
        fs::copy(exe, &old_exe)?;
        fs::rename(output.join("QCoderI.exe"), exe)?;
        drop(running);
        let started = (|| -> Result<(), Error> {
            let mut child = launch(exe, Some(&health))?;
            let deadline = Instant::now() + crate::STARTUP_TOTAL_TIMEOUT + Duration::from_secs(60);
            while Instant::now() < deadline {
                if child.try_wait()?.is_some() {
                    return Err("Новое окно завершилось при запуске.".into());
                }
                if fs::read_to_string(&health).is_ok_and(|value| value == version) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(150));
            }
            let _ = child.kill();
            let _ = child.wait();
            Err("Новое окно не подтвердило запуск.".into())
        })();
        if let Err(error) = started {
            let rollback = (|| -> io::Result<()> {
                let _rollback_lock = lock_exclusive(root)?;
                fs::rename(&old_exe, exe)
            })();
            if let Err(rollback) = rollback {
                preserve_release = true;
                return Err(format!(
                    "{error} Предыдущая сборка сохранена в {}: {rollback}",
                    old_exe.display()
                )
                .into());
            }
            return Err(error);
        }
        Ok(())
    })();
    if result.is_err() && !preserve_release {
        let _ = fs::remove_dir_all(new_release);
    } else if result.is_ok() {
        let _ = fs::remove_file(old_exe);
    }
    result
}

pub fn confirm_start() {
    if let Some(path) = env::var_os("QCODERI_UPDATE_HEALTH") {
        let _ = File::create(path)
            .and_then(|mut file| file.write_all(env!("CARGO_PKG_VERSION").as_bytes()));
    }
}

pub fn clean_staging(root: &Path) {
    let Some(parent) = env::var_os("QCODERI_UPDATE_HEALTH")
        .and_then(|file| PathBuf::from(file).parent().map(Path::to_path_buf))
    else {
        return;
    };
    if parent.parent() != Some(root.join(".qcoderi-update").as_path()) {
        return;
    }
    thread::spawn(move || {
        let installer = parent.join("installer.exe");
        for _ in 0..180 {
            if fs::remove_file(&installer).is_ok() || !installer.exists() {
                let _ = fs::remove_dir_all(parent);
                return;
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}
