# Downloads

Files that Chromium saves on the desktop go to `~/Downloads`. They can be
downloaded at `http://<host>:6080/fs/`:

- **Login:** the page asks for the same credentials as the desktop (TOTP
  code, or password + code when `VNC_PASSWORD` is set), unless you're
  already logged in to the desktop or the [terminal](terminal.md) in this
  browser. One login covers all three (see [Sessions](encryption.md#sessions)), and
  logging out of any of them logs out of all.
- **In the page:** the page lists, fetches, uploads, creates empty
  files and folders, renames and deletes files through the
  [encrypted tunnel](encryption.md), so it needs JavaScript. For someone
  else, or for `wget` and `curl`, make a [share link](#share-links); to
  have someone else send you files, an [upload link](#upload-links).
  **Fetch from URL…** has the server download a file from the web itself
  (see [Fetching from a URL](#fetching-from-a-url)).
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
  Source code, configuration and markup are shown in colour, in light or
  dark as the browser is set, by
  [highlight.js](https://highlightjs.org/): Python, JavaScript and
  TypeScript, Go, Rust, C and C++, Java, Kotlin, Swift, C#, Scala, Ruby,
  PHP, Perl, Lua, shell scripts, PowerShell and batch files, SQL, HTML and
  XML, CSS and SCSS, JSON, YAML, TOML and INI, Markdown, LaTeX, diffs,
  Makefiles, Dockerfiles and `nginx.conf`, chosen by the name, never
  guessed. Text over 512 KB is shown plain, as colouring it would be slow.
  Coloured or not, it's only ever text: a web page's source can't run.
  The whole file is fetched first, so previews are for pictures up to
  50 MB and text up to 2 MB; bigger ones, and every other kind, download
  when clicked, except binaries (`.bin`, `.dll`, `.exe` and `.so`, or a
  versioned `.so` such as `libc.so.6`), which open in hex whatever their
  size. Any file can still be previewed from its row's menu
  (**Preview**): one too big for its own preview, or for text, is shown in
  hex, its first 1 MB fetched and the rest read as you move through it,
  however big it is. Audio and video, including MKV (`.mkv`), stream in ranges
  over HTTPS (or localhost), without the 200 MB preview limit. MP3, M4A/AAC,
  Ogg/Opus, WAV and FLAC audio use the same range transport. The browser fetches only
  what it needs for metadata, playback and seeking, through the encrypted
  tunnel; closing the preview cancels its active reads. If service workers
  are unavailable, audio and video up to 200 MB use the buffered fallback instead.
  Playback depends on the browser supporting the container and codecs; MKV
  files are streamed as Matroska without server-side transcoding. Unsupported
  media files show a message offering download. In the preview, **⤢** (right of **✕**) makes it fill the browser's
  window, and **⤡** puts it back in a box; it's remembered in your browser.
  **✎**
  edits a text file (or a book's details), and **⤓** downloads the file
  through the encrypted tunnel, as the files page does. Its menu, **▾**,
  also has **⇩ Direct Download** (when share links are on): the file comes
  straight over HTTPS, as any download does, not end to end. It's fetched
  by a link made for that one download, which is counted as it's made,
  and removed once the file has all come. What a browser can play varies: MP4,
  WebM, MP3 and the like play everywhere, others may not.
- **Pictures** are fitted to the window (never enlarged), over a
  checkerboard where they can be seen through, with what they are above:
  `1920×1080 · JPEG · 2.1 MB`, "animated" for a GIF, APNG or WebP that
  moves, and what metadata it has (`EXIF, XMP`). Phone photos stand as their EXIF orientation says.
  - **Zoom:** the mouse wheel (or a trackpad's pinch) zooms at the
    pointer, as do the **+** and **−** buttons (and + and − keys); drag to
    move about a picture bigger than the window. **Fit** (0) fits it again,
    **100%** (1) shows a pixel for a pixel, and a double-click goes between
    the two.
  - **Editing** a picture that doesn't move (**✎**): turn it left or right
    (L, R), flip it (H, V), crop it (C: drag over what to keep, then
    **Apply**, or Enter; Escape stops cropping), or resize it (**Resize…**, S:
    a width and height, kept in proportion, or a percentage). **Undo**
    (Ctrl+Z) takes back the last change. While cropping, the wand crops to
    an object: turn it on, then click the object or drag a box round it.
    The glyph beside it crops to every object magic select finds. Crop and resize replace the normal
    editing tools in the main toolbar with **Apply** and **Cancel**; resize
    also shows width, height and percentage. Other editing tools return after
    you apply or cancel. Each change is made again from the
    picture as it was, so nothing is lost by changes undone.
  - The **Remove background** glyph starts a live preview
    using U2NetP, running locally in your browser. The first use loads the bundled model
    and runtime from TabTop. **Threshold** removes more at higher values;
    **Edge softness** blends the cutoff (zero makes a hard edge);
    **Shrink / grow** contracts or expands the foreground, as a percentage
    of the picture size. The main image toolbar replaces the regular editing
    controls with background-removal tools; **Adjustments…** opens the settings
    on request. Hints appear in a small row below the toolbar. It starts
    with **Select area** (Rectangle) chosen but no area drawn, which means
    the whole image; drag a rectangle and only pixels inside it change, while
    U2NetP still analyzes the whole image. **Whole image** removes that limit.
    **Erase** paints transparency; **Restore** paints back the original pixels,
    including their original transparency. Both brushes stay inside the
    selected area, if any. The small arrow next to **Erase** opens the brush
    size selector, hidden by default. The small arrow beside **Select area**
    chooses **Rectangle** or **Circle** (drag from the centre to the edge).
    Removal stays inside that selection. **Erase** and **Restore** paint with
    the brush. The bucket
    glyph fills a closed freehand outline: draw it with **Erase**, choose
    **Flood fill**, then click inside. Open outlines leave the mask unchanged.
    **Object** (magic select), the third choice under the arrow beside
    **Select area**, finds objects for you: click one, or drag a box round
    it, to remove it from the cutout; Shift-click (or Shift-drag) one to add
    it back. Each click edits the cutout as it is, in turn. **Keep all
    objects**, beside it, keeps only the objects it finds, in place of the
    cutout; click any of them to remove it. The first time
    it's chosen it takes a few seconds to analyse the picture.
    The **Undo** glyph, labelled underneath, takes back the last stroke, fill or object.
    **Pan** lets you move around a zoomed picture. **Adjustments…** reopens the sliders while working on the image.
    **Reset** clears the selection and brush strokes and restores the original
    soft mask. Adjustments reuse the prediction within the active pass.
    **Apply** commits the preview; reopening background removal starts a new
    pass on the current image and preserves earlier removals, including after
    a crop or rotation. You can apply several passes before saving.
    **Cancel**, Escape or clicking outside the image, toolbar and settings
    discards it. **Undo** restores the previous applied edit. Results vary
    with the picture; fine hair and busy backgrounds can need brush work.
    For a JPEG, the tool
    selects a PNG copy so transparency is preserved. Choose PNG or WebP
    when saving a transparent result.
  - The **Inpaint** glyph removes a logo or object by filling the marked area
    with MI-GAN. Its controls replace the regular editing tools in the main
    image toolbar until you apply or cancel; zoom remains available. Save
    options return when you leave the tool. It starts with **Select area** (Rectangle): drag a rectangle, or choose **Paint mask**
    to brush over it; yellow shows the mask. The arrow beside **Paint mask**
    opens the brush size selector, hidden by default. The small arrow beside
    **Select area** chooses **Rectangle** or **Circle**; circles drag from
    their centre to their edge. The main Select area glyph uses that shape. To fill a freehand region, draw a closed
    outline with the brush, choose the bucket glyph, and click inside.
    Open outlines leave the mask unchanged. **Object** (magic select), the
    third choice under the arrow beside **Select area**, finds an object for
    you: click it to mark it, or drag a box round it; Shift-click an object
    to take it out of the mask. **Mark all objects**, shown beside it, marks
    every object it finds at once. The first time it's
    chosen, it takes a few seconds to analyse the picture; each click after
    that is quick. Rectangles can start outside
    the picture and are clipped to its edges; endpoints near an edge snap to
    it, including when the image is fitted or zoomed. The **Mask entire image** glyph
    (Ctrl+A or ⌘A while inpainting) covers every pixel; use **Subtract mask**
    to keep areas for context. **Subtract mask** protects parts
    of that area, the **Undo** glyph removes the last mark or fill, and **Clear mask**
    starts over. Use **Pan** and the zoom controls to work on details.
    Press **Inpaint** to generate a preview, then **Apply** to keep it.
    Editing the mask discards the preview so you can try again. **Cancel**
    or Escape leaves the image unchanged; **Undo** takes back an applied repair.
    The model and runtime load from TabTop on first use and run locally in
    the browser. Only masked RGB pixels change; existing transparency stays
    intact. Small repairs with surrounding context usually work best. A repair
    crop, including context, may contain at most 16 megapixels; it is sampled
    to at most 1024 pixels on its longest side before the model processes it.
  - **Saving:** the **Save options** glyph and its attached dropdown arrow open
    format, quality and metadata controls in a popover, with a description of
    what Save will do. They are hidden by default; click again, click outside,
    or press Escape to close them.
    A JPEG, PNG or WebP is written over the file in its own format
    (JPEG and WebP at the **Quality** chosen, 92% at first: lower makes it
    smaller), unless the file has changed since it was opened. **Keep
    metadata** (when it has any: EXIF, XMP, IPTC, comments, text) keeps it,
    for a JPEG or PNG, said to stand upright, as its pixels now do, and
    giving its new size; but not the thumbnails and previews it may hold
    of the picture as it was (EXIF's thumbnail, a camera's maker's note,
    Photoshop's thumbnail, a picture in XMP), which would show what was
    cropped away, nor EXIF it can't read well enough to be sure of that.
    A WebP's is kept only if it isn't written again. Unticked, with nothing else
    changed, Save removes the metadata losslessly, the picture's own bytes
    as they were (and, for a photo turned by its EXIF, that alone kept, so
    it still stands as it did). Choosing another format saves a copy beside
    it (`photo.png` as `photo.jpg`, or under a free name), without
    metadata, and leaves it as it is; that's how a GIF, AVIF, BMP or ICO
    picture is converted, as those can't be written over. **Done** asks
    before discarding changes not saved. Pictures of more than 100
    megapixels, animated ones, and SVG aren't editable here.
- **ZIP archives** (`.zip`) show a searchable, collapsible folder tree with
  entry type, original and packed sizes, modification times, and encrypted
  entry markers. **Show more** adds rows after the first 500. Only directory
  metadata is read until extraction or a contents download is requested. Beside
  each file, the download glyph sends it through the encrypted tunnel without
  writing into Downloads, and the extract glyph unpacks it into a new folder
  beside the ZIP. Folders expand and collapse with **+** / **−**; ticking a
  folder selects or clears every eligible file under it. Tick files (or
  folders) and choose **Download selected** or **Extract selected** for
  several at once (one file downloads as itself; several as a zip). The
  header checkbox selects eligible files in the rows shown. The action bar
  keeps selected count and size visible, notes selections hidden by filtering
  or paging, and offers **Clear selection**. After extraction, **Open folder**
  opens the result. Existing folders are never overwritten.
  Each extraction or contents download allows up to 1,000 files and 512 MiB.
  Encrypted files, symlinks, unsupported compression, and unsafe paths cannot
  be extracted or downloaded from the listing. ZIP64 sizes are preserved, and
  filenames support UTF-8, CP437 and validated Unicode Path metadata. Listings
  are limited to 10,000 entries and 4 MB of directory metadata; split archives
  aren't supported. The preview's main **Download** still saves the original
  ZIP.
- **PDFs** are shown by [pdf.js](https://mozilla.github.io/pdf.js/), a page
  at a time as you scroll to it, initially fitted to the width. The
  **Zoom out** and **Zoom in** magnifier glyphs adjust the zoom; the
  **Fit width** icon fills the preview's width. The adjacent
  **Fit page** icon fits the whole page within the available window,
  including after resizing. The rectangle marked **100%** uses a fixed
  scale that stays the same when the window is resized. The page you're on
  is shown above: click it, type a
  page's number and press Enter to go there. Links in a page work:
  to the web through the URL confirmation lightbox, within the PDF to the page. **Only what's shown
  is fetched:** the preview starts with the file's first 64 KB and asks
  for the parts pdf.js needs as it needs them, through the encrypted
  tunnel, so a 100 MB PDF of scans can show its first page after a few
  hundred KB, at any size. If the file changes while it's open, the
  preview says so rather than mixing the two. Text can be selected and
  copied. **Find** (or Ctrl F) looks through every page, shows how many
  matches there are, and highlights them; ↑, ↓ or Enter go from one to
  the next. pdf.js reads a page's text only along with its pictures, so
  finding fetches as much of the file as scrolling through it would: in a
  PDF of scans or photos, nearly all of it. So it stops to ask before
  going on (**Keep looking**) once it has fetched 32 MB, or when the first
  8 pages have no text at all, as in a scan without recognised text. Not
  yet: printing (**⤓** downloads the file). Scripts in a PDF never
  run.
  The **Edit or export pages as images** glyph opens a batch editor. Enter page
  ranges such as `1-3, 5`, choose a resolution, and tick the pages to process.
  Thumbnails let you open any page for the regular crop, resize, inpainting,
  and background-removal tools. Draw a mask or configure background removal,
  then choose **Apply current tool to selected** to reuse it across those pages;
  mask coordinates scale with each page's dimensions. Activate **Remove
  background** on a page and use **Apply current tool to selected** to reuse
  its settings across the checked pages. **Repeat last tool** reuses the last
  batch operation. The maximize/restore glyph fills the window or restores the
  editor's size. Export format, quality and **Export selected** sit beside the
  page actions in the top toolbar.
  **Keep page** retains individual refinements in the session; switching pages
  also keeps applied edits. Apply or cancel an active tool before switching.
  You can apply several passes before exporting. **Cancel processing** keeps
  completed pages; **Undo batch** restores the state before the latest batch.
  Failed pages are marked for review and don't stop the other pages.
  **Export selected** downloads PNG, JPEG or WebP images in a ZIP, or a new PDF
  made from image pages, in source page order. JPEG and PDF flatten transparency
  onto white; the new PDF has no selectable text or original links. The source
  PDF is never overwritten. A batch allows up to 200 pages, 16 megapixels per
  page and 256 MiB of edited images or exported image data. Export copies before
  leaving the session to retain your work.
- **EPUB books** (`.epub`) are shown a chapter at a time, set for
  reading, light or dark as your browser is: **☰** lists the contents,
  **‹** and **›** (or ← and →) go to the previous and next chapter (as
  does a bar at the foot of the preview, at the end of a chapter), and
  **A−** and **A+** change the text size. Links within the book go to their
  place in it. **Only what's read is fetched:** tabtopd opens the book and
  sends its contents, then each chapter as you go to it, and its pictures
  after its text. Pictures can be anywhere in the book, or in the chapter
  itself as `data:` URIs (GIF, JPEG, PNG, SVG or WebP). Pictures outside
  the book, or on the web, aren't shown. The preview remembers, in your browser, where you were in
  each book, and opens it there next time. tabtopd cleans each chapter as
  it does Markdown, and reads books in a separate process with a time
  limit. So the book's scripts never run, and its styles, fonts, forms,
  inline SVG and MathML are left out. Most books read well like that, but
  books laid out by the page (comics, picture books) depend on their
  styles, so they'll look wrong; the preview says so. Books with DRM can't
  be read here, and say so.

  **Edit** changes a book's title, its author and its cover. The author
  is the book's first; any others stay as they are, and an empty author
  removes it. **Rebuild TOC** remakes the contents list from each
  chapter's headings (`h1`–`h3`) that have usable IDs. Chapters without
  anchored headings get one entry from their filename. Chapter files stay
  unchanged: written as EPUB 3's nav, and as the NCX too when the book
  already has one. Other nav sections (landmarks, page-list) are left as
  they are. If the book already has a contents list, it asks before
  replacing it.
  - **Choosing it:** **From Downloads…** picks a picture in Downloads,
    starting in the book's folder, and **From EPUB Content…** one already
    in the book. Clicking a picture in either list shows it; **Select**
    takes it. A picture from your computer can be dropped on the dialog,
    pasted into it, or chosen by clicking the cover; it isn't uploaded into
    the folder, as one dropped on the page is.
  - **A picture from the book** becomes the cover where it is: nothing is
    added or copied.
  - **Any other picture** is added to the book as `images/cover.jpg` or
    `images/cover.png`, beside its package file (`OEBPS/images/` in most
    books; `cover-2.jpg` and so on if the name is taken). Your browser
    makes it at most 3000 pixels on its longer side. A JPEG or PNG keeps
    its type; another photo (WebP, AVIF, BMP) becomes a JPEG, and a GIF or
    SVG a PNG.
  - **The old cover** isn't written over. It stays in the book, no longer
    marked as the cover, unless it's removed (below). A book has one cover
    after: if it marked more than one picture as its cover, only the new
    one is marked.
  - **Cover pages:** a page with one picture that the book marks as its
    cover page (its guide's `type="cover"`, or `epub:type="cover"` in the
    page), or, if its picture is the cover, that has at most 20 characters
    of text. A chapter that shows the cover beside its text isn't one, nor
    is a page that's only an illustration. When a picture only cover pages
    show is removed, they're made to show the cover instead.
  - **Removing the old cover:** when nothing in the book but its cover
    pages shows the old cover, **Remove the old cover from the book** is
    offered, ticked, and on **Save** the cover pages show the new cover and
    the old picture is removed.
  - **Removing pictures:** **Cleanup Pics…** (beside **Rebuild TOC**, at the
    foot of the dialog) lists the book's pictures, with their sizes and
    what uses them. Those nothing uses, or nothing but cover pages (a
    former cover a cover page was left showing, say), are ticked; **Done**,
    then **Save**, removes those ticked. A picture is used if a page, a
    stylesheet, the contents or the package file refers to it, or if its
    name appears anywhere in such a file (in a script, say): one kept that
    could have gone is better than a page broken. The cover, and pictures
    in use, can't be removed here; the save is refused if one would be.
  - **A book without a cover** is given one, named as EPUB 2 and EPUB 3
    readers look for it. A cover page isn't added, so it shows in library
    views rather than as the first page.
  - **What's kept:** everything else in the book is copied unchanged.
    Sort keys that went with the old title or author (`file-as`) are
    removed, since they'd be stale. The NCX's own title and author are
    left as they are (its contents list is rewritten only when **Rebuild
    TOC** is used).
  - **Saving:** the book is saved as a new copy, read back to check it,
    then put in place of the old one in one step, keeping its permissions.
    If anything goes wrong, or the book changed since you opened it, it's
    left as it was.
  - **Not possible here:** books with DRM, and books whose package file
    (the OPF) isn't UTF-8.
- **CSV and TSV** (`.csv`, `.tsv`) are shown as a table.
  **Edit** lets you change existing cells: double-click a cell or focus it
  and press Enter. Enter commits, Shift Enter adds a line, Escape cancels
  the cell edit, and Tab commits and moves to the next cell. **Save** (or
  Ctrl S) writes the file; **Done** leaves editing and asks before
  discarding unsaved changes. Sorting and filtering never change the
  records' saved order. Saves preserve the delimiter, BOM and record line
  endings, but normalize quoting and omit blank lines. A file changed
  elsewhere is refused rather than overwritten. Malformed quoting must
  be fixed in the raw text editor first. Header cells can be edited by
  unchecking **First row is headings**.
  - **Splitting:** fields in double quotes can hold the delimiter, line
    breaks and `""` for a quote. The delimiter is found from the file (or
    an Excel `sep=` first line), and **Split by** changes it: comma,
    semicolon, tab, pipe or space.
  - **Headings:** the first row is taken as headings unless it holds
    numbers; a checkbox changes that.
  - **Types:** a column is numbers if every cell with something in it is
    one, dates if every one is an ISO date (`2026-11-05`, perhaps with a
    time), else text.
  - **Sorting:** a heading, or its **⇅**, sorts ascending (↑), descending
    (↓), then back to the file's order. Numbers sort as numbers, exactly,
    and dates as dates; empty cells go last.
  - **Filtering:** **Filter rows** finds text in any column, or the one
    chosen. A heading's **▽** filters its column by value: numbers by
    **=**, **≠**, **≥**, **≤**, **<** or **>**, dates by **before**,
    **after** or **on** (a date without a time, by the day), text by
    **contains**, **starts with**, **ends with**, **does not contain**,
    **does not start with** or **does not end with**. A column can have
    several conditions (**Add condition**); all must match, so a number
    range is **≥** and **≤**. Filters on several columns all apply, and
    **Clear filters** takes them off. The top left corner says how many
    rows are shown.
  - **Statistics**, next to **First row is headings**, shows rows under the
    headings, of the rows shown (so as filtered), each one chosen: **Sum**,
    **Average**, **Median**, **Min**, **Max** and **Std Dev** (the sample's)
    for numbers, **Min** and **Max** for dates, and **Empty** and
    **Unique** for every column. All are off by default. What's chosen is remembered in your
    browser.
  - **Widths:** drag the handle at the right of a heading to make its
    column wider or narrower (or, focused, use ← and →); double-click it to
    fit the column to what's in it again.
  - **Large files:** rows are shown 1,000 at a time, and at most 500
    columns.
  - A quote that's never closed is pointed out by its line.
- **SQLite databases** (`.sqlite`, `.sqlite3`, `.db3`, and `.db` or any
  other file, if it starts with SQLite's header: a file only named as one
  is shown in hex) show their tables, read by SQLite on
  the server, so anything SQLite reads shows as it would: values on
  overflow pages, UTF-16 text, `WITHOUT ROWID` tables, views.
  - **Tables and views:** choose one; its row count (or "many", if
    counting would take too long) is beside it. **Schema** shows the SQL
    that made it, with its indexes and triggers.
  - **Rows** come 200 at a time as you scroll, up to 50,000. Click a
    column's name to sort by it (ascending, descending, then not): the
    server sorts, so it's of every row, not only those loaded. Drag the
    edge of a column's name to make it wider or narrower (or, focused, use
    ← and →); double-click it to fit the column again.
  - **Filters**, as the CSV table has, done by the server, so they're of
    every row: **▽** by a column's name filters by it, with one or more
    conditions that must all match, by the column's declared type
    (numbers: =, ≠, <, >, ≤, ≥, which text in the column never matches;
    dates, `YYYY-MM-DD` with a time if you like: before, on, after, of
    dates kept as text, Julian days, or Unix time in seconds or
    milliseconds, as apps keep them; text,
    ignoring case: contains, starts with, ends with, or not). **Filter
    rows** shows only rows with what's typed in them, in any column or
    the one chosen. The count says how many match, of how many;
    **Clear filters** shows them all again. (Text is matched ignoring the
    case of A to Z only, as SQLite does.)
  - **Values:** NULL is shown as such; integers exactly, even past what
    JavaScript can count; text past 2,000 characters is cut short (its
    size is in its tooltip); a blob shows its size and first 32 bytes.
  - **The bytes:** the binary view switch shows the file in hex, with the
    `sqlite3` structure decoder; switch back for its tables.
  - **Read-only:** the database is opened read-only and as unchanging, in
    a separate process with time and memory limits: nothing is written
    beside it, no lock is taken, and a slow query (a count, a view, a sort
    on an unindexed column) is stopped. So changes still in a `-wal` file
    beside it aren't seen; the preview says when there is one.
  - A file named as a database that doesn't start as one, or that SQLite
    can't read (damaged, or encrypted), is shown in hex.
- **JSON** (`.json`; `.jsonl` and `.ndjson` as a value per line) is shown as
  a tree.
  - **Folding:** the first two levels start open; long lists show 500
    items at a time, and **Fold all** closes everything.
  - **Finding:** searches keys and values, unfolding the way to each
    match.
  - **Numbers:** they're shown exactly as written, even integers too big
    for JavaScript, which `JSON.parse` would round.
  - **Not JSON:** a file that isn't JSON (comments, say) is shown as text,
    saying what's wrong and where.
  - **Editing:** checks it's still JSON as you type. **Format** lays it out,
    changing only whitespace, and Ctrl Z undoes it. Laid out to more than
    400 lines, it's put in at once rather than as typing (which browsers
    are slow at, with many lines): Ctrl Z (and Ctrl Shift Z or Ctrl Y)
    then undoes (and redoes) the Format alone, and edits from before it
    may not undo past it. Saving a file that was JSON and no longer is
    asks first.
- **Raw:** **▦ | ≡** (Table, Raw) and **{ } | ≡** (Tree, Raw) switch between
  those views and the file as it is, as **¶ | ≡** (Rendered, Source) does
  for Markdown. The choice is remembered in your browser.
- **Back:** HTML, Markdown, EPUB and PDF previews show a Back arrow after following
  an internal link. It restores the previous reading position, across Markdown
  files and EPUB chapters, and the PDF zoom setting. Up to 100 locations are
  kept until the preview closes or its previous/next file controls select
  another file. Scrolling adds no history.
- **Light or dark:** rendered HTML, Markdown and books have **◐** in the preview,
  which goes from following your system (◐) to light (☀) to dark (☾). The
  choice is remembered in your browser.
- **External resources:** a glyph immediately before Download appears for
  embedded web resources. Its glyph shows the current mode; open the dropdown
  to select **No external** (default), **Proxy** (through the E2E tunnel), or
  **Direct** (through your browser). Each newly
  opened file starts blocked. Proxy follows `WEB_FETCH` address restrictions.
  Clickable links retain their confirmation dialog and do not show the glyph.
- **HTML** (`.html`, `.htm`) has **Rendered / Source** views. Rendered HTML
  shows document text, tables, basic inline formatting, and local images.
  It removes scripts, event handlers, forms, embedded pages, SVG/MathML and
  automatic redirects. Stylesheets and inline CSS are parsed and restricted
  to document formatting in Proxy mode; imports, font files and CSS background
  images also use the E2E tunnel. Direct mode uses native browser stylesheet
  loading. Local image limits match Markdown. Ordinary external audio/video
  sources have native controls and stream through bounded byte ranges in Proxy
  mode; this requires HTTPS (or localhost), service worker support, and an
  upstream server supporting byte ranges. HLS/DASH playlists and embedded
  scripted players are not handled. None of these enable document scripts.
  Internal links support **Back** history, and web links show the URL confirmation
  lightbox. The view choice is remembered separately from Markdown.
  Saved web pages need their companion resource folder (for example,
  `Article_files/`) beside the HTML file to display locally saved images.
  Proxy mode cannot reconstruct a missing local asset from its filename.
  Links declared in `data-href` or `data-ga-content-link` are restored without
  running scripts when their destination can be resolved safely.
- **Markdown** (`.md`, `.markdown`) is shown rendered, as GitHub does:
  headings, lists and task lists, tables, links, pictures, code blocks in
  colour, math and [Mermaid](https://mermaid.js.org/) diagrams.
  **Source** in the preview's bar shows it as written (in colour), and
  **Rendered** goes back; the choice is remembered in this browser.
  - **Math** is written as `$…$` within a line, and `$$…$$` or a
    ```` ```math ```` block on its own, in TeX, drawn by
    [KaTeX](https://katex.org/). A `$` followed by a space, or before a
    digit, is a dollar sign, so prices stay prices; `\$` always is one.
  - **Diagrams** are ```` ```mermaid ```` blocks. One that can't be drawn
    says why, above its source.
  - **Pictures** beside the file, or elsewhere in `~/Downloads` by a
    relative path (`![](img/plot.png)`), are fetched through the tunnel,
    up to 100 per render, 20 MB each and 64 MiB in total. Repeated pictures
    count toward the render limits too. Pictures from the web are blocked
    by default; the resource glyph enables Proxy or Direct. A note says
    which.
  - **Links** to the web show a lightbox with the destination URL: **Copy URL**,
    **Open in browser** (a new tab), or **Cancel**. PDF and EPUB web links use
    the same prompt. Links within the document
    scroll to their heading. A link to another file in `~/Downloads`, by
    a relative path (`[setup](docs/setup.md#install)`), opens it in the
    same preview, at that heading, with a **Back** arrow to return; a file that
    isn't previewed downloads instead.
  - **Front matter**, the `---` block of YAML many notes start with, is
    folded away above the text, rather than shown as stray lines. A
    document with three headings or more gets a **Contents** list, folded
    away at the top too.
  - **HTML** written in the file isn't shown, not even its text.
  - **It can't reach the site.** It's rendered by the gateway, cleaned to
    plain formatting, and shown in a sandboxed frame with an origin of its
    own, where KaTeX, Mermaid and the colours run: nothing in it can read
    your session or the page around it, or load anything but pictures
    handed to it.
- **Editing:** **Edit** in the preview of a text file (UTF-8, up to
  2 MB) opens it in a plain editor; for Markdown, it's rendered beside it
  as you type. The top bar shows the cursor’s line and column. Click it or press
  Ctrl G (⌘ G) to open **Go to line**. Enter a line or `line:column`
  (both start at 1); Enter jumps there and Escape cancels. Columns past
  the end of a line move to its end. **Save** (or Ctrl S, ⌘ S) writes it back through the
  encrypted tunnel, replacing the file in one step and keeping its
  permissions (a script stays one that runs), its line endings (Windows'
  `\r\n` stay so) and any byte order mark. If the file has changed since
  you opened it (in the terminal, say, or another tab), it isn't saved
  over: the editor says so and keeps your text, to copy or save as
  another file. **Done**, closing the preview, and the arrows ask first
  if there are changes not saved. Tab types a tab.
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
  most), unless **Clean up…** in **Share links** deletes it
  sooner (see [Cleaning up](#cleaning-up)). When the connection drops, the upload says it's reconnecting and
  carries on from where it stopped by itself, once the gateway can be
  reached again; it fails if it gets nowhere for 15 minutes, or the
  server says why it stopped (a full disk, say). **Retry** on a failed one
  also carries on from where it stopped. Either needs the file unchanged
  and the page not reloaded. Stopping the container deletes kept uploads,
  since a restart can't resume them. The room kept
  ones take counts as free, and an upload that needs it deletes them, the
  oldest first, on the upload destination's filesystem. Space shown for a
  folder comes from its filesystem, including separately mounted subfolders;
  partial uploads on another filesystem aren't counted or reclaimed for it.
  Any left by a
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
- **New folders, new files and renaming:** **New folder…** makes a folder
  in the one shown (as `name (1)` if the name is taken), and **New
  file…** makes an empty file there (as `name (1).ext` if taken), starting
  from `Untitled.txt` so you can keep the extension or change it to
  `.md`, `.csv`, `.json` or another name. **Rename…** in a row's menu
  renames it; for a file, only the part before the extension starts
  selected. A rename never replaces anything: if the new name is taken, it
  fails and says so. Renaming a symlink renames the link. A new name, for
  a folder, a file, a rename or an upload, can't contain control
  characters, such as a line break; a file already named with one can
  still be renamed and deleted.
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
  plain text, which is how web pages and SVGs' source are shown; never
  in a frame of the site (the browser's own PDF viewer would need one).
  Rendered HTML, Markdown, PDFs and EPUB books are the exceptions: each is
  shown in a sandboxed frame with an origin of its own, so what runs in it
  (KaTeX, Mermaid, pdf.js) can't reach the site or the page around it;
  it's given only the file, or the parts of it it asks for. HTML is rebuilt
  from allowed formatting elements, with active content removed.
- **Share links** are the one way to fetch a file without the page; see
  [Share links](#share-links).
- **Symlinks:** symlinks leading outside `~/Downloads` are hidden and can't
  be downloaded, zipped, uploaded into, renamed or deleted.
- **Big folders:** a folder lists at most 10,000 entries. With more, the
  page says so and shows 10,000 of them, in no particular order.

Restarting the container logs everyone out, and clears the failed-login
counts.

## Share links

A share link is a plain HTTPS address for a file or folder in
`~/Downloads`, for someone else to download, or for `wget` and `curl`, with
no login and no JavaScript. **Share…** in a file's or folder's **⋯** menu
makes one:

- **A label,** if you give one, such as "for Alice", is only for you: it
  shows in **Share links** and the activity log, never to
  someone using the link. **Change…** edits it.
- **The dialog remembers** the choices you made last in this browser
  (how long, how many), for Share… and Upload link… each.
- **How long, how often:** it lasts 1 hour, 1 day or 7 days, and allows
  any number of downloads, or 1, 5 or 10.
- **A page for browsers, the file for tools:** opened in a browser, a link
  shows a small page with the file's name and size and a **Download**
  button; only the button counts as a download. Chat apps and mail
  scanners that open links pasted into them, to preview or check them,
  usually ask for a page too, so they don't use a link up. `wget`, `curl`
  and other tools get the file straight away. (A scanner that asks the way
  `curl` does, or presses buttons, still uses a download.)
- **The address** is `https://<your site>/fs/<token>/<name>`, under
  [`WEB_BASE_PATH`](environment.md#web_base_path) if there is one. The
  token, 128 random bits, is the whole permission: anyone who has the link
  can use it, and nobody can guess one (addresses that ask for links that
  don't exist too often are refused for a while). The name at the end is
  only so `wget` saves the file under it.
- **A file** downloads as it is, never shown as a page, and resumes:
  `wget -c`, `curl -C -` and a browser carry on with a download cut off,
  and that doesn't count as another download (with a limit, only from an
  address that downloaded it already). The link works only for that file: once the
  file is changed, replaced, moved or renamed, it stops.
- **A folder** downloads as a `.zip` of what it holds then, files added
  since it was shared included, made as it goes, so it can't resume.
- **Direct Download** makes a link for one download within an hour, without
  asking, and shows it to copy, for `wget -c`, `curl -fLO -C -`, a browser
  or anything else that downloads.
- **Ending one:** a link ends when it expires, when it's revoked from
  **Share links** (which lists them all, with how often and from
  where each was downloaded), when its file changes, when the session that
  made it is ended with **End…**, and when you **Log out everywhere**,
  which revokes every link. Logging out normally leaves them, so a link
  you've sent keeps working. Revoking stops downloads going on too. A link
  that ends within a day says so in amber ("ends in 3 hours"). Tick
  several links and **Change N selected…** to give them a new end or
  label together (what each allows stays as it is), **Revoke N
  selected…** to revoke them together, or
  **Revoke N used up…** for those that have had all their downloads (or
  files). A link another session made marks **Sessions and Activity** in
  red.
- **Changing one:** **Change…** beside a link in **Share links** gives it a new end (1 hour, 1 day or 7 days from now, or as
  it was) and a new limit, at the same address, so there's nothing to send
  again. A link used up comes back to life given more downloads; one that
  has expired or been revoked can't. A limit can't go below what it's had
  already.
- **Shown again:** **Show link** beside a link in **Share links** shows it again, with **Copy link**, after the dialog that
  made it has closed. Each showing is in the activity log.
- **Kept across restarts** in `~/.config/tabtop/shares.json`, which holds
  each link's token's hash, and the token encrypted with a key kept apart,
  in `~/.config/tabtop/share-link.key`, so the shares file alone (in a
  backup, say) holds no link anyone can use. Someone who can read both
  files can use every link, as the desktop user can anyway. Links made
  before this was added, or after the key file is lost, still work, but
  can't be shown again. With `/home/<VNC_USER>`
  mounted, they last across replacing the container too.
- **Not end-to-end encrypted:** what a link serves is protected by HTTPS
  only, so a proxy that decrypts HTTPS on the way (see
  [Encryption](encryption.md)) sees the link and the file, and a reverse
  proxy's access log holds the link itself. The gateway's own log names
  the file and address, never the token.
  [`WEB_SHARE=0`](environment.md#web_share) turns links off altogether.

## Activity log

The **Sessions and Activity** button opens `fs/#sessions`, with active
sessions, **Recent logins**, and the activity log below them. It also
shows when this TabTop was built. The separate **Share links** button
opens `fs/#shares`, with share and upload links, followed by **Temporary
files** and its cleanup controls. Click the active tab's button again to
return to the folder you were viewing.

The log shows recent activity and can be filtered by kind, address or
words. **Show all** lists older entries, **Download** saves the whole log
as a TSV file, and **Clear…** asks before clearing it. Clearing leaves one
entry recording who cleared it. The log is kept across restarts.

## Upload links

An upload link lets someone without a login send you files: **Upload
link…** below a folder's list makes one for that folder.

- **How long, how much:** it lasts 1 hour, 1 day or 7 days, takes 1, 10
  or 100 files or any number, and up to 100 MB, 1 GB, 10 GB or 100 GB in
  all.
- **The address** is `https://<your site>/fs/<token>/`, the same
  kind of address as a share link. Opened in a browser, it shows a page to
  pick files with, which shows how far each upload has got (it works
  without JavaScript too). From a terminal, `curl -T report.pdf <link>`
  uploads `report.pdf`.
- **Carrying on:** the page sends each file in 8 MB pieces. If the
  connection is lost, it asks how far the file got and carries on from
  there, trying again for up to 15 minutes without getting anywhere; what
  came is kept for an hour after the last piece. `curl -T` sends a file
  whole, so one cut off has to be sent again. A file being sent takes its
  place in the link's limits (a file, and its whole size) from its first
  piece, so two people can't both use a link's last file.
- **What it can do:** put files into that one folder, and nothing else. A
  file never replaces one already there: it gets a free name instead,
  such as `report (1).pdf`. It can't make folders or hidden files, see
  what's in the folder, or download anything. Uploads show up in the
  files page as they're saved.
- **Behind a reverse proxy,** it has to let uploads through: nginx refuses
  request bodies over 1 MB unless told otherwise, too small even for the
  page's 8 MB pieces. Cloudflare's Free and Pro plans refuse bodies over
  100 MB, which only matters to `curl -T`. See
  [Reverse proxy](reverse-proxy.md).
- **Ending one,** keeping them across restarts, and the encryption are as
  for [share links](#share-links): **Share links** lists them,
  with how many files came and from where, **Change…** gives it more
  time, files or room, and **Revoke…** stops uploads going on too. A link stops working once its folder is moved, renamed or
  deleted. [`WEB_SHARE=0`](environment.md#web_share) turns upload links
  off with share links.

## Cleaning up

**Clean up…**, under **Temporary files** in **Share links**,
deletes what uploads and fetches leave behind: uploads from the page cut
off and kept an hour to carry on, uploads through upload links stopped
part way, and temporary files with nothing behind them, such as those a
crash or a forced stop left (which the next start would delete anyway).
It says how many, and how much space, and asks first. Uploads and
fetches going on aren't touched, nor a temporary file changed in the last
5 minutes. It's in the activity log.

## Fetching from a URL

**Fetch from URL…** below a folder's list has the server download a file
from the web into that folder, so a big file goes straight to the
container rather than through your browser and connection.

- **It's the server's:** closing the page doesn't stop it. A row in the
  transfers panel shows how it's going, with **Cancel**; the files page,
  opened again, shows the fetches still going. Up to 4 go at once.
- **Cut off,** it carries on where it stopped, if the server allows it,
  up to 5 times. One that gets nothing for a minute is cut off and tried
  again.
- **The name** is the one the server gives, else the last part of the
  address, and never replaces a file: a clash gets a free name, as uploads
  do.
- **Only the internet:** it doesn't fetch from the container's own
  addresses (`127.0.0.1`, `::1`, and its address on each of its
  networks, public or private), link-local ones (`169.254.x.x`, where
  cloud metadata services are) or private networks (10.x, 172.16-31.x,
  192.168.x and the like), checked on every connection, redirects
  included, so a link can't reach the VNC server, anything else in the
  container, the Docker host or a metadata service. With
  [`WEB_FETCH_PRIVATE=1`](environment.md#web_fetch-and-web_fetch_private)
  it fetches from private networks too, such as a NAS, and so from the
  Docker host's address on the container's network, which is private;
  the container's own addresses and link-local ones stay off limits. It
  uses no proxy.
- **Ending:** **End…** on the session that started a fetch, **Log out
  everywhere**, and stopping the container cancel it, deleting what it
  had. The gateway's log names the host it fetched from, never the rest of
  the address, which could hold a token.
  [`WEB_FETCH=0`](environment.md#web_fetch-and-web_fetch_private) turns fetching off.

The distinct Markdown, EPUB and HTML sanitizer policies and their security
boundaries are documented in [preview sanitizers](preview-security.md).

Closing a preview restores focus to its original file and keeps the row in
view. Preview navigation, editing, appearance and download controls are grouped
consistently. Failed previews retain **Retry preview** and **Download** actions;
buffered previews show byte progress while loading.

The file-selection bar stays visible while scrolling and shows the total size
of selected files. Folder contents are marked separately because their size
isn't known. The header checkbox selects all filtered files; selections hidden
by the filter remain counted until cleared.

Editing status appears beside **Save**. If saving fails, **Download my changes**
keeps a local copy of the current work, including text line endings and BOM.
Transfer rows show their destinations; active and failed transfers appear first,
with completed transfers available through **Show completed** while work continues.
