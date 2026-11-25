using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
using System.Text;

namespace PocketDesk
{
    class InputInjector
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        const uint INPUT_MOUSE = 0;
        const uint INPUT_KEYBOARD = 1;

        const uint MOUSEEVENTF_MOVE = 0x0001;
        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        const uint MOUSEEVENTF_WHEEL = 0x0800;
        const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_UNICODE = 0x0004;
        const uint KEYEVENTF_SCANCODE = 0x0008;

        const ushort VK_SPACE = 0x20;
        const ushort VK_RETURN = 0x0D;
        const ushort VK_BACK = 0x08;

        [StructLayout(LayoutKind.Sequential)]
        struct POINT
        {
            public int x;
            public int y;
        }

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        static extern bool LockWorkStation();

        [DllImport("PowrProf.dll", CharSet = CharSet.Auto, ExactSpelling = true)]
        static extern bool SetSuspendState(bool hiberate, bool forceCritical, bool disableWakeEvent);

        const int SM_CXSCREEN = 0;
        const int SM_CYSCREEN = 1;

        static int screenWidth;
        static int screenHeight;

        static void UpdateScreenSize()
        {
            screenWidth = GetSystemMetrics(SM_CXSCREEN);
            screenHeight = GetSystemMetrics(SM_CYSCREEN);
            if (screenWidth <= 0) screenWidth = 1920;
            if (screenHeight <= 0) screenHeight = 1080;
        }

