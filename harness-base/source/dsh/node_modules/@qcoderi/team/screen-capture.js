import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

const run=promisify(execFile);
export function validateCapture(args={}) {
  const target=args.target ?? (args.window!==undefined ? 'window' : 'primary');
  if(!['primary','all','active_window','window'].includes(target))throw Error('target: primary, all, active_window или window');
  if(args.window!==undefined&&(!['active_window','window'].includes(target)||typeof args.window!=='string'||!/^\d{1,18}$/.test(args.window)||BigInt(args.window)===0n))throw Error('window: идентификатор ожидаемого окна');
  if(target==='window'&&args.window===undefined)throw Error('window: для target="window" нужен идентификатор окна');
  const region=[args.x,args.y,args.width,args.height];
  if(region.some(value=>value!==undefined)) {
    if(!region.every(Number.isSafeInteger) || args.width<1 || args.height<1 || args.width>8192 || args.height>8192 || args.width*args.height>64000000 || Math.abs(args.x)>100000 || Math.abs(args.y)>100000)throw Error('Область снимка: нужны целые x, y, width, height; размер до 8192 px и 64 Мп');
  }
  const delay_ms=args.delay_ms ?? 0;
  if(!Number.isSafeInteger(delay_ms) || delay_ms<0 || delay_ms>3000)throw Error('delay_ms: целое число от 0 до 3000');
  return {target,delay_ms,...args.window===undefined?{}:{window:args.window},...region[0]===undefined ? {} : {x:args.x,y:args.y,width:args.width,height:args.height}};
}

// Only numeric bounds and an enumerated target cross the process boundary.
// The PowerShell program is fixed; no model text is interpolated as code.
const script=String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class QcCaptureResult {
  public byte[] Png;
  public int X, Y, Width, Height;
  public string Desktop;
  public bool UniformClient;
}

