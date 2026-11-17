#define UNICODE
#define _UNICODE
#include <windows.h>
#include <wchar.h>

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR args, int show) {
    wchar_t directory[32768], executable[32768], command[32768];
    DWORD length = GetModuleFileNameW(NULL, directory, 32768);
    if (!length || length >= 32768) return 1;
    wchar_t *slash = wcsrchr(directory, L'\\');
    if (!slash) return 1;
    *slash = 0;
    /* Publish prepared resources only after Windows releases the running files. */
    wchar_t pending[32768], archive[32768], pendingExe[32768], installedExe[32768];
    BOOL appliedUpdate = FALSE;
    if (swprintf(pendingExe, 32768, L"%ls\\harness-base\\app\\QCoderI.update.exe", directory) < 0) return 1;
    if (swprintf(installedExe, 32768, L"%ls\\harness-base\\app\\QCoderI.exe", directory) < 0) return 1;
    DWORD pendingExeAttributes = GetFileAttributesW(pendingExe);
    if (pendingExeAttributes != INVALID_FILE_ATTRIBUTES && !(pendingExeAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        if (!MoveFileExW(pendingExe, installedExe, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            MessageBoxW(NULL, L"Доступно обновление значка приложения. Закройте все окна QCoderI и запустите приложение ещё раз.", L"Обновление QCoderI", MB_OK | MB_ICONINFORMATION);
            return 2;
        }
        appliedUpdate = TRUE;
    }
    if (swprintf(pending, 32768, L"%ls\\harness-base\\app\\resources\\app.update.asar", directory) < 0) return 1;
    if (swprintf(archive, 32768, L"%ls\\harness-base\\app\\resources\\app.asar", directory) < 0) return 1;
    DWORD pendingAttributes = GetFileAttributesW(pending);
    if (pendingAttributes != INVALID_FILE_ATTRIBUTES && !(pendingAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        if (!MoveFileExW(pending, archive, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            MessageBoxW(NULL, L"Доступно обновление. Закройте все окна QCoderI и запустите приложение ещё раз.", L"Обновление QCoderI", MB_OK | MB_ICONINFORMATION);
            return 2;
        }
        appliedUpdate = TRUE;
    }
    if (appliedUpdate) {
        wchar_t nextSums[32768], currentSums[32768];
        if (swprintf(nextSums, 32768, L"%ls\\harness-base\\SHA256SUMS.next.txt", directory) >= 0 &&
            swprintf(currentSums, 32768, L"%ls\\harness-base\\SHA256SUMS.txt", directory) >= 0) {
            MoveFileExW(nextSums, currentSums, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
        }
    }
    if (swprintf(executable, 32768, L"%ls\\harness-base\\app\\QCoderI.exe", directory) < 0) return 1;
    const wchar_t *tail = GetCommandLineW();
    if (*tail == L'"') { ++tail; while (*tail && *tail != L'"') ++tail; if (*tail) ++tail; }
    else { while (*tail && *tail != L' ' && *tail != L'\t') ++tail; }
    while (*tail == L' ' || *tail == L'\t') ++tail;
    if (swprintf(command, 32768, L"\"%ls\" %ls", executable, tail) < 0) return 1;
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(executable, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, directory, &startup, &process)) {
        wchar_t message[512];
        swprintf(message, 512, L"Не удалось запустить QCoderI (ошибка %lu).\nСохраните папку harness-base рядом с QCoderI.exe.", GetLastError());
        MessageBoxW(NULL, message, L"QCoderI — ошибка запуска", MB_OK | MB_ICONERROR);
        return 1;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
