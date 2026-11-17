$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

public sealed class QcDriverRequest {
  public string action;
  public string window;
  public string element;
  public string text;
  public string button;
  public bool background_only;
  public int x, y, to_x, to_y, count = 1, steps, depth = 5, limit = 120;
  public ushort[] codes;
}

public static class QcDesktop {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendText(IntPtr h, uint msg, IntPtr w, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr ReadText(IntPtr h, uint msg, IntPtr w, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendMsg(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="PostMessageW")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT pt);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] state);
  [DllImport("user32.dll")] public static extern bool SetKeyboardState(byte[] state);
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr desk);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desk);

  public static void EnableDpiAwareness() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  public static IntPtr OpenBackgroundDesktop() {
    IntPtr h = OpenDesktopW("QCoderI_Background", 0, false, 0x01FF);
    if (h == IntPtr.Zero) h = OpenDesktopW("QCoderI_Background", 0, false, 0x00C3);
    return h;
  }

  public static IntPtr[] VisibleWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => {
      if (IsWindowVisible(h)) {
        var t = new StringBuilder(1024);
        GetWindowText(h, t, t.Capacity);
        if (t.Length > 0) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static string Title(IntPtr h) { var t = new StringBuilder(1024); GetWindowText(h, t, t.Capacity); return t.ToString(); }
  public static string ClassName(IntPtr h) { var t = new StringBuilder(256); GetClassName(h, t, t.Capacity); return t.ToString(); }

  public static IntPtr[] Children(IntPtr h) {
    var list = new List<IntPtr>();
    EnumChildWindows(h, (c, p) => { list.Add(c); return list.Count < 300; }, IntPtr.Zero);
    return list.ToArray();
  }

  public static string TextValue(IntPtr h) {
    var t = new StringBuilder(2001); UIntPtr r;
    ReadText(h, 13, (IntPtr)t.Capacity, t, 2, 1000, out r);
    return t.ToString();
  }

  public static void SetText(IntPtr h, string value) {
    UIntPtr r;
    if (SendText(h, 12, IntPtr.Zero, value, 2, 2000, out r) == IntPtr.Zero) throw new Exception("Window did not accept text");
  }

  public static Dictionary<string, object> WindowInfo(IntPtr handle, string desktopName) {
    RECT rect; GetWindowRect(handle, out rect);
    uint pid; GetWindowThreadProcessId(handle, out pid);
    string pname = "";
    try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {}
    return new Dictionary<string, object> {
      { "window", handle.ToInt64().ToString() },
      { "title", Title(handle) },
      { "process", pname },
      { "pid", pid },
      { "desktop", desktopName },
      { "foreground", desktopName == "default" && handle == GetForegroundWindow() },
      { "minimized", IsIconic(handle) },
      { "bounds", new Dictionary<string, object> {
        { "x", rect.Left }, { "y", rect.Top },
        { "width", rect.Right - rect.Left }, { "height", rect.Bottom - rect.Top }
      }}
    };
  }

  public static List<Dictionary<string, object>> ListWindows() {
    var result = new List<Dictionary<string, object>>();
    IntPtr bgDesk = OpenBackgroundDesktop();
    if (bgDesk != IntPtr.Zero) {
      var bgList = RunOnDesktop(bgDesk, () => {
        var rows = new List<Dictionary<string, object>>();
        foreach (IntPtr h in VisibleWindows()) rows.Add(WindowInfo(h, "background"));
        return rows;
      });
      CloseDesktop(bgDesk);
      result.AddRange(bgList);
    }
    foreach (IntPtr h in VisibleWindows()) result.Add(WindowInfo(h, "default"));
    return result;
  }

  private static T RunOnDesktop<T>(IntPtr hDesk, Func<T> work) {
    T value = default(T);
    Exception err = null;
    var t = new Thread(() => {
      try {
        EnableDpiAwareness();
        if (!SetThreadDesktop(hDesk)) throw new Exception("SetThreadDesktop failed");
        value = work();
      } catch (Exception ex) { err = ex; }
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (err != null) throw err;
    return value;
  }

  private static IntPtr MakeLParam(int x, int y) { return (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF)); }

  private static IntPtr ChildAtPoint(IntPtr root, int sx, int sy) {
    IntPtr best = root;
    long bestArea = long.MaxValue;
    EnumChildWindows(root, (c, p) => {
      if (!IsWindowVisible(c)) return true;
      RECT r; GetWindowRect(c, out r);
      if (sx >= r.Left && sx < r.Right && sy >= r.Top && sy < r.Bottom) {
        long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (area > 0 && area <= bestArea) { bestArea = area; best = c; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  private static void AssertPointInWindow(IntPtr handle, int x, int y, bool checkTopLevelOverlap) {
    RECT r; GetWindowRect(handle, out r);
    if (x < r.Left || y < r.Top || x >= r.Right || y >= r.Bottom) throw new Exception("Точка находится вне выбранного окна");
    if (checkTopLevelOverlap) {
      uint expectedPid; GetWindowThreadProcessId(handle, out expectedPid);
      uint actualPid; GetWindowThreadProcessId(WindowFromPoint(new POINT(x, y)), out actualPid);
      if (actualPid != expectedPid) throw new Exception("Точка закрыта другим приложением; получите новый снимок");
    }
  }

  private static void FocusDefaultWindow(IntPtr handle) {
    if (IsIconic(handle)) ShowWindow(handle, 9);
    SetForegroundWindow(handle);
    Thread.Sleep(120);
    if (GetForegroundWindow() != handle) throw new Exception("Windows не разрешила переключиться на окно. Сначала выберите его вручную; ввод не отправлен");
  }

  private static void AssertDefaultFocus(IntPtr handle) {
    if (GetForegroundWindow() != handle) throw new Exception("Фокус окна изменился; действие не повторялось. Получите новое состояние");
  }

  public static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new Exception("Windows blocked input (elevation/UIPI or inactive desktop)");
  }

  public static INPUT Key(ushort code, bool up, bool unicode) {
    var i = new INPUT(); i.type = 1;
    i.data.key = new KEYBDINPUT { vk = unicode ? (ushort)0 : code, scan = unicode ? code : (ushort)0, flags = (unicode ? 4u : 0u) | (up ? 2u : 0u) };
    return i;
  }

  public static void TypeDefault(string text) {
    var list = new List<INPUT>();
    foreach (char c in text) { list.Add(Key(c, false, true)); list.Add(Key(c, true, true)); }
    Send(list.ToArray());
  }

  public static void HotkeyDefault(ushort[] codes) {
    var list = new List<INPUT>();
    foreach (var c in codes) list.Add(Key(c, false, false));
    for (int i = codes.Length - 1; i >= 0; i--) list.Add(Key(codes[i], true, false));
    Send(list.ToArray());
  }

  public static void MouseDefault(uint flag, int amount = 0) {
    var i = new INPUT(); i.type = 0;
    i.data.mouse = new MOUSEINPUT { dwFlags = flag, mouseData = unchecked((uint)amount) };
    Send(new[] { i });
  }

  private static string RuntimeIdString(AutomationElement el) {
    int[] ids = el.GetRuntimeId();
    var parts = new string[ids.Length];
    for (int i = 0; i < ids.Length; i++) parts[i] = ids[i].ToString();
    return string.Join(".", parts);
  }

  private static Dictionary<string, object> InspectWindow(IntPtr handle, string desktopName, int maxDepth, int limit) {
    AutomationElement root = null;
    try { root = AutomationElement.FromHandle(handle); } catch {}
    var rows = new List<Dictionary<string, object>>();
    var queue = new Queue<KeyValuePair<AutomationElement, int>>();
    if (root != null) queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
    int visited = 0;
    var walker = TreeWalker.ControlViewWalker;
    while (queue.Count > 0 && rows.Count < limit && visited < 1500) {
      var item = queue.Dequeue();
      var el = item.Key;
      int depth = item.Value;
      visited++;
      try {
        var c = el.Current;
        var r = c.BoundingRectangle;
        if (!c.IsOffscreen) {
          var patterns = new List<string>();
          foreach (var p in el.GetSupportedPatterns()) patterns.Add(p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", ""));
          var row = new Dictionary<string, object> {
            { "element", RuntimeIdString(el) },
            { "name", c.Name },
            { "type", c.ControlType.ProgrammaticName },
            { "automation_id", c.AutomationId },
            { "enabled", c.IsEnabled },
            { "password", c.IsPassword },
            { "depth", depth },
            { "patterns", patterns.ToArray() },
            { "bounds", new Dictionary<string, object> {
              { "x", double.IsInfinity(r.X) ? 0 : (int)r.X },
              { "y", double.IsInfinity(r.Y) ? 0 : (int)r.Y },
              { "width", double.IsInfinity(r.Width) ? 0 : (int)r.Width },
              { "height", double.IsInfinity(r.Height) ? 0 : (int)r.Height }
            }}
          };
          object valPat;
          if (!c.IsPassword && el.TryGetCurrentPattern(ValuePattern.Pattern, out valPat)) {
            string v = ((ValuePattern)valPat).Current.Value ?? "";
            row["value"] = v.Substring(0, Math.Min(2000, v.Length));
          }
          rows.Add(row);
        }
        if (depth < maxDepth) {
          AutomationElement child = walker.GetFirstChild(el);
          while (child != null && queue.Count < 1500) {
            queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, depth + 1));
            child = walker.GetNextSibling(child);
          }
        }
      } catch {}
    }
    foreach (IntPtr nat in Children(handle)) {
      if (rows.Count >= limit) break;
      string cls = ClassName(nat);
      RECT rr; GetWindowRect(nat, out rr);
      bool isEdit = cls.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0;
      bool secret = isEdit && ((GetWindowLong(nat, -16) & 32) != 0);
      var row = new Dictionary<string, object> {
        { "element", "hwnd:" + nat.ToInt64() },
        { "name", Title(nat) },
        { "type", "Win32." + cls },
        { "password", secret },
        { "bounds", new Dictionary<string, object> {
          { "x", rr.Left }, { "y", rr.Top },
          { "width", rr.Right - rr.Left }, { "height", rr.Bottom - rr.Top }
        }},
        { "patterns", new string[0] }
      };
      if (isEdit && !secret) { row["value"] = TextValue(nat); row["patterns"] = new[] { "NativeValue" }; }
      if (cls.IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) >= 0) row["patterns"] = new[] { "NativeInvoke" };
      rows.Add(row);
    }
    return new Dictionary<string, object> {
      { "window", WindowInfo(handle, desktopName) },
      { "elements", rows.ToArray() },
      { "truncated", queue.Count > 0 }
    };
  }

  private static IntPtr ResolveBackgroundTargetControl(IntPtr root, IntPtr native, AutomationElement element) {
    if (native != IntPtr.Zero) return native;
    if (element != null) {
      try {
        int nh = element.Current.NativeWindowHandle;
        if (nh != 0 && IsWindow(new IntPtr(nh))) return new IntPtr(nh);
        var r = element.Current.BoundingRectangle;
        if (!double.IsInfinity(r.X) && r.Width > 0 && r.Height > 0) {
          return ChildAtPoint(root, (int)(r.X + r.Width / 2.0), (int)(r.Y + r.Height / 2.0));
        }
      } catch {}
    }
    uint pid; uint tid = GetWindowThreadProcessId(root, out pid);
    uint ctid = GetCurrentThreadId();
    bool att = AttachThreadInput(ctid, tid, true);
    IntPtr focused = GetFocus();
    if (att) AttachThreadInput(ctid, tid, false);
    if (focused != IntPtr.Zero && IsWindow(focused) && (focused == root || IsChild(root, focused))) return focused;
    foreach (IntPtr c in Children(root)) {
      if (IsWindowVisible(c) && ClassName(c).IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0) return c;
    }
    return root;
  }

  private static void BackgroundClick(IntPtr handle, int sx, int sy, string button, int count) {
    AssertPointInWindow(handle, sx, sy, false);
    IntPtr target = ChildAtPoint(handle, sx, sy);
    var pt = new POINT(sx, sy);
    ScreenToClient(target, ref pt);
    IntPtr lp = MakeLParam(pt.X, pt.Y);
    UIntPtr unused;
    SendMsg(target, 0x0021, handle, (IntPtr)0x02010001, 2, 300, out unused);
    PostMessage(target, 0x0200, IntPtr.Zero, lp);
    uint down = 0x0201, up = 0x0202, dbl = 0x0203; IntPtr mk = (IntPtr)1;
    if (button == "right") { down = 0x0204; up = 0x0205; dbl = 0x0206; mk = (IntPtr)2; }
    else if (button == "middle") { down = 0x0207; up = 0x0208; dbl = 0x0209; mk = (IntPtr)16; }
    for (int i = 0; i < count; i++) {
      PostMessage(target, i == 1 ? dbl : down, mk, lp);
      PostMessage(target, up, IntPtr.Zero, lp);
      if (count > 1 && i == 0) Thread.Sleep(65);
    }
  }

  private static void BackgroundDrag(IntPtr handle, int sx, int sy, int ex, int ey, string button) {
    AssertPointInWindow(handle, sx, sy, false);
    AssertPointInWindow(handle, ex, ey, false);
    IntPtr target = ChildAtPoint(handle, sx, sy);
    var sp = new POINT(sx, sy); ScreenToClient(target, ref sp);
    var ep = new POINT(ex, ey); ScreenToClient(target, ref ep);
    uint down = 0x0201, up = 0x0202; IntPtr mk = (IntPtr)1;
    if (button == "right") { down = 0x0204; up = 0x0205; mk = (IntPtr)2; }
    else if (button == "middle") { down = 0x0207; up = 0x0208; mk = (IntPtr)16; }
    PostMessage(target, down, mk, MakeLParam(sp.X, sp.Y));
    for (int i = 1; i <= 20; i++) {
      int mx = sp.X + (ep.X - sp.X) * i / 20;
      int my = sp.Y + (ep.Y - sp.Y) * i / 20;
      PostMessage(target, 0x0200, mk, MakeLParam(mx, my));
      Thread.Sleep(15);
    }
    PostMessage(target, up, IntPtr.Zero, MakeLParam(ep.X, ep.Y));
  }

  private static void BackgroundScroll(IntPtr handle, int sx, int sy, int steps) {
    AssertPointInWindow(handle, sx, sy, false);
    IntPtr target = ChildAtPoint(handle, sx, sy);
    IntPtr wp = (IntPtr)((steps * 120) << 16);
    PostMessage(target, 0x020A, wp, MakeLParam(sx, sy));
  }

  private static void BackgroundType(IntPtr handle, IntPtr native, AutomationElement element, string text) {
    IntPtr target = ResolveBackgroundTargetControl(handle, native, element);
    if (element != null && native == IntPtr.Zero) {
      try {
        var r = element.Current.BoundingRectangle;
        if (!double.IsInfinity(r.X) && r.Width > 0 && r.Height > 0) BackgroundClick(handle, (int)(r.X + r.Width / 2.0), (int)(r.Y + r.Height / 2.0), "left", 1);
      } catch {}
    }
    uint pid; uint tid = GetWindowThreadProcessId(target, out pid);
    uint ctid = GetCurrentThreadId();
    bool att = AttachThreadInput(ctid, tid, true);
    try {
      if (target != handle) SetFocus(target);
    } finally {
      if (att) AttachThreadInput(ctid, tid, false);
    }
    bool prevCR = false;
    foreach (char ch in text) {
      if (ch == '\r') {
        PostMessage(target, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001);
        PostMessage(target, 0x0102, (IntPtr)'\r', (IntPtr)0x001C0001);
        PostMessage(target, 0x0101, (IntPtr)0x0D, (IntPtr)unchecked((int)0xC01C0001));
        prevCR = true;
        continue;
      }
      if (ch == '\n') {
        if (!prevCR) {
          PostMessage(target, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001);
          PostMessage(target, 0x0102, (IntPtr)'\r', (IntPtr)0x001C0001);
          PostMessage(target, 0x0101, (IntPtr)0x0D, (IntPtr)unchecked((int)0xC01C0001));
        }
        prevCR = false;
        continue;
      }
      prevCR = false;
      PostMessage(target, 0x0102, (IntPtr)ch, (IntPtr)1);
    }
  }

  private static void BackgroundHotkey(IntPtr handle, IntPtr native, AutomationElement element, ushort[] codes) {
    IntPtr target = ResolveBackgroundTargetControl(handle, native, element);
    string cls = ClassName(target);
    bool isEdit = cls.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0;
    bool hasCtrl = Array.IndexOf(codes, (ushort)17) >= 0;
    if (isEdit && hasCtrl && codes.Length == 2) {
      ushort k = codes[0] == 17 ? codes[1] : codes[0];
      UIntPtr unused;
      if (k == 65) { SendMsg(target, 0x00B1, IntPtr.Zero, new IntPtr(-1), 2, 1000, out unused); return; }
      if (k == 67) { SendMsg(target, 0x0301, IntPtr.Zero, IntPtr.Zero, 2, 1000, out unused); return; }
      if (k == 86) { SendMsg(target, 0x0302, IntPtr.Zero, IntPtr.Zero, 2, 1000, out unused); return; }
      if (k == 88) { SendMsg(target, 0x0300, IntPtr.Zero, IntPtr.Zero, 2, 1000, out unused); return; }
      if (k == 90) { SendMsg(target, 0x0304, IntPtr.Zero, IntPtr.Zero, 2, 1000, out unused); return; }
    }
    uint pid; uint tid = GetWindowThreadProcessId(target, out pid);
    uint ctid = GetCurrentThreadId();
    bool att = AttachThreadInput(ctid, tid, true);
    var origState = new byte[256];
    try {
      if (target != handle) SetFocus(target);
      GetKeyboardState(origState);
      var modState = (byte[])origState.Clone();
      foreach (ushort c in codes) {
        modState[c] = 0x80;
        if (c == 17) modState[0xA2] = 0x80;
        if (c == 16) modState[0xA0] = 0x80;
        if (c == 18) modState[0xA4] = 0x80;
      }
      SetKeyboardState(modState);
      bool altDown = Array.IndexOf(codes, (ushort)18) >= 0;
      foreach (ushort c in codes) {
        uint scan = MapVirtualKeyW(c, 0);
        uint lp = 1u | (scan << 16);
        uint msg = (altDown && c != 18) ? 0x0104u : 0x0100u;
        PostMessage(target, msg, (IntPtr)c, (IntPtr)unchecked((int)lp));
      }
      Thread.Sleep(50);
      for (int i = codes.Length - 1; i >= 0; i--) {
        ushort c = codes[i];
        uint scan = MapVirtualKeyW(c, 0);
        uint lp = 1u | (scan << 16) | 0xC0000000u;
        uint msg = (altDown && c != 18) ? 0x0105u : 0x0101u;
        PostMessage(target, msg, (IntPtr)c, (IntPtr)unchecked((int)lp));
      }
      Thread.Sleep(30);
    } finally {
      SetKeyboardState(origState);
      if (att) AttachThreadInput(ctid, tid, false);
    }
  }

  private static void InvokeElement(IntPtr handle, IntPtr native, AutomationElement element, bool isBackground) {
    if (native != IntPtr.Zero) {
      if (ClassName(native).IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) < 0) throw new Exception("Элемент не является кнопкой");
      PostMessage(native, 245, IntPtr.Zero, IntPtr.Zero);
      return;
    }
    try {
      object pattern;
      if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
      if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return; }
      if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return; }
    } catch {
      if (!isBackground) throw;
      int nh = 0;
      try { nh = element.Current.NativeWindowHandle; } catch {}
      if (nh != 0 && IsWindow(new IntPtr(nh))) {
        IntPtr ctrl = new IntPtr(nh);
        if (ClassName(ctrl).IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) >= 0) {
          PostMessage(ctrl, 245, IntPtr.Zero, IntPtr.Zero);
          return;
        }
      }
      var r = element.Current.BoundingRectangle;
      if (!double.IsInfinity(r.X) && r.Width > 0 && r.Height > 0) {
        BackgroundClick(handle, (int)(r.X + r.Width / 2.0), (int)(r.Y + r.Height / 2.0), "left", 1);
        return;
      }
      throw;
    }
    throw new Exception("Элемент не поддерживает invoke/select/toggle; используйте координаты из свежего снимка");
  }

  private static void SetValueElement(IntPtr native, AutomationElement element, string text) {
    if (native != IntPtr.Zero) {
      string cls = ClassName(native);
      if (cls.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) < 0 || ((GetWindowLong(native, -16) & 32) != 0))
        throw new Exception("Не редактируемое текстовое поле");
      SetText(native, text ?? "");
      return;
    }
    if (element.Current.IsPassword) throw new Exception("Парольное поле не поддерживается этим инструментом");
    object pattern;
    if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
      throw new Exception("Элемент не поддерживает изменение значения");
    ((ValuePattern)pattern).SetValue(text ?? "");
  }

  private static Dictionary<string, object> ExecuteOnDesktop(IntPtr handle, string desktopName, QcDriverRequest req) {
    if (req.action == "inspect") return InspectWindow(handle, desktopName, req.depth, req.limit);

    AutomationElement root = null;
    try { root = AutomationElement.FromHandle(handle); } catch {}
    AutomationElement element = null;
    IntPtr native = IntPtr.Zero;
    if (!string.IsNullOrEmpty(req.element)) {
      if (req.element.StartsWith("hwnd:", StringComparison.Ordinal)) {
        native = new IntPtr(long.Parse(req.element.Substring(5)));
        if (!IsWindow(native) || !IsChild(handle, native)) throw new Exception("Элемент устарел или не принадлежит окну");
      } else {
        if (root == null) throw new Exception("Приложение не предоставляет UI Automation; используйте native element или координаты");
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);
        int visited = 0;
        var walker = TreeWalker.ControlViewWalker;
        while (queue.Count > 0 && visited++ < 2000) {
          var cand = queue.Dequeue();
          if (RuntimeIdString(cand) == req.element) { element = cand; break; }
          var child = walker.GetFirstChild(cand);
          while (child != null && queue.Count < 2000) { queue.Enqueue(child); child = walker.GetNextSibling(child); }
        }
        if (element == null) throw new Exception("Элемент устарел или исчез. Повторите desktop_inspect");
        if (!element.Current.IsEnabled) throw new Exception("Элемент отключён");
      }
    }

    bool isBg = desktopName == "background";
    if (!isBg && (native == IntPtr.Zero || (req.action != "invoke" && req.action != "set_value"))) {
      FocusDefaultWindow(handle);
    }

    switch (req.action) {
      case "focus":
        if (isBg) { if (IsIconic(handle)) ShowWindow(handle, 9); BringWindowToTop(handle); }
        break;
      case "invoke":
        InvokeElement(handle, native, element, isBg);
        break;
      case "set_value":
        SetValueElement(native, element, req.text);
        break;
      case "type":
        if (isBg) BackgroundType(handle, native, element, req.text ?? "");
        else {
          if (native != IntPtr.Zero) AutomationElement.FromHandle(native).SetFocus();
          else if (element != null) element.SetFocus();
          AssertDefaultFocus(handle);
          TypeDefault(req.text ?? "");
        }
        break;
      case "hotkey":
        if (isBg) BackgroundHotkey(handle, native, element, req.codes);
        else { AssertDefaultFocus(handle); HotkeyDefault(req.codes); }
        break;
      case "click": {
        int cx, cy;
        if (native != IntPtr.Zero) { RECT nr; GetWindowRect(native, out nr); cx = (nr.Left + nr.Right) / 2; cy = (nr.Top + nr.Bottom) / 2; }
        else if (element != null) { var er = element.Current.BoundingRectangle; cx = (int)(er.X + er.Width / 2.0); cy = (int)(er.Y + er.Height / 2.0); }
        else { cx = req.x; cy = req.y; }
        if (isBg) BackgroundClick(handle, cx, cy, req.button ?? "left", req.count);
        else {
          AssertPointInWindow(handle, cx, cy, true); AssertDefaultFocus(handle); SetCursorPos(cx, cy);
          uint down = 2, up = 4;
          if (req.button == "right") { down = 8; up = 16; } else if (req.button == "middle") { down = 32; up = 64; }
          for (int i = 0; i < req.count; i++) { MouseDefault(down); MouseDefault(up); if (req.count > 1) Thread.Sleep(65); }
        }
        break;
      }
      case "scroll":
        if (isBg) BackgroundScroll(handle, req.x, req.y, req.steps);
        else { AssertPointInWindow(handle, req.x, req.y, true); AssertDefaultFocus(handle); SetCursorPos(req.x, req.y); MouseDefault(2048, req.steps * 120); }
        break;
      case "drag":
        if (isBg) BackgroundDrag(handle, req.x, req.y, req.to_x, req.to_y, req.button ?? "left");
        else {
          AssertPointInWindow(handle, req.x, req.y, true); AssertPointInWindow(handle, req.to_x, req.to_y, true); AssertDefaultFocus(handle);
          SetCursorPos(req.x, req.y);
          uint down = 2, up = 4;
          if (req.button == "middle") { down = 32; up = 64; } else if (req.button == "right") { down = 8; up = 16; }
          try {
            MouseDefault(down);
            for (int i = 1; i <= 20; i++) {
              AssertDefaultFocus(handle);
              SetCursorPos(req.x + (req.to_x - req.x) * i / 20, req.y + (req.to_y - req.y) * i / 20);
              Thread.Sleep(20);
            }
          } finally { MouseDefault(up); }
        }
        break;
      default:
        throw new Exception("Неизвестное действие");
    }

    Thread.Sleep(160);
    return new Dictionary<string, object> {
      { "ok", true },
      { "action", req.action },
      { "window", WindowInfo(handle, desktopName) },
      { "foreground", isBg ? "0" : GetForegroundWindow().ToInt64().ToString() }
    };
  }

  public static Dictionary<string, object> RunRequest(QcDriverRequest req) {
    if (req.action == "windows") return new Dictionary<string, object> { { "windows", ListWindows().ToArray() } };
    IntPtr handle = new IntPtr(long.Parse(req.window));
    if (IsWindow(handle)) {
      if (req.background_only && req.action != "inspect")
        throw new Exception("Окно находится на пользовательском рабочем столе. Запустите отдельное фоновое окно или явно разрешите действие на основном экране.");
      return ExecuteOnDesktop(handle, "default", req);
    }
    IntPtr bgDesk = OpenBackgroundDesktop();
    if (bgDesk != IntPtr.Zero) {
      try {
        return RunOnDesktop(bgDesk, () => {
          if (!IsWindow(handle)) throw new Exception("Окно больше не существует; обновите список окон");
          return ExecuteOnDesktop(handle, "background", req);
        });
      } finally { CloseDesktop(bgDesk); }
    }
    throw new Exception("Окно больше не существует; обновите список окон");
  }
}
'@
[QcDesktop]::EnableDpiAwareness()
$raw=$env:QCODERI_DESKTOP_REQUEST | ConvertFrom-Json
$req=New-Object QcDriverRequest
$req.action=[string]$raw.action
if($raw.background_only -eq $true){$req.background_only=$true}
if($null -ne $raw.window){$req.window=[string]$raw.window}
if($null -ne $raw.element){$req.element=[string]$raw.element}
if($null -ne $raw.text){$req.text=[string]$raw.text}
if($null -ne $raw.button){$req.button=[string]$raw.button}
if($null -ne $raw.x){$req.x=[int]$raw.x}
if($null -ne $raw.y){$req.y=[int]$raw.y}
if($null -ne $raw.to_x){$req.to_x=[int]$raw.to_x}
if($null -ne $raw.to_y){$req.to_y=[int]$raw.to_y}
if($null -ne $raw.count){$req.count=[int]$raw.count}
if($null -ne $raw.steps){$req.steps=[int]$raw.steps}
if($null -ne $raw.depth){$req.depth=[int]$raw.depth}
if($null -ne $raw.limit){$req.limit=[int]$raw.limit}
if($null -ne $raw.codes){$req.codes=[uint16[]]@($raw.codes | ForEach-Object {[uint16]$_})}
try {
  [QcDesktop]::RunRequest($req) | ConvertTo-Json -Compress -Depth 15
}catch{
  $msg=if($_.Exception.InnerException){$_.Exception.InnerException.Message}else{$_.Exception.Message}
  [Console]::Error.WriteLine($msg)
  exit 1
}
