# Terminal

`http://<host>:6080/tty/` is a shell as `VNC_USER` in the browser. It uses
the same login and session as the desktop and the [files page](downloads.md),
and doesn't need the desktop to be open. The page draws it with
[ghostty-web](https://github.com/coder/ghostty-web), Ghostty's terminal
emulator compiled to WebAssembly.

- **tmux:** the shell runs inside a tmux session called `web`. Closing the
  tab leaves it running, and the next tab picks it up where it was. Every tab
  shows the same session. Typing `exit` in the last window ends it, and the
  next tab starts a fresh one. With
  [`WEB_TTY_COMMAND`](environment.md#web_tty_command), each tab runs that command
  instead, without tmux.
- **Mouse:** the wheel scrolls tmux's history. Dragging selects text in tmux;
  hold Shift to select with the page instead. ghostty-web doesn't send the
  mouse to programs itself, so the page does (clicks, drags and the wheel,
  in the encodings tmux asks for).
- **Links:** Ctrl+click (⌘+click on a Mac) opens a web address shown in
  the terminal in a new tab, even while tmux has the mouse. Only `http`,
  `https` and `ftp` addresses open, so a program can't show a link that
  runs a script on the site.
- **Search:** the magnifying glass in the bar at the top, or
  Ctrl+Shift+F, opens out in place into a search box (on a phone, across the bar's second
  row). Enter finds the text in tmux's history, from the
  newest output back, and again for older matches; Shift+Enter goes to
  newer ones, and **↑** and **↓** do the same. tmux marks the match and
  shows how many there are at the top right. Esc (or **✕**) folds the box
  back into the button and leaves tmux's copy mode. It searches the window shown, and every tab on the
  terminal sees the same search, since they share the tmux session. On a
  touch screen, **Find** in the strip of keys opens it.
- **Notifications:** a bell, or a program's notification (OSC 9, or
  OSC 777 `notify`), while the terminal's tab isn't in front marks its
  title with 🔔 until you come back. The bell icon in the bar also shows
  them as browser notifications (it asks the browser's permission the
  first time; HTTPS or `localhost` only). To hear when a long command
  finishes, end it with `notify`, as in `make; notify built` (a message
  of up to 500 characters; "Done" by default), or with `tput bel`.
  Bells notify at most every 5 seconds. tmux passes notifications on only
  wrapped for its passthrough, which `/etc/tmux.conf` turns on and
  `notify` does.
- **Clipboard:** text copied in tmux, or sent with an OSC 52 escape
  sequence (as `~/.local/bin/ssh-yank.sh` does), goes to your browser's
  clipboard, up to 1 MB at a time. ghostty-web doesn't handle OSC 52, so the
  page picks it out of the output itself. Browsers only allow this over HTTPS
  or on `localhost`.
  Programs can't read your clipboard: requests for its contents get nothing
  back. Since anything shown in the terminal can copy, a file being shown
  or a remote host included, the page says so each time, with the start of
  what was copied, so a command slipped onto your clipboard doesn't go
  unnoticed.
- **Font:** the terminal uses DejaVu Sans Mono if your computer has it,
  otherwise your browser's monospace font. A small Powerline symbols font is
  served with the page for the arrows in tmux's status line. **Ctrl +** and
  **Ctrl −** make the text bigger and smaller (instead of zooming the page),
  and **Ctrl 0** puts it back to 14 px; the size is remembered in this
  browser.
- **Touch screens:** on a phone or tablet, a strip below the terminal has
  the keys its on-screen keyboard lacks: **Esc**, **Tab**, **Ctrl** and
  **Alt** (which apply to the next key typed, so **Ctrl** then **c** is
  Ctrl+C), the arrows, `|`, `~`, `/`, `-`, and **A−** and **A+** for the
  text size, and **Find** for searching. It scrolls sideways if it doesn't
  fit.
- **Dropped files:** files and folders dropped on the terminal are
  uploaded into `~/Downloads`, as on the [files page](downloads.md), and once
  they're done, their paths (`~/Downloads/report.pdf`, quoted if the shell
  needs it) are typed at the cursor, ready for a command such as `unzip`.
  They're pasted as text is, so the shell doesn't run the line.
- **Desktop programs:** `DISPLAY` points at the desktop, so a graphical
  program started from the terminal opens there.
- **Limits:** up to 5 terminals at once per login. A paste is at most
  1 MiB. Logging out, or the
  [session](encryption.md#sessions) ending, closes open terminals at once. The tmux
  session keeps running.
- **Settings:** `/etc/tmux.conf` turns on the mouse and 24-bit colour. A
  `~/.tmux.conf` in the home directory is read after it. A new home starts
  with the one in `skel/`, along with the theme files it loads from
  `~/.config/tmux/` and `~/.local/bin/ssh-yank.sh`. Edit or delete them in
  the home directory; an existing home never gets them.