public static class QCoderICapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr desk);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desk);

  public static void EnableDpiAwareness() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  private static bool IsUniformClient(Bitmap bmp) {
    if (bmp.Width <= 40 || bmp.Height <= 80) return false;
    int x0 = 12, x1 = bmp.Width - 12, y0 = 36, y1 = bmp.Height - 12;
    if (x1 <= x0 || y1 <= y0) return false;
    Color first = bmp.GetPixel(x0, y0);
    for (int iy = 0; iy < 16; iy++) {
      int py = y0 + (y1 - y0) * iy / 15;
      for (int ix = 0; ix < 16; ix++) {
        int px = x0 + (x1 - x0) * ix / 15;
        Color c = bmp.GetPixel(px, py);
        if (Math.Abs(c.R - first.R) > 2 || Math.Abs(c.G - first.G) > 2 || Math.Abs(c.B - first.B) > 2) return false;
      }
    }
    return true;
  }

  private static QcCaptureResult RenderWindowBitmap(IntPtr handle, string desktop, bool hasCrop, int cx, int cy, int cw, int ch) {
    if (!IsWindow(handle)) throw new Exception("Окно больше не существует");
    if (IsIconic(handle)) throw new Exception("Окно свёрнуто");
    RECT r;
    if (!GetWindowRect(handle, out r)) throw new Exception("Не удалось получить границы окна");
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || ((long)w * h) > 64000000L) throw new Exception("Недопустимый размер окна");
    Rectangle full = new Rectangle(r.Left, r.Top, w, h);
    Rectangle outBounds = full;
    if (hasCrop) {
      Rectangle crop = new Rectangle(cx, cy, cw, ch);
      if (!full.Contains(crop)) throw new Exception("Область снимка выходит за границы выбранного окна");
      outBounds = crop;
    }
    using (var fullBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      bool ok;
      using (var g = Graphics.FromImage(fullBmp)) {
        IntPtr hdc = g.GetHdc();
        ok = PrintWindow(handle, hdc, 2);
        if (!ok) ok = PrintWindow(handle, hdc, 0);
        g.ReleaseHdc(hdc);
      }
      if (!ok) throw new Exception("Не удалось отрисовать окно");
      bool uniform = desktop == "background" && IsUniformClient(fullBmp);
      Bitmap finalBmp = fullBmp;
      bool ownsFinal = false;
      try {
        if (hasCrop) {
          var rel = new Rectangle(outBounds.X - r.Left, outBounds.Y - r.Top, outBounds.Width, outBounds.Height);
          finalBmp = fullBmp.Clone(rel, PixelFormat.Format32bppArgb);
          ownsFinal = true;
        }
        using (var ms = new MemoryStream()) {
          finalBmp.Save(ms, ImageFormat.Png);
          if (ms.Length > 20971520) throw new Exception("PNG превышает 20 МБ; выберите меньшую область");
          return new QcCaptureResult {
            Png = ms.ToArray(), X = outBounds.X, Y = outBounds.Y,
            Width = outBounds.Width, Height = outBounds.Height,
            Desktop = desktop, UniformClient = uniform
          };
        }
      } finally {
        if (ownsFinal) finalBmp.Dispose();
      }
    }
  }

  public static QcCaptureResult CaptureWindowAnywhere(long hwndVal, bool hasCrop, int cx, int cy, int cw, int ch) {
    IntPtr handle = new IntPtr(hwndVal);
    if (IsWindow(handle)) {
      return RenderWindowBitmap(handle, "default", hasCrop, cx, cy, cw, ch);
    }
    IntPtr hDesk = OpenDesktopW("QCoderI_Background", 0, false, 0x01FF);
    if (hDesk == IntPtr.Zero) hDesk = OpenDesktopW("QCoderI_Background", 0, false, 0x00C1);
    if (hDesk == IntPtr.Zero) throw new Exception("Окно не найдено");
    QcCaptureResult result = null;
    Exception err = null;
    var t = new Thread(() => {
      try {
        EnableDpiAwareness();
        if (!SetThreadDesktop(hDesk)) throw new Exception("SetThreadDesktop failed");
        result = RenderWindowBitmap(handle, "background", hasCrop, cx, cy, cw, ch);
      } catch (Exception ex) { err = ex; }
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    CloseDesktop(hDesk);
    if (err != null) throw err;
    return result;
  }
}
'@
[QCoderICapture]::EnableDpiAwareness()
$request=$env:QCODERI_CAPTURE_REQUEST | ConvertFrom-Json
if($request.delay_ms -gt 0){Start-Sleep -Milliseconds $request.delay_ms}
$hasCrop=$null -ne $request.x
$cx=if($hasCrop){[int]$request.x}else{0};$cy=if($hasCrop){[int]$request.y}else{0}
$cw=if($hasCrop){[int]$request.width}else{0};$ch=if($hasCrop){[int]$request.height}else{0}

if($request.target -eq 'window' -or ($request.target -eq 'active_window' -and $request.window)){
  $winId=if($request.window){[long]$request.window}else{0L}
  $res=[QCoderICapture]::CaptureWindowAnywhere($winId,$hasCrop,$cx,$cy,$cw,$ch)
  @{data=[Convert]::ToBase64String($res.Png);x=$res.X;y=$res.Y;width=$res.Width;height=$res.Height;desktop=$res.Desktop;uniform_client=$res.UniformClient;captured_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  exit
}

$virtual=[System.Windows.Forms.SystemInformation]::VirtualScreen
switch($request.target){
  'all' {$bounds=$virtual}
  'primary' {$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds}
  'active_window' {
    $handle=[QCoderICapture]::GetForegroundWindow()
    if($handle -ne [IntPtr]::Zero -and -not [QCoderICapture]::IsIconic($handle)){
      try{
        $res=[QCoderICapture]::CaptureWindowAnywhere($handle.ToInt64(),$hasCrop,$cx,$cy,$cw,$ch)
        @{data=[Convert]::ToBase64String($res.Png);x=$res.X;y=$res.Y;width=$res.Width;height=$res.Height;desktop=$res.Desktop;uniform_client=$res.UniformClient;captured_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
        exit
      }catch{}
    }
    $rect=New-Object QCoderICapture+RECT
    if($handle -eq [IntPtr]::Zero -or -not [QCoderICapture]::GetWindowRect($handle,[ref]$rect)){throw 'Не удалось определить активное окно'}
    $bounds=[System.Drawing.Rectangle]::FromLTRB($rect.Left,$rect.Top,$rect.Right,$rect.Bottom)
    $bounds=[System.Drawing.Rectangle]::Intersect($bounds,$virtual)
  }
  default {throw 'Неизвестная цель снимка'}
}
if($hasCrop){
  $crop=New-Object System.Drawing.Rectangle($cx,$cy,$cw,$ch)
  if(-not $bounds.Contains($crop)){throw 'Область снимка выходит за границы выбранного экрана или окна'}
  $bounds=$crop
}
if($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or $bounds.Width -gt 8192 -or $bounds.Height -gt 8192 -or ([long]$bounds.Width*$bounds.Height) -gt 64000000){throw 'Слишком большой или недоступный экран; выберите основной экран либо меньшую область'}
$bitmap=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics=$null; $memory=$null
try {
  $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
  $memory=New-Object System.IO.MemoryStream
  $bitmap.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
  if($memory.Length -gt 20971520){throw 'PNG превышает 20 МБ; выберите меньшую область'}
  @{data=[Convert]::ToBase64String($memory.ToArray());x=$bounds.X;y=$bounds.Y;width=$bounds.Width;height=$bounds.Height;desktop='default';uniform_client=$false;captured_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
} finally {
  if($memory){$memory.Dispose()}
  if($graphics){$graphics.Dispose()}
  $bitmap.Dispose()
}
`;

export async function captureScreen(args={},signal) {
  const request=validateCapture(args);
  signal?.throwIfAborted();
  if(process.platform!=='win32')throw Error('Снимки рабочего стола доступны в Windows');
  const executable=join(process.env.SystemRoot ?? 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  let stdout;
  try {({stdout}=await run(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    windowsHide:true,timeout:15000,maxBuffer:32*1024*1024,signal,
    env:{...process.env,QCODERI_CAPTURE_REQUEST:JSON.stringify(request)},
  }));} catch(error){
    if(signal?.aborted)throw signal.reason;
    if(request.window)throw Error('Не удалось снять выбранное окно: проверьте, что оно открыто и доступно. Действие приложения не повторялось.');
    throw Error(error.killed?'Превышено время захвата экрана; повторите снимок после проверки приложения.':'Не удалось сделать снимок экрана. Проверьте доступность рабочего стола и выбранную область.');
  }
  signal?.throwIfAborted();
  const value=JSON.parse(stdout.trim());
  const data=Buffer.from(value.data,'base64');
  if(!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.length>20971520)throw Error('Не удалось получить корректный PNG снимка');
  return {data,mediaType:'image/png',target:request.target,bounds:{x:value.x,y:value.y,width:value.width,height:value.height},desktop:value.desktop??'default',uniformClient:Boolean(value.uniform_client),captured_at:value.captured_at};
}
