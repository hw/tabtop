# Downloads

Files that Chromium saves on the desktop go to `~/Downloads`. They can be
downloaded at `http://<host>:6080/downloads/`:

- **Login:** the page asks for the same credentials as the desktop (TOTP
  code, or password + code when `VNC_PASSWORD` is set), unless you're
  already logged in to the desktop or the [terminal](terminal.md) in this
  browser. One login covers all three (see [Sessions](encryption.md#sessions)), and
  logging out of any of them logs out of all.
- **In the page only:** the page lists, fetches, uploads, renames and
  deletes files through the [encrypted tunnel](encryption.md), so it needs
  JavaScript, and files have no plain URLs to give to `curl` or `wget`.
- **Finding your way:** the line above the list shows the folder's path,
  as the terminal would (`~/Downloads/photos/2024`), each folder in it a
  link back up. The box above the list (or **/** from anywhere on
  the page) narrows it to names with what you type in them; **Select all**
  then picks only those shown. Click **Name**, **Size** or **Modified** to sort
  by it, and again to turn the order round; folders stay first, and the
  order is remembered in this browser. Times are shown as "Today 9:34",
  "Yesterday", a weekday or a date, in your browser's language and the
  container's time zone (`TZ`, UTC by default); hovering over one, or over
  a size, shows it exactly. Each row's
  **⋯** menu previews, downloads, renames, moves or deletes it, or copies
  its path (as `~/Downloads/a/b.txt`, quoted if the shell needs it) to
  paste into the terminal. Opened again, the page goes back to the folder
  it last showed, scrolled where it was, and going back to a folder seen
  earlier in the visit scrolls to where you were in it.
- **Up to date:** while the page is in view, the list updates itself as
  the folder changes: a download finishing on the desktop, a file written
  in the terminal, or a change from another tab shows within a second.
  What's typed in the filter box, ticked and focused stays as it was. A
  tab in the background holds nothing open and lists the folder again when
  it's shown.
- **The keyboard:** **↓** and **↑** move between rows (from anywhere on the
  page but a text box), **Enter** opens the one there, **Space** ticks it,
  **F2** renames it, **Delete** deletes it, and **Backspace** goes up a
  folder.
- **Previews:** clicking a picture, video, sound or text file shows it over
  the page instead of downloading it; **‹** and **›** (or the arrow keys)
  step through the others in the folder, as listed. Text covers common
  extensions (`.txt`, `.md`, `.log`, `.json`, `.csv`, source code and so
  on) and names without one; a file that turns out not to be text says so.
  The whole file is fetched first, so previews are for pictures up to
  50 MB, video and sound up to 200 MB, and text up to 2 MB; bigger ones,
  and every other kind, download when clicked. **Download** in the preview
  saves the copy it already has. What a browser can play varies: MP4,
  WebM, MP3 and the like play everywhere, others may not. PDFs download
  rather than open (see **Attachments only**).
- **Transfers:** downloads, uploads, zips and other changes show in a
  panel in the bottom corner, each with a progress bar while it goes and
  a **Cancel** button where it can be stopped, and a bar for how many are
  done. Those that went well go by themselves a minute after they finish
  (not while the pointer is over the panel); those that failed stay, and a
  failed download, zip or upload has **Retry**. An upload carries on
  from where it stopped (see **Uploads**); a download or zip starts again
  from the beginning, since the browser has dropped what it had. **Clear** removes the finished ones; **▾** folds the
  panel away.
  While any are going, the tab's title starts with how far they've got
  (`⇅ 45% · …`, or how many are going where sizes aren't known), so it
  shows in a tab in the background too.
- **From the desktop:** while the desktop is connected, when a file is
  saved directly into `~/Downloads`, by the desktop's Chromium (once its
  download is complete) or any other program, the desktop page shows a
  notice with its name and size and a
  **Download** button, which downloads it to your computer as the files
  page does. Files uploaded, renamed or moved from the pages aren't
  announced, nor are those saved into folders inside `~/Downloads`.
- **Saving:** over HTTPS or on `localhost`, a file streams into an ordinary
  browser download as it's decrypted, through a service worker the page
  registers, so it needs no more memory than a few chunks: the gateway only
  sends a few MiB ahead of what the download has taken. The browser writes
  it to a temporary file (`.crdownload`, `.part`) and renames it once it's
  complete; one that's cut off is marked failed, and no partial file is
  kept under the real name. Keep the files page open until it's done, since
  that page does the decrypting. Pausing a download for more than 30 s
  fails it. Over plain HTTP, browsers don't allow service workers, so the
  whole file is fetched first and then saved: Chrome keeps it in temporary
  files as it arrives, but other browsers may need as much free memory as
  the file is big.
- **Zips:** **Download as .zip** in a folder's menu downloads it with
  everything in it as one zip. Tick several files and folders with the
  checkboxes and **Download as .zip** downloads them together, named after
  the folder they're in. The gateway makes the zip as it sends it, so it
  needs no room on disk, but its size isn't known in advance: the download
  shows how much has arrived, not a percentage. Files already compressed
  (images, video, audio, archives) are stored as they are, and the rest
  compressed quickly. Symlinks to files are followed, those to folders
  aren't, and uploads still in progress are left out, as is anything more
  than 64 folders deep; the page says if anything couldn't be read. A zip that's cut off is marked failed, like a
  file. At most a few thousand items can be ticked for one zip (the request
  is limited to 1 MiB); a folder's own zip has no such limit.
- **Uploads:** pick files with **Upload files…**, or drop them on the
  page, to upload them into the folder it shows; while you drag them over
  it, the page says which folder that is. Files pasted on the page (a
  copied screenshot, say) upload the same way; a pasted picture is named
  for when it was pasted, as `Pasted 2026-11-01 09.34.12.png`. Files and
  folders dropped on the desktop's page or the [terminal](terminal.md) are
  uploaded into `~/Downloads` itself the same way, with a transfers panel
  there. If files
  have the names of files already in the folder, the page asks whether to
  replace those or keep both; keeping both, or a name taken while the
  upload goes, saves the new one as `name (1).ext`, `name (2).ext` and so
  on, with `name` cut short if the name would get too long. A folder is
  never replaced. Each file is written to a hidden temporary file
  (`.tabtop-upload-….part`) first, and only appears once it's complete
  and saved to disk. If the disk reports an error saving its folder
  too, the page says so next to the file; on a file system that can't
  save a folder on request at all, the file's own save is as far as it
  goes, without a warning. Each upload has a **Cancel** button while it's
  waiting or going; a cancelled one is deleted. One cut off any other way,
  as when the connection drops, is kept for an hour (the 16 most recent at
  most), and **Retry** carries on from where it stopped, as long as the
  file hasn't changed and the page hasn't been reloaded. The room kept
  ones take counts as free, and an upload that needs it deletes them, the
  oldest first. Any left by a
  crash, a restart or a forced stop are deleted when the container next
  starts (it spends at most 10 seconds looking, before serving anything),
  so don't share `~/Downloads` between two running containers. Below the
  list, the page shows how much room is left (`139.5 GB free of 745.1 GB`,
  in red under a twentieth). A file bigger than that is refused before any
  of it is sent, and so are several files, or a folder, that are more than
  that together; **Retry** on one of them then tries just that one.
- **Folder uploads:** drop a folder on the page, or pick one with
  **Upload a folder…** (in browsers that have it), to upload it with
  everything in it. It never merges into a folder already there: one whose
  name is taken is uploaded as `name (1)` and so on. Its files are uploaded
  one at a time like any other, and the page shows how many made it and
  lists any that failed. Empty folders inside a picked folder are left out,
  since browsers don't pass them on; dropped ones are kept. Cancelling a
  folder's upload stops it at once: the file being uploaded is deleted,
  and those uploaded before it are kept.
- **New folders and renaming:** **New folder…** makes a folder in the one
  shown (as `name (1)` if the name is taken), and **Rename…** in a row's
  menu renames it; for a file, only the part before the extension starts
  selected. A rename never replaces anything: if the new name is taken, it
  fails and says so. Renaming a symlink renames the link.
- **Moving:** drag a row onto a folder in the list, onto `../`, or onto a
  folder in the heading, to move it there; dragging a ticked row moves all
  those ticked. **Move to…** in a row's menu, or in the bar above the list
  for those ticked, asks for the folder by its path in `~/Downloads`
  (empty for `~/Downloads` itself). Like a rename, a move never replaces
  anything: if the folder has something of the same name, that one isn't
  moved, and the page says so. A folder can't be moved inside itself.
- **Deleting:** **Delete…** in a row's menu deletes it, after asking, and
  **Delete** in the bar above the list deletes everything ticked, after
  asking once. Deleting a folder deletes everything in it.
  Deleting is permanent: there's no trash. Deleting a symlink removes the
  link, not the file or folder it leads to, and a folder is deleted
  without following any symlinks in it. Files can't be changed from the
  web, only replaced by deleting and uploading again.
- **Attachments only:** files are always sent as downloads, never shown as
  pages, so an HTML file in `~/Downloads` can't run on the site. A preview
  shows a file in an element that can't run anything in it: a picture
  (SVGs too, whose scripts don't run there), a video or sound player, or
  plain text, which is how web pages and SVGs' source are shown. That's
  also why PDFs aren't previewed: the browser's PDF viewer would need a
  frame of the site.
- **Symlinks:** symlinks leading outside `~/Downloads` are hidden and can't
  be downloaded, zipped, uploaded into, renamed or deleted.
- **Big folders:** a folder lists at most 10,000 entries. With more, the
  page says so and shows 10,000 of them, in no particular order.

Restarting the container logs everyone out, and clears the failed-login
counts.
