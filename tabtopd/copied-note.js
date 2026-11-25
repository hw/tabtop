// copiedNote is a note at the foot of the page (its id) that says, for a
// few seconds, that what's shown (what: "The desktop", "The terminal")
// copied text to this computer's clipboard, showing how it starts. It
// returns what says so, given the text.
export function copiedNote(id, what) {
    const note = Object.assign(document.createElement("div"), { id, hidden: true });
    note.setAttribute("role", "status");
    document.body.append(note);
    let timer = 0;
    return (text) => {
        const line = text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
        const start = line.length > 80 ? `${line.slice(0, 80)}…` : line;
        note.textContent = `${what} copied ${text.length} character${text.length === 1 ? "" : "s"} to your clipboard`
            + (start ? `: “${start}”` : ".");
        note.hidden = false;
        clearTimeout(timer);
        timer = setTimeout(() => (note.hidden = true), 5000);
    };
}