        static void SendMouse(uint flags, int dx = 0, int dy = 0, uint data = 0)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dwFlags = flags;
            inputs[0].u.mi.dx = dx;
            inputs[0].u.mi.dy = dy;
            inputs[0].u.mi.mouseData = data;
            inputs[0].u.mi.time = 0;
            inputs[0].u.mi.dwExtraInfo = IntPtr.Zero;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void MoveAbsolute(double normX, double normY)
        {
            int absX = (int)Math.Round(normX * 65535.0);
            int absY = (int)Math.Round(normY * 65535.0);
            SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, absX, absY, 0);
        }

        static void MoveRelative(int dx, int dy)
        {
            SendMouse(MOUSEEVENTF_MOVE, dx, dy, 0);
        }

        static void SendKey(ushort vk, bool keyUp, bool extended = false)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = vk;
            inputs[0].u.ki.wScan = 0;
            inputs[0].u.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
            inputs[0].u.ki.time = 0;
            inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void SendUnicode(char c)
        {
            if (c == ' ')
            {
                // Native spacebar press
                SendKey(VK_SPACE, false);
                SendKey(VK_SPACE, true);
                return;
            }

            INPUT[] inputs = new INPUT[2];
            // Key down
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = 0;
            inputs[0].u.ki.wScan = (ushort)c;
            inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            inputs[0].u.ki.time = 0;
            inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;

            // Key up
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki.wVk = 0;
            inputs[1].u.ki.wScan = (ushort)c;
            inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            inputs[1].u.ki.time = 0;
            inputs[1].u.ki.dwExtraInfo = IntPtr.Zero;

            SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void SendText(string text)
        {
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n')
                {
                    SendKey(VK_RETURN, false);
                    SendKey(VK_RETURN, true);
                }
                else
                {
                    SendUnicode(c);
                }
                Thread.Sleep(2);
            }
        }

        static void Main(string[] args)
        {
            UpdateScreenSize();
            Console.WriteLine("POCKETDESK_INPUT_READY screen=" + screenWidth + "x" + screenHeight);
            Console.Out.Flush();

            string rawLine;
            while ((rawLine = Console.ReadLine()) != null)
            {
                if (string.IsNullOrEmpty(rawLine)) continue;

                try
                {
                    // Check for TEXT / TEXT_B64 without destructive trimming
                    if (rawLine.StartsWith("TEXT_B64 "))
                    {
                        string b64 = rawLine.Substring(9).Trim();
                        if (!string.IsNullOrEmpty(b64))
                        {
                            byte[] bytes = Convert.FromBase64String(b64);
                            string decoded = Encoding.UTF8.GetString(bytes);
                            SendText(decoded);
                        }
                        continue;
                    }
                    else if (rawLine.StartsWith("TEXT "))
                    {
                        string text = rawLine.Substring(5);
                        SendText(text);
                        continue;
                    }

                    string line = rawLine.Trim();
                    string[] parts = line.Split(' ');
                    string cmd = parts[0].ToUpperInvariant();

                    switch (cmd)
                    {
                        case "SPACE": // Explicit spacebar hit
                            SendKey(VK_SPACE, false);
                            SendKey(VK_SPACE, true);
                            break;

                        case "BACK": // Backspace
                            SendKey(VK_BACK, false);
                            SendKey(VK_BACK, true);
                            break;

                        case "ENTER": // Enter
                            SendKey(VK_RETURN, false);
                            SendKey(VK_RETURN, true);
                            break;

                        case "MMA": // Move Mouse Absolute: MMA 0.523 0.381
                            if (parts.Length >= 3)
                            {
                                double nx = double.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
                                double ny = double.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture);
                                MoveAbsolute(nx, ny);
                            }
                            break;

                        case "MMR": // Move Mouse Relative: MMR 10 -5
                            if (parts.Length >= 3)
                            {
                                int rx = int.Parse(parts[1]);
                                int ry = int.Parse(parts[2]);
                                MoveRelative(rx, ry);
                            }
                            break;

                        case "MD": // Mouse Down: MD left | right | middle
                            if (parts.Length >= 2)
                            {
                                string btn = parts[1].ToLowerInvariant();
                                if (btn == "left") SendMouse(MOUSEEVENTF_LEFTDOWN);
                                else if (btn == "right") SendMouse(MOUSEEVENTF_RIGHTDOWN);
                                else if (btn == "middle") SendMouse(MOUSEEVENTF_MIDDLEDOWN);
                            }
                            break;

                        case "MU": // Mouse Up: MU left | right | middle
                            if (parts.Length >= 2)
                            {
                                string btn = parts[1].ToLowerInvariant();
                                if (btn == "left") SendMouse(MOUSEEVENTF_LEFTUP);
                                else if (btn == "right") SendMouse(MOUSEEVENTF_RIGHTUP);
                                else if (btn == "middle") SendMouse(MOUSEEVENTF_MIDDLEUP);
                            }
                            break;

                        case "MC": // Mouse Click: MC left | right | middle
                            if (parts.Length >= 2)
                            {
                                string btn = parts[1].ToLowerInvariant();
                                if (btn == "left") { SendMouse(MOUSEEVENTF_LEFTDOWN); SendMouse(MOUSEEVENTF_LEFTUP); }
                                else if (btn == "right") { SendMouse(MOUSEEVENTF_RIGHTDOWN); SendMouse(MOUSEEVENTF_RIGHTUP); }
                                else if (btn == "middle") { SendMouse(MOUSEEVENTF_MIDDLEDOWN); SendMouse(MOUSEEVENTF_MIDDLEUP); }
                            }
                            break;

                        case "MDC": // Mouse Double Click
                            SendMouse(MOUSEEVENTF_LEFTDOWN); SendMouse(MOUSEEVENTF_LEFTUP);
                            Thread.Sleep(30);
                            SendMouse(MOUSEEVENTF_LEFTDOWN); SendMouse(MOUSEEVENTF_LEFTUP);
                            break;

                        case "MW": // Mouse Wheel: MW 120 (scroll up) or MW -120 (scroll down)
                            if (parts.Length >= 2)
                            {
                                int delta = int.Parse(parts[1]);
                                SendMouse(MOUSEEVENTF_WHEEL, 0, 0, (uint)delta);
                            }
                            break;

                        case "KD": // Key Down
                            if (parts.Length >= 2)
                            {
                                ushort vk = ushort.Parse(parts[1]);
                                SendKey(vk, false);
                            }
                            break;

                        case "KU": // Key Up
                            if (parts.Length >= 2)
                            {
                                ushort vk = ushort.Parse(parts[1]);
                                SendKey(vk, true);
                            }
                            break;

                        case "KP": // Key Press
                            if (parts.Length >= 2)
                            {
                                ushort vk = ushort.Parse(parts[1]);
                                SendKey(vk, false);
                                SendKey(vk, true);
                            }
                            break;

                        case "HOTKEY":
                            if (parts.Length >= 2)
                            {
                                string hk = parts[1].ToUpperInvariant();
                                if (hk == "WIN")
                                {
                                    SendKey(0x5B, false, true);
                                    SendKey(0x5B, true, true);
                                }
                                else if (hk == "WIN+D")
                                {
                                    SendKey(0x5B, false, true);
                                    SendKey(0x44, false);
                                    SendKey(0x44, true);
                                    SendKey(0x5B, true, true);
                                }
                                else if (hk == "ALT+TAB")
                                {
                                    SendKey(0x12, false);
                                    SendKey(0x09, false);
                                    SendKey(0x09, true);
                                    SendKey(0x12, true);
                                }
                                else if (hk == "CTRL+C")
                                {
                                    SendKey(0x11, false);
                                    SendKey(0x43, false);
                                    SendKey(0x43, true);
                                    SendKey(0x11, true);
                                }
                                else if (hk == "CTRL+V")
                                {
                                    SendKey(0x11, false);
                                    SendKey(0x56, false);
                                    SendKey(0x56, true);
                                    SendKey(0x11, true);
                                }
                                else if (hk == "CTRL+Z")
                                {
                                    SendKey(0x11, false);
                                    SendKey(0x5A, false);
                                    SendKey(0x5A, true);
                                    SendKey(0x11, true);
                                }
                                else if (hk == "ESC")
                                {
                                    SendKey(0x1B, false);
                                    SendKey(0x1B, true);
                                }
                            }
                            break;

                        case "PWR":
                            if (parts.Length >= 2)
                            {
                                string act = parts[1].ToLowerInvariant();
                                if (act == "lock")
                                {
                                    LockWorkStation();
                                }
                                else if (act == "sleep")
                                {
                                    SetSuspendState(false, true, false);
                                }
                                else if (act == "restart")
                                {
                                    Process.Start("shutdown.exe", "/r /t 5 /c \"Restart initiated from PocketDesk Remote\"");
                                }
                                else if (act == "cancel_shutdown")
                                {
                                    Process.Start("shutdown.exe", "/a");
                                }
                            }
                            break;

                        case "GETCUR":
                            POINT pt;
                            if (GetCursorPos(out pt))
                            {
                                Console.WriteLine("CUR " + pt.x + " " + pt.y);
                                Console.Out.Flush();
                            }
                            break;

                        case "SCREEN":
                            UpdateScreenSize();
                            Console.WriteLine("SCREEN " + screenWidth + " " + screenHeight);
                            Console.Out.Flush();
                            break;

                        case "PING":
                            Console.WriteLine("PONG");
                            Console.Out.Flush();
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("ERROR: " + ex.Message);
                }
            }
        }
    }
}
